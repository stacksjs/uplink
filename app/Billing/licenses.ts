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
  /**
   * Every license bought with an address, given lower-cased. A store may hand
   * back more than that (a case-insensitive LIKE does); `activeFor` keeps only
   * exact matches, so over-matching is safe and under-matching is not.
   */
  byEmail: (email: string) => Promise<LicenseRecord[]>
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
 * An address as typed, trimmed and lower-cased, or null when it cannot be
 * one. Deliberately loose (a real check is whether mail arrives), except that
 * it refuses `%`, which no buyer's address has and which a LIKE lookup would
 * read as a wildcard.
 */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string')
    return null
  const email = input.trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@%]+@[^\s@%]+\.[^\s@%]+$/.test(email))
    return null
  return email
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

/** Told about each license the first time it is issued (the license email). */
export type OnIssued = (license: LicenseRecord, context: { freeMonths: boolean }) => Promise<void>

export class Licenses {
  constructor(
    private readonly store: LicenseStore,
    private readonly stripe: LicenseStripe,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly onIssued?: OnIssued,
  ) {}

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

    // Only for a license made just now: a reload of the thank-you page finds
    // the existing row above and sends nothing. A failed send is reported and
    // never takes the purchase down with it - the key is on the page anyway.
    if (this.onIssued) {
      const freeMonths = (session.total_details?.amount_discount ?? 0) > 0 && session.amount_total === 0
      try {
        await this.onIssued(license, { freeMonths })
      }
      catch (error) {
        console.error(`[licenses] ${license.key.slice(-4)}: could not send the license email: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
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

  /**
   * The licenses bought with an address that are good right now, for sending
   * their keys again. Each is checked the way the Mac app's check-in checks
   * it, so a subscription cancelled in the portal is left out even before the
   * app has noticed.
   */
  async activeFor(rawEmail: unknown): Promise<LicenseRecord[]> {
    const email = normalizeEmail(rawEmail)
    if (!email)
      return []
    const active: LicenseRecord[] = []
    for (const license of await this.store.byEmail(email)) {
      if (license.email?.trim().toLowerCase() !== email)
        continue
      if ((await this.check(license.key))?.valid)
        active.push(license)
    }
    return active
  }

  /** The Stripe customer behind a key, for the customer portal. */
  async customerFor(rawKey: unknown): Promise<string | null> {
    const key = normalizeLicenseKey(rawKey)
    const license = key ? await this.store.byKey(key) : null
    return license?.stripeCustomerId ?? null
  }
}
