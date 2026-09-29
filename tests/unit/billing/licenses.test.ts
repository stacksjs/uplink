import type { LicenseRecord, LicenseStore, LicenseStripe } from '../../../app/Billing/licenses'
import { describe, expect, it } from 'bun:test'
import { generateLicenseKey, Licenses, normalizeLicenseKey, RECHECK_SECONDS } from '../../../app/Billing/licenses'

function memoryStore(): LicenseStore & { rows: LicenseRecord[] } {
  const rows: LicenseRecord[] = []
  return {
    rows,
    byKey: async key => rows.find(r => r.key === key) ?? null,
    bySession: async id => rows.find(r => r.stripeCheckoutSessionId === id) ?? null,
    create: async (license) => { rows.push({ ...license }) },
    update: async (key, patch) => { Object.assign(rows.find(r => r.key === key)!, patch) },
  }
}

function fakeStripe(state: { sessions: Record<string, any>, subscriptions: Record<string, any> }): LicenseStripe & { subscriptionReads: number } {
  const stripe = {
    subscriptionReads: 0,
    checkoutSession: async (id: string) => state.sessions[id],
    subscription: async (id: string) => {
      stripe.subscriptionReads++
      if (!state.subscriptions[id])
        throw new Error('Stripe is unreachable')
      return state.subscriptions[id]
    },
  }
  return stripe
}

const PERIOD_END = 1_800_000_000

function account() {
  return {
    sessions: {
      cs_test_monthly: { status: 'complete', payment_status: 'paid', metadata: { plan: 'monthly' }, subscription: 'sub_1', customer: 'cus_1', customer_details: { email: 'a@example.com' } },
      cs_test_free: { status: 'complete', payment_status: 'no_payment_required', metadata: { plan: 'monthly' }, subscription: 'sub_2', customer: 'cus_2', customer_details: { email: 'b@example.com' } },
      cs_test_lifetime: { status: 'complete', payment_status: 'paid', metadata: { plan: 'lifetime' }, subscription: null, customer: 'cus_3', customer_details: { email: 'c@example.com' } },
      cs_test_unpaid: { status: 'open', payment_status: 'unpaid', metadata: { plan: 'yearly' } },
      cs_test_other_app: { status: 'complete', payment_status: 'paid', metadata: {}, customer: 'cus_9' },
    } as Record<string, any>,
    subscriptions: {
      sub_1: { status: 'active', items: { data: [{ current_period_end: PERIOD_END }] }, cancel_at_period_end: false },
      sub_2: { status: 'active', items: { data: [{ current_period_end: PERIOD_END }] }, cancel_at_period_end: false },
    } as Record<string, any>,
  }
}

