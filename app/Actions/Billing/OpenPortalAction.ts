import type { RequestInstance } from '@stacksjs/types'
import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { licenses } from '../../Billing/license-store'

/**
 * POST /api/billing/portal { key } - a one-time link into the Stripe customer
 * portal for the customer behind a license key: cancel, change card, invoices.
 * The key is the credential, as it is for everything else the app does here.
 */
export default new Action({
  name: 'Open Billing Portal',
  description: 'A Stripe customer portal link for a license',
  method: 'POST',

  async handle(request: RequestInstance) {
    const customer = await (await licenses()).customerFor(request.get('key'))
    if (!customer)
      return response.json({ error: 'That license key has no billing account.' }, 404)

    const { Payment } = await import('@stacksjs/payments')
    const session = await Payment.billingPortal(customer, { returnUrl: 'https://uplink.stacksjs.com/' })
    return response.json({ url: session.url })
  },
})
