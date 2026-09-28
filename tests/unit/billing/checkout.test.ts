import type { CheckoutDeps } from '../../../app/Billing/checkout'
import { describe, expect, it } from 'bun:test'
import { siteOrigin, startCheckout } from '../../../app/Billing/checkout'
import { formatCents, PLANS, yearlySavingPercent } from '../../../app/Billing/plans'

function fakeStripe(overrides: Partial<CheckoutDeps> = {}): CheckoutDeps & { sessions: any[] } {
  const sessions: any[] = []
  return {
    sessions,
    configured: () => true,
    priceFor: async key => ({ id: `price_for_${key}` }),
    createSession: async (params) => {
      sessions.push(params)
      return { url: 'https://checkout.stripe.com/c/pay/cs_test_x' }
    },
    ...overrides,
  }
}

describe('plans', () => {
  it('are the three prices, in cents', () => {
    expect(PLANS.map(plan => [plan.id, plan.priceCents, plan.interval])).toEqual([
      ['monthly', 199, 'month'],
      ['yearly', 1999, 'year'],
      ['lifetime', 2999, undefined],
    ])
    expect(PLANS.map(plan => formatCents(plan.priceCents))).toEqual(['$1.99', '$19.99', '$29.99'])
  })

  it('never claims more saving than there is', () => {
    // 1999 / (199 * 12) = 0.837..., a 16.3% saving.
    expect(yearlySavingPercent()).toBe(16)
  })
})

describe('startCheckout', () => {
  it('subscribes for a recurring plan', async () => {
    const stripe = fakeStripe()
    const outcome = await startCheckout('monthly', 'https://uplink.stacksjs.com', stripe)
    expect(outcome).toEqual({ kind: 'redirect', url: 'https://checkout.stripe.com/c/pay/cs_test_x' })
    expect(stripe.sessions[0]).toMatchObject({
      mode: 'subscription',
      line_items: [{ price: 'price_for_uplink_monthly', quantity: 1 }],
      success_url: 'https://uplink.stacksjs.com/thanks?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://uplink.stacksjs.com/pricing',
      subscription_data: { metadata: { plan: 'monthly' } },
    })
  })

  it('takes one payment, with a customer, for lifetime', async () => {
    const stripe = fakeStripe()
    await startCheckout('lifetime', 'https://uplink.stacksjs.com', stripe)
    expect(stripe.sessions[0]).toMatchObject({ mode: 'payment', customer_creation: 'always', line_items: [{ price: 'price_for_uplink_lifetime' }] })
  })

  it('refuses a plan that does not exist, before touching Stripe', async () => {
    const stripe = fakeStripe()
    expect(await startCheckout('payment', 'https://x', stripe)).toEqual({ kind: 'unknown-plan' })
    expect(await startCheckout(undefined, 'https://x', stripe)).toEqual({ kind: 'unknown-plan' })
    expect(stripe.sessions).toHaveLength(0)
  })

  it('says why checkout is unavailable instead of throwing', async () => {
    expect(await startCheckout('yearly', 'https://x', fakeStripe({ configured: () => false }))).toMatchObject({ kind: 'unavailable' })
    expect(await startCheckout('yearly', 'https://x', fakeStripe({ priceFor: async () => undefined }))).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('uplink_yearly') })
    expect(await startCheckout('yearly', 'https://x', fakeStripe({ createSession: async () => { throw new Error('card network down') } }))).toEqual({ kind: 'unavailable', reason: 'card network down' })
  })
})

describe('siteOrigin', () => {
  it('turns APP_URL into an origin', () => {
    expect(siteOrigin('uplink.stacksjs.com')).toBe('https://uplink.stacksjs.com')
    expect(siteOrigin('uplink.localhost')).toBe('http://uplink.localhost')
    expect(siteOrigin('https://uplink.stacksjs.com/')).toBe('https://uplink.stacksjs.com')
    expect(siteOrigin('')).toBe('https://uplink.stacksjs.com')
  })
})
