import type Stripe from 'stripe'
import type { Plan } from './plans'
import process from 'node:process'
import { planById, SIX_MONTHS_FREE } from './plans'

/**
 * Stripe Checkout for the pricing page, through `@stacksjs/payments`.
 *
 * Each plan's price is found by its lookup key (what `buddy stripe:setup`
 * created from `config/saas.ts`), so no Stripe id lives in code. Stripe hosts
 * the payment page and creates the customer; this site never sees a card.
 *
 * One async call per page: a view's server script may await once.
 */

export type CheckoutOutcome =
  | { kind: 'redirect', url: string }
  | { kind: 'unknown-plan' }
  /** A code that is not a live promotion code, or not one this plan takes. */
  | { kind: 'bad-code', reason: string }
  | { kind: 'unavailable', reason: string }

export interface CheckoutDeps {
  configured: () => boolean
  priceFor: (lookupKey: string) => Promise<{ id: string } | undefined>
  createSession: (params: Stripe.Checkout.SessionCreateParams) => Promise<{ url: string | null }>
  /** The active promotion code a customer typed, with the coupon it applies. */
  promotionFor: (code: string) => Promise<{ id: string, couponId: string | undefined } | undefined>
}

async function stripeDeps(): Promise<CheckoutDeps> {
  const { getPrice, isStripeConfigured, stripe, validatePromoCode } = await import('@stacksjs/payments')
  return {
    configured: isStripeConfigured,
    priceFor: getPrice,
    createSession: params => stripe.checkout.sessions.create(params),
    async promotionFor(code) {
      const promotion = await validatePromoCode(code)
      if (!promotion)
        return undefined
      const coupon = promotion.promotion?.coupon
      return { id: promotion.id, couponId: typeof coupon === 'string' ? coupon : coupon?.id }
    },
  }
}

/** The public origin, from APP_URL, which may be written with or without a scheme. */
export function siteOrigin(appUrl = process.env.APP_URL ?? ''): string {
  const host = appUrl.trim().replace(/\/+$/, '')
  if (!host)
    return 'https://uplink.stacksjs.com'
  if (/^https?:\/\//.test(host))
    return host
  return /(?:^|\.)localhost(?::\d+)?$/.test(host) ? `http://${host}` : `https://${host}`
}

/** A code as typed: trimmed and upper-cased, or null for none. */
export function normalizeCode(code: unknown): string | null {
  if (typeof code !== 'string')
    return null
  const trimmed = code.trim().toUpperCase()
  return trimmed ? trimmed : null
}

export function sessionParams(plan: Plan, priceId: string, origin: string, promotionCodeId?: string): Stripe.Checkout.SessionCreateParams {
  const metadata = { plan: plan.id }
  return {
    mode: plan.interval ? 'subscription' : 'payment',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${origin}/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/pricing`,
    // Codes are applied here, never typed into Stripe's page: all three plans
    // are one Stripe product, so a code Stripe accepted for Monthly it would
    // accept for Lifetime too, and six free months of that is all of it.
    ...(promotionCodeId
      ? {
          discounts: [{ promotion_code: promotionCodeId }],
          // Free months ask for no card; one can be added in the customer
          // portal before the first paid month.
          payment_method_collection: 'if_required' as const,
        }
      : {}),
    metadata,
    // A subscription has a customer by definition; a one-time payment only
    // gets one if asked, and a lifetime buyer should have one.
    ...(plan.interval
      ? { subscription_data: { metadata } }
      : { customer_creation: 'always', payment_intent_data: { metadata } }),
  }
}

export async function startCheckout(planId: unknown, origin = siteOrigin(), deps?: CheckoutDeps, rawCode?: unknown): Promise<CheckoutOutcome> {
  const plan = planById(planId)
  if (!plan)
    return { kind: 'unknown-plan' }
  const code = normalizeCode(rawCode)
  if (code && plan.id !== SIX_MONTHS_FREE.plan)
    return { kind: 'bad-code', reason: `Codes are for the Monthly plan. ${plan.name} is not discounted.` }
  try {
    const stripe = deps ?? await stripeDeps()
    if (!stripe.configured())
      return { kind: 'unavailable', reason: 'Stripe is not configured on this server.' }

    let promotionCodeId: string | undefined
    if (code) {
      const promotion = await stripe.promotionFor(code)
      // Its coupon must be Uplink's: the Stripe account is shared with other
      // apps, whose codes would otherwise discount this one.
      if (!promotion || promotion.couponId !== SIX_MONTHS_FREE.couponId)
        return { kind: 'bad-code', reason: `${code} is not a code Uplink knows, or it has run out.` }
      promotionCodeId = promotion.id
    }

    const price = await stripe.priceFor(plan.lookupKey)
    if (!price)
      return { kind: 'unavailable', reason: `No Stripe price has the lookup key ${plan.lookupKey}. Run buddy stripe:setup.` }
    const session = await stripe.createSession(sessionParams(plan, price.id, origin, promotionCodeId))
    return session.url ? { kind: 'redirect', url: session.url } : { kind: 'unavailable', reason: 'Stripe returned no checkout page.' }
  }
  catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
  }
}