describe('license keys', () => {
  it('are 80 random bits in an alphabet without look-alike characters', () => {
    const key = generateLicenseKey(new Uint8Array(10).fill(255))
    expect(key).toMatch(/^UPLK-[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/)
    expect(generateLicenseKey()).not.toBe(generateLicenseKey())
  })

  it('are forgiving about how they are typed', () => {
    const key = generateLicenseKey()
    expect(normalizeLicenseKey(key.toLowerCase())).toBe(key)
    expect(normalizeLicenseKey(` ${key.replace(/-/g, ' ').slice(5)} `)).toBe(key)
    expect(normalizeLicenseKey('UPLK-0000-1111-OOOO-IIII')).toBeNull()
    expect(normalizeLicenseKey(42)).toBeNull()
  })
})

describe('Licenses', () => {
  it('issues one license per checkout, however often the thank-you page loads', async () => {
    const store = memoryStore()
    const licenses = new Licenses(store, fakeStripe(account()))
    const first = await licenses.issue('cs_test_monthly')
    const again = await licenses.issue('cs_test_monthly')
    expect(again!.key).toBe(first!.key)
    expect(store.rows).toHaveLength(1)
    expect(first).toMatchObject({ plan: 'monthly', status: 'active', email: 'a@example.com', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', currentPeriodEnd: PERIOD_END })
  })

  it('issues for free months, which Stripe marks as needing no payment', async () => {
    const licenses = new Licenses(memoryStore(), fakeStripe(account()))
    expect(await licenses.issue('cs_test_free')).toMatchObject({ plan: 'monthly', status: 'active' })
  })

  it('issues nothing for an unpaid checkout or another app\'s', async () => {
    const store = memoryStore()
    const licenses = new Licenses(store, fakeStripe(account()))
    expect(await licenses.issue('cs_test_unpaid')).toBeNull()
    expect(await licenses.issue('cs_test_other_app')).toBeNull()
    expect(store.rows).toHaveLength(0)
  })

  it('keeps lifetime good without asking Stripe', async () => {
    const stripe = fakeStripe(account())
    const licenses = new Licenses(memoryStore(), stripe)
    const license = await licenses.issue('cs_test_lifetime')
    expect(await licenses.check(license!.key)).toMatchObject({ valid: true, plan: 'lifetime', expiresAt: null })
    expect(stripe.subscriptionReads).toBe(0)
  })

  it('follows a cancellation in the portal once the recheck window passes', async () => {
    let now = 1_700_000_000
    const state = account()
    const licenses = new Licenses(memoryStore(), fakeStripe(state), () => now)
    const license = await licenses.issue('cs_test_monthly')

    state.subscriptions.sub_1 = { ...state.subscriptions.sub_1, cancel_at_period_end: true }
    now += RECHECK_SECONDS + 1
    expect(await licenses.check(license!.key)).toMatchObject({ valid: true, endsAtPeriodEnd: true })

    state.subscriptions.sub_1 = { ...state.subscriptions.sub_1, status: 'canceled' }
    now += RECHECK_SECONDS + 1
    expect(await licenses.check(license!.key)).toMatchObject({ valid: false, status: 'canceled' })
  })

  it('asks Stripe at most once per window, and keeps the last answer when Stripe is down', async () => {
    let now = 1_700_000_000
    const state = account()
    const stripe = fakeStripe(state)
    const licenses = new Licenses(memoryStore(), stripe, () => now)
    const license = await licenses.issue('cs_test_monthly')
    const reads = stripe.subscriptionReads
    await licenses.check(license!.key)
    await licenses.check(license!.key)
    expect(stripe.subscriptionReads).toBe(reads)

    delete state.subscriptions.sub_1
    now += RECHECK_SECONDS + 1
    expect(await licenses.check(license!.key)).toMatchObject({ valid: true, status: 'active' })
  })

  it('knows nothing about a key it did not issue', async () => {
    const licenses = new Licenses(memoryStore(), fakeStripe(account()))
    expect(await licenses.check(generateLicenseKey())).toBeNull()
    expect(await licenses.check('not a key')).toBeNull()
    expect(await licenses.customerFor(generateLicenseKey())).toBeNull()
  })
})

describe('the license email', () => {
  it('is sent once, for a license issued just now, and says when the free months end', async () => {
    const sent: Array<{ key: string, freeMonths: boolean }> = []
    const state = account()
    state.sessions.cs_test_free = { ...state.sessions.cs_test_free, amount_total: 0, total_details: { amount_discount: 199 } }
    const licenses = new Licenses(memoryStore(), fakeStripe(state), undefined, async (license, context) => { sent.push({ key: license.key, ...context }) })
    const license = await licenses.issue('cs_test_free')
    await licenses.issue('cs_test_free')
    expect(sent).toEqual([{ key: license!.key, freeMonths: true }])
  })

  it('never takes the purchase down with it', async () => {
    const licenses = new Licenses(memoryStore(), fakeStripe(account()), undefined, async () => { throw new Error('SMTP is down') })
    expect(await licenses.issue('cs_test_monthly')).toMatchObject({ plan: 'monthly' })
  })
})
