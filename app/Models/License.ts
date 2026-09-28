import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One purchase of Uplink: the key the Mac app activates with, and the Stripe
 * objects that decide whether it is still good. Issued when a checkout
 * completes (app/Billing/licenses.ts); a subscription's status is re-read from
 * Stripe when the app checks in, so a cancellation in the customer portal
 * takes effect without a webhook.
 */
export default defineModel({
  name: 'License',
  table: 'licenses',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  attributes: {
    key: {
      order: 1,
      unique: true,
      fillable: true,
      validation: { rule: schema.string().required().max(64) },
      factory: faker => `UPLK-${faker.string.alphanumeric({ length: 16, casing: 'upper' }).match(/.{4}/g)!.join('-')}`,
    },

    email: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: faker => faker.internet.email(),
    },

    plan: {
      order: 3,
      fillable: true,
      validation: { rule: schema.enum(['monthly', 'yearly', 'lifetime']).required() },
      factory: faker => faker.helpers.arrayElement(['monthly', 'yearly', 'lifetime']),
    },

    /** Stripe's word for it: active, trialing, past_due, canceled, unpaid, or paid for lifetime. */
    status: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().required().max(32) },
      factory: () => 'active',
    },

    stripeCustomerId: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: faker => `cus_${faker.string.alphanumeric(14)}`,
    },

    stripeSubscriptionId: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: faker => `sub_${faker.string.alphanumeric(14)}`,
    },

    /** The checkout that created it; issuing twice for one checkout finds this row. */
    stripeCheckoutSessionId: {
      order: 7,
      unique: true,
      fillable: true,
      validation: { rule: schema.string().required().max(255) },
      factory: faker => `cs_test_${faker.string.alphanumeric(24)}`,
    },

    /** When the paid period ends, as epoch seconds. Empty for lifetime. */
    currentPeriodEnd: {
      order: 8,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => Math.floor(Date.now() / 1000) + 30 * 86400,
    },

    /** Epoch seconds of the last time Stripe was asked. */
    checkedAt: {
      order: 9,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => Math.floor(Date.now() / 1000),
    },
  },
})
