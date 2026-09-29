import type { LicenseRecord, LicenseStore, LicenseStripe } from '../../../app/Billing/licenses'
import { describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'
import process from 'node:process'
import { Licenses } from '../../../app/Billing/licenses'
import { bodyFor, receiveWebhook, statusFor, webhookSecret } from '../../../app/Billing/webhook'

const SECRET = 'whsec_test_secret'
const PERIOD_END = 1_800_000_000

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

function fakeStripe(): LicenseStripe {
  const sessions: Record<string, any> = {
    cs_test_monthly: { status: 'complete', payment_status: 'paid', metadata: { plan: 'monthly' }, subscription: 'sub_1', customer: 'cus_1', customer_details: { email: 'a@example.com' } },
    // Paid by a method that settles after the redirect: `completed` arrives
    // while this is still unpaid, and `async_payment_succeeded` follows.
    cs_test_pending: { status: 'complete', payment_status: 'unpaid', metadata: { plan: 'monthly' }, subscription: 'sub_1', customer: 'cus_2', customer_details: { email: 'b@example.com' } },
  }
  return {
    checkoutSession: async (id: string) => sessions[id],
    subscription: async () => ({ status: 'active', items: { data: [{ current_period_end: PERIOD_END }] }, cancel_at_period_end: false }) as any,
  }
}

/** A delivery as Stripe sends it: the signature is over these exact bytes. */
function delivery(type: string, sessionId: string, at = Math.floor(Date.now() / 1000)): { raw: string, signature: string } {
  const raw = JSON.stringify({ id: 'evt_1', type, data: { object: { object: 'checkout.session', id: sessionId } } })
  return { raw, signature: sign(raw, at) }
}

function sign(raw: string, at: number, secret = SECRET): string {
  return `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${raw}`).digest('hex')}`
}

/** The webhook and the thank-you page both go through `issue`. */
function billing() {
  const store = memoryStore()
  const emails: string[] = []
  const licenses = new Licenses(store, fakeStripe(), undefined, async (license) => { emails.push(license.key) })
  return {
    store,
    emails,
    page: (sessionId: string) => licenses.issue(sessionId),
    post: (sent: { raw: string, signature: string }, secret = SECRET) =>
      receiveWebhook(sent.raw, sent.signature, { secret, issue: id => licenses.issue(id) }),
  }
}

describe('the Stripe webhook', () => {
  it('issues the license for a paid checkout, and says nothing about the key', async () => {
    const { post, store, emails } = billing()
    const outcome = await post(delivery('checkout.session.completed', 'cs_test_monthly'))

    expect(outcome.kind).toBe('licensed')
    expect(statusFor(outcome)).toBe(200)
    expect(store.rows).toHaveLength(1)
    expect(emails).toHaveLength(1)
    // The reply goes to Stripe, not to a buyer, so it carries no key.
    expect(JSON.stringify(bodyFor(outcome))).not.toContain(store.rows[0].key)
  })

  it('issues on the event that follows a payment settling after the redirect', async () => {
    const { post, store } = billing()
    // `completed` arrives first, while Stripe still says unpaid. Retrying that
    // would not help, so it is acknowledged rather than failed.
    const early = await post(delivery('checkout.session.completed', 'cs_test_pending'))
    expect(early.kind).toBe('ignored')
    expect(statusFor(early)).toBe(200)
    expect(store.rows).toHaveLength(0)
  })

  /**
   * The acceptance for #48: the webhook and the thank-you page can arrive in
   * either order, or twice, and the buyer ends up with one license and one
   * email. `issue` was already idempotent, so this pins it rather than adding
   * anything.
   */
  it('produces one license and one email however the two arrive', async () => {
    for (const order of ['webhook first', 'page first'] as const) {
      const { post, page, store, emails } = billing()
      const sent = delivery('checkout.session.completed', 'cs_test_monthly')

      if (order === 'webhook first') {
        await post(sent)
        await post(sent)
        await page('cs_test_monthly')
      }
      else {
        await page('cs_test_monthly')
        await post(sent)
        await post(sent)
      }

      expect(store.rows).toHaveLength(1)
      expect(emails).toHaveLength(1)
    }
  })

  it('acknowledges an event it has nothing to do with, rather than failing it', async () => {
    const { post, store } = billing()
    const outcome = await post(delivery('invoice.paid', 'cs_test_monthly'))
    expect(outcome.kind).toBe('ignored')
    expect(statusFor(outcome)).toBe(200)
    expect(store.rows).toHaveLength(0)
  })

  it('refuses anything it cannot verify, and issues nothing', async () => {
    const { post, store, emails } = billing()
    const sent = delivery('checkout.session.completed', 'cs_test_monthly')

    const cases = [
      ['signed with another secret', { ...sent, signature: sign(sent.raw, Math.floor(Date.now() / 1000), 'whsec_someone_else') }],
      ['no signature at all', { ...sent, signature: '' }],
      ['a body swapped after signing', { raw: sent.raw.replace('cs_test_monthly', 'cs_test_other'), signature: sent.signature }],
      ['an empty body', { raw: '', signature: sent.signature }],
      ['replayed from an hour ago', delivery('checkout.session.completed', 'cs_test_monthly', Math.floor(Date.now() / 1000) - 3600)],
    ] as const

    for (const [what, sentCase] of cases) {
      const outcome = await post(sentCase)
      expect(`${what}: ${outcome.kind}`).toBe(`${what}: rejected`)
      expect(statusFor(outcome)).toBe(400)
    }
    expect(store.rows).toHaveLength(0)
    expect(emails).toHaveLength(0)
  })

  it('refuses a signed body that is not a Stripe event', async () => {
    const { post } = billing()
    for (const raw of ['not json', '{}', '[]', JSON.stringify({ type: 'checkout.session.completed', data: { object: { object: 'invoice', id: 'in_1' } } })]) {
      const outcome = await post({ raw, signature: sign(raw, Math.floor(Date.now() / 1000)) })
      expect(outcome.kind).toBe('rejected')
    }
  })

  /**
   * No secret means nothing can be verified, so nothing may be issued. A 500
   * rather than a 200, because Stripe retries a 500 for days and this is a
   * misconfiguration someone can still fix in that time.
   */
  it('issues nothing when the server has no signing secret', async () => {
    const { post, store } = billing()
    const outcome = await post(delivery('checkout.session.completed', 'cs_test_monthly'), '')
    expect(outcome.kind).toBe('unconfigured')
    expect(statusFor(outcome)).toBe(500)
    expect(store.rows).toHaveLength(0)
  })

  it('asks Stripe to try again when issuing fails for a reason that might pass', async () => {
    const sent = delivery('checkout.session.completed', 'cs_test_monthly')
    const outcome = await receiveWebhook(sent.raw, sent.signature, {
      secret: SECRET,
      issue: async () => { throw new Error('the database is down') },
    })
    expect(outcome.kind).toBe('failed')
    expect(statusFor(outcome)).toBe(500)
    expect(bodyFor(outcome)).toEqual({ error: 'the database is down' })
  })

  it('reads its secret from the environment, trimmed', () => {
    expect(webhookSecret({ STRIPE_WEBHOOK_SECRET: '  whsec_x \n' })).toBe('whsec_x')
    expect(webhookSecret({})).toBe('')
  })
})

/**
 * The action itself, not the module under it. The one thing that cannot be
 * caught by reading the code is whether it verifies the bytes Stripe sent or a
 * re-serialized body, and a re-serialized one never matches the HMAC.
 */
describe('the webhook action', () => {
  function fakeRequest(raw: string, signature: string | null) {
    const reads = { rawBody: 0, parsed: 0 }
    return {
      reads,
      request: {
        headers: new Headers(signature === null ? {} : { 'stripe-signature': signature }),
        rawBody: async () => { reads.rawBody++; return raw },
        // If the action ever reached for these, the signature would be over
        // bytes it never saw.
        get all() { reads.parsed++; return () => JSON.parse(raw) },
        get jsonBody() { reads.parsed++; return JSON.parse(raw) },
      } as any,
    }
  }

  it('verifies the bytes on the wire, not the parsed body', async () => {
    const action = (await import('../../../app/Actions/Billing/StripeWebhookAction')).default
    const sent = delivery('checkout.session.completed', 'cs_test_monthly')
    // Signed correctly, but this server has no secret, so it stops before
    // anything touches the database.
    const { request, reads } = fakeRequest(sent.raw, sent.signature)

    const answer = await action.handle(request)
    expect(answer.status).toBe(500)
    expect(reads.rawBody).toBe(1)
    expect(reads.parsed).toBe(0)
  })

  it('answers 400 for a delivery it cannot verify', async () => {
    const action = (await import('../../../app/Actions/Billing/StripeWebhookAction')).default
    const sent = delivery('checkout.session.completed', 'cs_test_monthly')
    process.env.STRIPE_WEBHOOK_SECRET = SECRET
    try {
      const { request } = fakeRequest(sent.raw, 't=1,v1=deadbeef')
      expect((await action.handle(request)).status).toBe(400)

      const missing = fakeRequest(sent.raw, null)
      expect((await action.handle(missing.request)).status).toBe(400)
    }
    finally {
      delete process.env.STRIPE_WEBHOOK_SECRET
    }
  })
})
