import type { SaasConfig } from '@stacksjs/types'
import { PLANS, PRODUCT_NAME } from '../app/Billing/plans'

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
  coupons: [],
  products: [
    {
      name: PRODUCT_NAME,
      description: 'Text your Mac, even over satellite, and Claude answers.',
      images: [],
    },
  ],
} satisfies SaasConfig
