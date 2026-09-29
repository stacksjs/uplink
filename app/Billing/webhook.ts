import type { LicenseRecord } from './licenses'
import process from 'node:process'

/**
 * The Stripe webhook that issues a license when the thank-you page does not.
 *
 * Until this existed, `issue()` had exactly one caller: rendering
 * `/thanks?session_id=...`, which is checkout's `success_url`. So the redirect
 * after payment was the only event in the system that ever created a license,
 * and a buyer who closed the tab, lost the network at that moment, or paid by
 * a method that settles after the redirect, was charged and got nothing. There
 * was no resend path and no way for them to ask (#48).
 *
 * Nothing about issuing is reimplemented here. `issue()` is idempotent by
 * construction: it returns the existing row for a session it has already seen,
 * and only emails a key for one created just now. So the webhook and the page
 * can arrive in either order, or twice, and the buyer ends up with one license
 * and one email.
 */

/** The events that mean a checkout is paid for and a license is owed. */
const ISSUING_EVENTS = new Set([
  'checkout.session.completed',
  // Payment methods that settle after the redirect. Stripe sends `completed`
  // first, while `payment_status` is still unpaid, and this once it clears.
  'checkout.session.async_payment_succeeded',
])

export type WebhookOutcome =
  /** There is a license for this checkout, issued now or already there. */
  | { kind: 'licensed', key: string }
  /** Verified, and there is nothing to issue: another event, or not paid yet. */
  | { kind: 'ignored', reason: string }
  /** Not from Stripe, or not signed with this endpoint's secret. */
  | { kind: 'rejected', reason: string }
  /** No signing secret, so nothing can be verified. Never issue on this. */
  | { kind: 'unconfigured' }
  /** Verified, and it should have worked. Stripe retries a 500. */
  | { kind: 'failed', error: string }

export interface WebhookDeps {
  secret: string
  issue: (sessionId: string) => Promise<LicenseRecord | null>
  /** Seconds of clock skew allowed between Stripe and this server. */
  tolerance?: number
}

export function webhookSecret(env = process.env): string {
  return (env.STRIPE_WEBHOOK_SECRET ?? '').trim()
}

/**
 * What to do with one delivery. `raw` must be the bytes Stripe sent: the
 * signature is over those, and a re-serialized JSON body will not match.
 */
export async function receiveWebhook(raw: string | null, signature: string | null, deps: WebhookDeps): Promise<WebhookOutcome> {
  if (!deps.secret)
    return { kind: 'unconfigured' }
  if (!raw)
    // The router hands the action `rawBody()`; without it there is nothing to
    // verify, and issuing on an unverified body is worse than not issuing.
    return { kind: 'rejected', reason: 'No request body to verify.' }
  if (!signature)
    return { kind: 'rejected', reason: 'No Stripe-Signature header.' }

  try {
    // `@stacksjs/security` rather than the payments package's `constructEvent`:
    // this one is a plain HMAC check with no Stripe client behind it, so it
    // cannot hit the SubtleCrypto trap that made the SDK path 401 every real
    // delivery on Bun (stacksjs/stacks#2355).
    const { verifyStripe } = await import('@stacksjs/security')
    verifyStripe(deps.secret, signature, raw, deps.tolerance === undefined ? undefined : { toleranceSeconds: deps.tolerance })
  }
  catch (error) {
    return { kind: 'rejected', reason: message(error) }
  }

  const event = parse(raw)
  if (!event)
    return { kind: 'rejected', reason: 'Signed, but the body is not a Stripe event.' }
  if (!ISSUING_EVENTS.has(event.type))
    return { kind: 'ignored', reason: `Nothing to do for ${event.type}.` }

  const session = event.data?.object
  if (session?.object !== 'checkout.session' || typeof session.id !== 'string')
    return { kind: 'rejected', reason: `${event.type} carried no checkout session.` }

  try {
    const license = await deps.issue(session.id)
    // Null is Stripe saying the session is not paid, or naming a plan this
    // build does not have. Neither improves by being retried: for the first,
    // `async_payment_succeeded` is already on its way.
    return license
      ? { kind: 'licensed', key: license.key }
      : { kind: 'ignored', reason: `${session.id} is not a paid checkout for a plan Uplink sells.` }
  }
  catch (error) {
    // A database or Stripe failure, which a retry may well fix, and the
    // purchase is real either way.
    return { kind: 'failed', error: message(error) }
  }
}

/**
 * Stripe retries anything that is not a 2xx, so the code says whether trying
 * again could help. A bad signature never improves; a database that was down
 * might.
 */
export function statusFor(outcome: WebhookOutcome): 200 | 400 | 500 {
  switch (outcome.kind) {
    case 'licensed':
    case 'ignored':
      return 200
    case 'rejected':
      return 400
    case 'unconfigured':
    case 'failed':
      return 500
  }
}

/** What to send back. Never the license key: this answers Stripe, not a buyer. */
export function bodyFor(outcome: WebhookOutcome): Record<string, unknown> {
  switch (outcome.kind) {
    case 'licensed':
      return { received: true, licensed: true }
    case 'ignored':
      return { received: true, licensed: false, reason: outcome.reason }
    case 'rejected':
      return { error: outcome.reason }
    case 'unconfigured':
      return { error: 'This server has no Stripe webhook secret, so it cannot verify deliveries.' }
    case 'failed':
      return { error: outcome.error }
  }
}

interface StripeEvent {
  type: string
  data?: { object?: Record<string, any> }
}

function parse(raw: string): StripeEvent | null {
  try {
    const body = JSON.parse(raw) as StripeEvent
    return body && typeof body.type === 'string' ? body : null
  }
  catch {
    return null
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
