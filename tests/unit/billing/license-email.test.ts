import type { LicenseRecord } from '../../../app/Billing/licenses'
import { describe, expect, it } from 'bun:test'
import { licenseEmail, renewalLine } from '../../../app/Mail/LicenseEmail'

function license(overrides: Partial<LicenseRecord> = {}): LicenseRecord {
  return { key: 'UPLK-RPWB-J93X-VPKN-XHNH', email: 'a@example.com', plan: 'monthly', status: 'active', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', stripeCheckoutSessionId: 'cs_test_1', currentPeriodEnd: Date.parse('2026-10-29T12:00:00Z') / 1000, checkedAt: null, ...overrides }
}

describe('license email', () => {
  it('carries the key, the plan and a way to activate', () => {
    const email = licenseEmail(license(), 'https://uplink.stacksjs.com/thanks?session_id=cs_test_1', false)
    expect(email).toMatchObject({ to: 'a@example.com', subject: 'Your Uplink license key' })
    expect(email!.variables).toMatchObject({ planName: 'Monthly', licenseKey: 'UPLK-RPWB-J93X-VPKN-XHNH', activateUrl: 'https://uplink.stacksjs.com/thanks?session_id=cs_test_1' })
  })

  it('says what renewal means for each kind of purchase', () => {
    expect(renewalLine(license(), false)).toBe('It renews on October 29, 2026 for $1.99 until you cancel.')
    expect(renewalLine(license(), true)).toContain('first 6 months are free. After that it is $1.99 a month')
    expect(renewalLine(license({ plan: 'lifetime', currentPeriodEnd: null }), false)).toBe('Paid once. It never renews.')
  })

  it('is not sent without an address', () => {
    expect(licenseEmail(license({ email: null }), 'https://x', false)).toBeNull()
  })
})
