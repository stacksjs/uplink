import type { SaasConfig } from '@stacksjs/types'
import { PLANS, PRODUCT_NAME, SIX_MONTHS_FREE } from '../app/Billing/plans'

/**
 * **Payment Configuration**
 *
 * This configuration defines all of your Payment options. Because Stacks is fully-typed,
 * you may hover any of the options below and the definitions will be provided. In case
 * you have any questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default {
  // Uplink's three ways to pay, from app/Billing/plans.ts. One product, three
  // prices, each found at checkout by its lookup key. Amounts are cents.
  plans: [
    {
      productName: PRODUCT_NAME,
      description: 'Text your Mac, even over satellite, and Claude answers.',
      pricing: PLANS.map(plan => ({
        key: plan.lookupKey,
        price: plan.priceCents,
        ...(plan.interval ? { interval: plan.interval } : {}),
        currency: 'usd',
      })),
      metadata: {
        createdBy: 'uplink',
        version: '1.0.0',
      },
    },
  ],
  webhook: {
    endpoint: 'your-webhook-endpoint',
    secret: 'your-webhook-secret',
  },
  currencies: ['usd'],
  // Six months of Monthly, free: 100% off six monthly invoices. The code is
  // only honoured on Monthly - checkout applies it itself, because Stripe
  // restricts coupons by product and all three plans share one (a "repeating"
  // coupon on Yearly would make the whole first year free, and on Lifetime,
  // everything). See app/Billing/checkout.ts.
  coupons: [
    {
      id: SIX_MONTHS_FREE.couponId,
      name: '6 months free',
      percentOff: 100,
      duration: 'repeating',
      durationInMonths: 6,
      codes: [SIX_MONTHS_FREE.code],
    },
  ],
  // Where a subscriber cancels, changes card and gets invoices. Cancelling
  // keeps what they paid for until the period ends.
  portal: {
    headline: 'Manage your Uplink plan',
    returnUrl: 'https://uplink.stacksjs.com/',
    cancel: 'at_period_end',
  },
  products: [
    {
      name: PRODUCT_NAME,
      description: 'Text your Mac, even over satellite, and Claude answers.',
      images: [],
    },
  ],
} satisfies SaasConfig
