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
    promotionFor: async code => code === 'SIXMONTHS'
      ? { id: 'promo_six', couponId: 'uplink_six_months_free' }
      : code === 'OTHERAPP' ? { id: 'promo_other', couponId: 'another_apps_coupon' } : undefined,
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

describe('codes', () => {
  it('give Monthly six free months with no card', async () => {
    const stripe = fakeStripe()
    expect(await startCheckout('monthly', 'https://x', stripe, ' sixmonths ')).toMatchObject({ kind: 'redirect' })
    expect(stripe.sessions[0]).toMatchObject({ discounts: [{ promotion_code: 'promo_six' }], payment_method_collection: 'if_required' })
  })

  it('are refused on Yearly and Lifetime, where six free months would be a free year or everything', async () => {
    const stripe = fakeStripe()
    expect(await startCheckout('yearly', 'https://x', stripe, 'SIXMONTHS')).toMatchObject({ kind: 'bad-code' })
    expect(await startCheckout('lifetime', 'https://x', stripe, 'SIXMONTHS')).toMatchObject({ kind: 'bad-code' })
    expect(stripe.sessions).toHaveLength(0)
  })

  it('must be Uplink\'s own, not another app\'s in the shared Stripe account', async () => {
    const stripe = fakeStripe()
    expect(await startCheckout('monthly', 'https://x', stripe, 'OTHERAPP')).toMatchObject({ kind: 'bad-code' })
    expect(await startCheckout('monthly', 'https://x', stripe, 'NOPE')).toMatchObject({ kind: 'bad-code' })
    expect(stripe.sessions).toHaveLength(0)
  })

  it('cannot be typed into Stripe\'s page, where every plan would take it', async () => {
    const stripe = fakeStripe()
    await startCheckout('lifetime', 'https://x', stripe)
    expect(stripe.sessions[0].allow_promotion_codes).toBeUndefined()
    expect(stripe.sessions[0].discounts).toBeUndefined()
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
