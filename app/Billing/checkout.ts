import type Stripe from 'stripe'
import type { Plan } from './plans'
import process from 'node:process'
import { planById, PLANS } from './plans'

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
  | { kind: 'unavailable', reason: string }

export interface CheckoutDeps {
  configured: () => boolean
  priceFor: (lookupKey: string) => Promise<{ id: string } | undefined>
  createSession: (params: Stripe.Checkout.SessionCreateParams) => Promise<{ url: string | null }>
}

async function stripeDeps(): Promise<CheckoutDeps> {
  const { getPrice, isStripeConfigured, stripe } = await import('@stacksjs/payments')
  return {
    configured: isStripeConfigured,
    priceFor: getPrice,
    createSession: params => stripe.checkout.sessions.create(params),
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

export function sessionParams(plan: Plan, priceId: string, origin: string): Stripe.Checkout.SessionCreateParams {
  const metadata = { plan: plan.id }
  return {
    mode: plan.interval ? 'subscription' : 'payment',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${origin}/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/pricing`,
    allow_promotion_codes: true,
    metadata,
    // A subscription has a customer by definition; a one-time payment only
    // gets one if asked, and a lifetime buyer should have one.
    ...(plan.interval
      ? { subscription_data: { metadata } }
      : { customer_creation: 'always', payment_intent_data: { metadata } }),
  }
}

export async function startCheckout(planId: unknown, origin = siteOrigin(), deps?: CheckoutDeps): Promise<CheckoutOutcome> {
  const plan = planById(planId)
  if (!plan)
    return { kind: 'unknown-plan' }
  try {
    const stripe = deps ?? await stripeDeps()
    if (!stripe.configured())
      return { kind: 'unavailable', reason: 'Stripe is not configured on this server.' }
    const price = await stripe.priceFor(plan.lookupKey)
    if (!price)
      return { kind: 'unavailable', reason: `No Stripe price has the lookup key ${plan.lookupKey}. Run buddy stripe:setup.` }
    const session = await stripe.createSession(sessionParams(plan, price.id, origin))
    return session.url ? { kind: 'redirect', url: session.url } : { kind: 'unavailable', reason: 'Stripe returned no checkout page.' }
  }
  catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
  }
}

export interface Receipt {
  plan: Plan | null
  email: string | null
  paid: boolean
}

/** What the thank-you page says about a finished checkout, or null for an unknown session. */
export async function readReceipt(sessionId: unknown): Promise<Receipt | null> {
  if (typeof sessionId !== 'string' || !/^cs_(?:test|live)_\w+$/.test(sessionId))
    return null
  try {
    const { isStripeConfigured, stripe } = await import('@stacksjs/payments')
    if (!isStripeConfigured())
      return null
    const session = await stripe.checkout.sessions.retrieve(sessionId)
    return {
      plan: PLANS.find(plan => plan.id === session.metadata?.plan) ?? null,
      email: session.customer_details?.email ?? null,
      paid: session.payment_status === 'paid' || session.payment_status === 'no_payment_required',
    }
  }
  catch {
    return null
  }
}
