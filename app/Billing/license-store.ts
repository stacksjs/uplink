import type { LicenseRecord, LicenseStore, LicenseStripe } from './licenses'
import type { Plan, PlanId } from './plans'
import License from '../Models/License'
import { Licenses } from './licenses'
import { planById } from './plans'

/**
 * The License model as a LicenseStore, and Stripe through @stacksjs/payments.
 * The ORM writes camelCase and reads back snake_case columns.
 */

function fromRow(row: Record<string, any>): LicenseRecord {
  return {
    key: row.key,
    email: row.email ?? null,
    plan: row.plan as PlanId,
    status: row.status,
    stripeCustomerId: row.stripe_customer_id ?? null,
    stripeSubscriptionId: row.stripe_subscription_id ?? null,
    stripeCheckoutSessionId: row.stripe_checkout_session_id,
    currentPeriodEnd: row.current_period_end ?? null,
    checkedAt: row.checked_at ?? null,
  }
}

export const modelLicenseStore: LicenseStore = {
  async byKey(key) {
    const row = await License.where('key', key).first() as Record<string, any> | undefined
    return row ? fromRow(row) : null
  },
  async bySession(sessionId) {
    const row = await License.where('stripe_checkout_session_id', sessionId).first() as Record<string, any> | undefined
    return row ? fromRow(row) : null
  },
  async create(license) {
    await License.create({ ...license })
  },
  async update(key, patch) {
    const row = await License.where('key', key).first() as { update: (values: object) => Promise<unknown> } | undefined
    await row?.update(patch)
  },
}

export async function stripeForLicenses(): Promise<LicenseStripe> {
  const { stripe } = await import('@stacksjs/payments')
  return {
    checkoutSession: id => stripe.checkout.sessions.retrieve(id),
    subscription: id => stripe.subscriptions.retrieve(id),
  }
}

export async function licenses(): Promise<Licenses> {
  return new Licenses(modelLicenseStore, await stripeForLicenses(), undefined, async (license, { freeMonths }) => {
    const { sendLicenseEmail } = await import('../Mail/LicenseEmail')
    const { siteOrigin } = await import('./checkout')
    await sendLicenseEmail(license, `${siteOrigin()}/thanks?session_id=${license.stripeCheckoutSessionId}`, freeMonths)
  })
}

export interface Thanks {
  plan: Plan | null
  email: string | null
  /** The key to activate the Mac app with; null until Stripe says paid. */
  licenseKey: string | null
}

/**
 * What the thank-you page shows for the checkout Stripe sent the buyer back
 * from: the license, issued on first visit and the same one on every reload.
 * Null for a missing or unknown session, so the page says nothing it cannot
 * stand behind.
 */
export async function thanksFor(sessionId: unknown): Promise<Thanks | null> {
  if (typeof sessionId !== 'string' || !/^cs_(?:test|live)_\w+$/.test(sessionId))
    return null
  try {
    const { isStripeConfigured } = await import('@stacksjs/payments')
    if (!isStripeConfigured())
      return null
    const license = await (await licenses()).issue(sessionId)
    if (!license)
      return { plan: null, email: null, licenseKey: null }
    return { plan: planById(license.plan) ?? null, email: license.email, licenseKey: license.key }
  }
  catch (error) {
    console.error(`[thanks] ${sessionId.slice(0, 16)}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
