import type { LicenseRecord, LicenseStore, LicenseStripe } from '../../../app/Billing/licenses'
import type { ResendBucket, ResendDeps } from '../../../app/Billing/license-resend'
import { describe, expect, it } from 'bun:test'
import { LIMITS, requestLicenseResend } from '../../../app/Billing/license-resend'
import { Licenses, normalizeEmail } from '../../../app/Billing/licenses'
import { licenseResendEmail } from '../../../app/Mail/LicenseEmail'

const NOW = 1_700_000_000

function record(overrides: Partial<LicenseRecord>): LicenseRecord {
  return { key: 'UPLK-RPWB-J93X-VPKN-XHNH', email: 'buyer@example.com', plan: 'lifetime', status: 'lifetime', stripeCustomerId: 'cus_1', stripeSubscriptionId: null, stripeCheckoutSessionId: 'cs_test_1', currentPeriodEnd: null, checkedAt: NOW, ...overrides }
}

/** A store that answers byEmail the way SQLite's LIKE does: ignoring case, `_` as a wildcard. */
function store(rows: LicenseRecord[]): LicenseStore {
  const like = (pattern: string) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '.')}$`, 'i')
  return {
    byKey: async key => rows.find(r => r.key === key) ?? null,
    byEmail: async email => rows.filter(r => r.email && like(email).test(r.email)),
    bySession: async id => rows.find(r => r.stripeCheckoutSessionId === id) ?? null,
    create: async (license) => { rows.push(license) },
    update: async (key, patch) => { Object.assign(rows.find(r => r.key === key)!, patch) },
  }
}

const noStripe: LicenseStripe = {
  checkoutSession: async () => { throw new Error('not used') },
  subscription: async () => { throw new Error('not used') },
}

const LIFETIME = record({ key: 'UPLK-AAAA-BBBB-CCCC-DDDD', email: 'Buyer@Example.com', stripeCheckoutSessionId: 'cs_test_life' })
const MONTHLY = record({ key: 'UPLK-EEEE-FFFF-GGGG-HHHH', email: 'buyer@example.com', plan: 'monthly', status: 'active', stripeSubscriptionId: 'sub_1', stripeCheckoutSessionId: 'cs_test_month', currentPeriodEnd: NOW + 86400 })
const CANCELLED = record({ key: 'UPLK-JJJJ-KKKK-LLLL-MMMM', email: 'gone@example.com', plan: 'monthly', status: 'canceled', stripeSubscriptionId: 'sub_2', stripeCheckoutSessionId: 'cs_test_gone' })
const LOOKALIKE = record({ key: 'UPLK-NNNN-PPPP-QQQQ-RRRR', email: 'buyerx@example.com', stripeCheckoutSessionId: 'cs_test_look' })

/** Limits that count like the real ones, per bucket and identity. */
function limiter() {
  const counts = new Map<string, number>()
  return async (bucket: ResendBucket, identity = '203.0.113.7') => {
    const at = `${bucket}:${identity}`
    counts.set(at, (counts.get(at) ?? 0) + 1)
    return counts.get(at)! <= LIMITS[bucket].max
  }
}

function harness(rows: LicenseRecord[] = [LIFETIME, MONTHLY, CANCELLED, LOOKALIKE]) {
  const licenses = new Licenses(store(rows), noStripe, () => NOW)
  const sent: LicenseRecord[][] = []
  const lookedUp: string[] = []
  const deps: ResendDeps = {
    allow: limiter(),
    active: async (email) => {
      lookedUp.push(email)
      return licenses.activeFor(email)
    },
    send: async (found) => { sent.push(found) },
  }
  return { deps, sent, lookedUp }
}

describe('resending a license key', () => {
  it('answers an unknown address exactly as a known one, and sends it nothing', async () => {
    const unknown = harness()
    const known = harness()
    const a = await requestLicenseResend('nobody@example.com', unknown.deps)
    const b = await requestLicenseResend('buyer@example.com', known.deps)
    await Promise.all([a.delivery, b.delivery])
    expect(a.outcome).toBe('accepted')
    expect(b.outcome).toBe(a.outcome)
    expect(unknown.sent).toEqual([])
    expect(known.sent).toHaveLength(1)
  })

  it('sends one email carrying every good key for the address, however it is typed', async () => {
    const { deps, sent } = harness()
    const { delivery } = await requestLicenseResend('  BUYER@example.COM ', deps)
    await delivery
    expect(sent).toHaveLength(1)
    expect(sent[0]!.map(l => l.key)).toEqual([LIFETIME.key, MONTHLY.key])
  })

  it('leaves out a cancelled license, and sends nothing when that is all there is', async () => {
    const { deps, sent } = harness()
    const { outcome, delivery } = await requestLicenseResend('gone@example.com', deps)
    await delivery
    expect(outcome).toBe('accepted')
    expect(sent).toEqual([])
  })

  it('never sends an address another one only resembles', async () => {
    // `_` is a LIKE wildcard, so the store hands back buyerx@ for buyer_@; it must not be sent.
    const { deps, sent } = harness()
    await (await requestLicenseResend('buyer_@example.com', deps)).delivery
    expect(sent).toEqual([])
  })

  it('refuses what is not an address before looking anything up', async () => {
    const { deps, lookedUp } = harness()
    for (const input of ['', 'buyer', 'buyer@example', 'a b@example.com', '%@example.com', `${'a'.repeat(250)}@example.com`, 42, null, ['buyer@example.com']])
      expect((await requestLicenseResend(input, deps)).outcome).toBe('invalid')
    expect(lookedUp).toEqual([])
  })

  it('limits each address, found or not, however many IPs ask', async () => {
    const { deps, sent } = harness()
    const allow = limiter()
    let ip = 0
    const fromNewIp: ResendDeps = { ...deps, allow: (bucket, identity) => allow(bucket, bucket === 'ip' ? `198.51.100.${++ip}` : identity) }
    const outcomes = []
    for (let i = 0; i < LIMITS.email.max + 2; i++) {
      const { outcome, delivery } = await requestLicenseResend('buyer@example.com', fromNewIp)
      await delivery
      outcomes.push(outcome)
    }
    expect(outcomes.slice(0, LIMITS.email.max).every(o => o === 'accepted')).toBe(true)
    expect(outcomes.slice(LIMITS.email.max)).toEqual(['limited', 'limited'])
    expect(sent).toHaveLength(LIMITS.email.max)
    // An unknown address runs out the same way, so the limit says nothing either.
    for (let i = 0; i < LIMITS.email.max; i++)
      await requestLicenseResend('nobody@example.com', fromNewIp)
    expect((await requestLicenseResend('nobody@example.com', fromNewIp)).outcome).toBe('limited')
  })

  it('limits each IP, counting junk too', async () => {
    const { deps } = harness()
    for (let i = 0; i < LIMITS.ip.max; i++)
      await requestLicenseResend(i % 2 ? `someone${i}@example.com` : 'not an address', deps)
    expect((await requestLicenseResend('buyer@example.com', deps)).outcome).toBe('limited')
  })

  it('never lets a failed send escape, and never logs the address', async () => {
    const { deps } = harness()
    const logged: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => { logged.push(args.join(' ')) }
    try {
      const { outcome, delivery } = await requestLicenseResend('buyer@example.com', { ...deps, send: async () => { throw new Error('SMTP is down') } })
      await delivery
      expect(outcome).toBe('accepted')
    }
    finally {
      console.error = original
    }
    expect(logged.join('\n')).toContain('SMTP is down')
    expect(logged.join('\n')).not.toContain('buyer@')
  })
})

describe('the resend email', () => {
  it('goes to the address on the licenses, with each key and the newest one to activate', () => {
    const email = licenseResendEmail([LIFETIME, MONTHLY], 'https://uplink.stacksjs.com')!
    expect(email.to).toBe('Buyer@Example.com')
    expect(email.subject).toBe('Your Uplink license keys')
    expect(email.variables).toMatchObject({
      variant: 'resend',
      keys: [{ planName: 'Lifetime', key: LIFETIME.key }, { planName: 'Monthly', key: MONTHLY.key }],
      activateUrl: 'https://uplink.stacksjs.com/thanks?session_id=cs_test_month',
    })
  })

  it('says key, not keys, for one', () => {
    expect(licenseResendEmail([LIFETIME])!.subject).toBe('Your Uplink license key')
  })

  it('is nothing without a license that has an address', () => {
    expect(licenseResendEmail([])).toBeNull()
    expect(licenseResendEmail([record({ email: null })])).toBeNull()
  })
})

describe('normalizeEmail', () => {
  it('trims and lower-cases', () => {
    expect(normalizeEmail(' A.B+uplink@Example.COM ')).toBe('a.b+uplink@example.com')
  })
})
