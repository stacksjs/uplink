import type Stripe from 'stripe'
import type { PlanId } from './plans'
import { randomBytes } from 'node:crypto'
import { planById } from './plans'

/**
 * Licenses: what a purchase turns into, and whether it is still good.
 *
 * A license is issued once per completed checkout, keyed by the checkout
 * session, so issuing again (the thank-you page reloaded) returns the same one.
 * Whether it is still good comes from Stripe: a subscription's status and paid
 * period are re-read when the Mac app checks in, so a cancellation in the
 * customer portal, a failed renewal or a refund reaches the app without a
 * webhook. Lifetime is paid once and stays good.
 */

export interface LicenseRecord {
  key: string
  email: string | null
  plan: PlanId
  status: string
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  stripeCheckoutSessionId: string
  /** Epoch seconds. Null for lifetime. */
  currentPeriodEnd: number | null
  checkedAt: number | null
}

export interface LicenseStore {
  byKey: (key: string) => Promise<LicenseRecord | null>
  bySession: (sessionId: string) => Promise<LicenseRecord | null>
  create: (license: LicenseRecord) => Promise<void>
  update: (key: string, patch: Partial<LicenseRecord>) => Promise<void>
}

export interface LicenseStripe {
  checkoutSession: (id: string) => Promise<Stripe.Checkout.Session>
  subscription: (id: string) => Promise<Stripe.Subscription>
}

/** What the Mac app is told. */
export interface LicenseStanding {
  valid: boolean
  plan: PlanId
  status: string
  email: string | null
  /** ISO time the paid period ends, or null for lifetime. */
  expiresAt: string | null
  /** The period has been cancelled and will not renew. */
  endsAtPeriodEnd: boolean
}

/**
 * Subscription statuses that still unlock the app. `past_due` counts: Stripe
 * retries a failed renewal for weeks, and the portal is where it gets fixed.
 */
const GOOD = new Set(['active', 'trialing', 'past_due', 'lifetime'])

/** Check Stripe again at most this often per license, however often the app asks. */
export const RECHECK_SECONDS = 15 * 60

/** `UPLK-XXXX-XXXX-XXXX-XXXX`: 80 random bits in an alphabet with no 0/O or 1/I. */
export function generateLicenseKey(bytes: Uint8Array = randomBytes(10)): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    // Only the bits not yet written out are kept: `<<` works on 32 bits.
    value = ((value & ((1 << bits) - 1)) << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return `UPLK-${out.slice(0, 16).match(/.{4}/g)!.join('-')}`
}

/** A key as typed or pasted: case, spaces and a missing prefix forgiven. */
export function normalizeLicenseKey(input: unknown): string | null {
  if (typeof input !== 'string')
    return null
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^UPLK/, '')
  if (!/^[A-HJ-NP-Z2-9]{16}$/.test(compact))
    return null
  return `UPLK-${compact.match(/.{4}/g)!.join('-')}`
}

/**
 * The end of the paid period. Newer Stripe API versions moved it from the
 * subscription onto its items, so read either.
 */
function periodEnd(subscription: Stripe.Subscription): number | null {
  const onItem = subscription.items?.data?.[0] as { current_period_end?: number } | undefined
  return onItem?.current_period_end ?? (subscription as unknown as { current_period_end?: number }).current_period_end ?? null
}

export function standing(license: LicenseRecord, cancelAtPeriodEnd = false): LicenseStanding {
  return {
    valid: GOOD.has(license.status),
    plan: license.plan,
    status: license.status,
    email: license.email,
    expiresAt: license.currentPeriodEnd ? new Date(license.currentPeriodEnd * 1000).toISOString() : null,
    endsAtPeriodEnd: cancelAtPeriodEnd,
  }
}

export class Licenses {
  constructor(private readonly store: LicenseStore, private readonly stripe: LicenseStripe, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  /**
   * The license for a finished checkout, created on first sight. Null when
   * the session is unknown, unpaid, or not an Uplink purchase (the Stripe
   * account is shared with other apps).
   */
  async issue(sessionId: string): Promise<LicenseRecord | null> {
    const existing = await this.store.bySession(sessionId)
    if (existing)
      return existing

    const session = await this.stripe.checkoutSession(sessionId)
    const plan = planById(session.metadata?.plan)
    const paid = session.status === 'complete' && (session.payment_status === 'paid' || session.payment_status === 'no_payment_required')
    if (!plan || !paid)
      return null

    const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null
    let status = 'lifetime'
    let currentPeriodEnd: number | null = null
    if (plan.interval && subscriptionId) {
      const subscription = await this.stripe.subscription(subscriptionId)
      status = subscription.status
      currentPeriodEnd = periodEnd(subscription)
    }

    const license: LicenseRecord = {
      key: generateLicenseKey(),
      email: session.customer_details?.email ?? null,
      plan: plan.id,
      status,
      stripeCustomerId: typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null,
      stripeSubscriptionId: subscriptionId,
      stripeCheckoutSessionId: sessionId,
      currentPeriodEnd,
      checkedAt: this.now(),
    }
    await this.store.create(license)
    return license
  }

  /**
   * Where a license stands now. A subscription is re-read from Stripe unless
   * it was read in the last few minutes; if Stripe cannot be reached, the last
   * known answer stands rather than locking a paying customer out.
   */
  async check(rawKey: unknown): Promise<LicenseStanding | null> {
    const key = normalizeLicenseKey(rawKey)
    if (!key)
      return null
    const license = await this.store.byKey(key)
    if (!license)
      return null
    if (!license.stripeSubscriptionId || (license.checkedAt && this.now() - license.checkedAt < RECHECK_SECONDS))
      return standing(license)

    try {
      const subscription = await this.stripe.subscription(license.stripeSubscriptionId)
      const patch = { status: subscription.status, currentPeriodEnd: periodEnd(subscription), checkedAt: this.now() }
      await this.store.update(key, patch)
      return standing({ ...license, ...patch }, Boolean(subscription.cancel_at_period_end))
    }
    catch {
      return standing(license)
    }
  }

  /** The Stripe customer behind a key, for the customer portal. */
  async customerFor(rawKey: unknown): Promise<string | null> {
    const key = normalizeLicenseKey(rawKey)
    const license = key ? await this.store.byKey(key) : null
    return license?.stripeCustomerId ?? null
  }
}
