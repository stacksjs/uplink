import type { RequestInstance } from '@stacksjs/types'
import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { licenses } from '../../Billing/license-store'
import { bodyFor, receiveWebhook, statusFor, webhookSecret } from '../../Billing/webhook'

/**
 * POST /api/billing/webhook - Stripe's copy of what happened, so a license is
 * issued even when the buyer never reaches the thank-you page (#48).
 *
 * `rawBody()` rather than the parsed body: Stripe signs the bytes it sent, and
 * a re-serialized JSON body does not match the HMAC. The router keeps them for
 * exactly this.
 */
export default new Action({
  name: 'Stripe Webhook',
  description: 'Issue a license from a signed Stripe checkout event',
  method: 'POST',

  async handle(request: RequestInstance) {
    const outcome = await receiveWebhook(
      await request.rawBody?.() ?? null,
      request.headers.get('stripe-signature'),
      { secret: webhookSecret(), issue: async sessionId => (await licenses()).issue(sessionId) },
    )

    // Stripe shows these in the dashboard, and they are the only trace of a
    // purchase that did not become a license.
    if (outcome.kind !== 'licensed')
      console.error(`[stripe-webhook] ${outcome.kind}: ${JSON.stringify(bodyFor(outcome))}`)

    return response.json(bodyFor(outcome), statusFor(outcome))
  },
})
