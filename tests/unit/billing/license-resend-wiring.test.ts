import { describe, expect, it } from 'bun:test'
import { template } from '@stacksjs/email'
import { allow } from '../../../app/Actions/License/ResendLicenseAction'
import { LIMITS } from '../../../app/Billing/license-resend'
import { licenseEmail, licenseResendEmail } from '../../../app/Mail/LicenseEmail'

const LIFETIME = { key: 'UPLK-AAAA-BBBB-CCCC-DDDD', email: 'buyer@example.com', plan: 'lifetime' as const, status: 'lifetime', stripeCustomerId: 'cus_1', stripeSubscriptionId: null, stripeCheckoutSessionId: 'cs_test_life', currentPeriodEnd: null, checkedAt: null }
const MONTHLY = { ...LIFETIME, key: 'UPLK-EEEE-FFFF-GGGG-HHHH', plan: 'monthly' as const, status: 'active', stripeCheckoutSessionId: 'cs_test_month', currentPeriodEnd: 1_800_000_000 }

describe('the resend limits, on the framework\'s own limiter', () => {
  it('turns its 429 into a no once an address has had its share', async () => {
    const identity = `limit-${crypto.randomUUID()}@example.com`
    for (let i = 0; i < LIMITS.email.max; i++)
      expect(await allow('email', identity)).toBe(true)
    expect(await allow('email', identity)).toBe(false)
    expect(await allow('email', `other-${identity}`)).toBe(true)
  })
})

describe('the license email template', () => {
  it('renders the resend variant with every key and no renewal promise', async () => {
    const email = licenseResendEmail([LIFETIME, MONTHLY])!
    const { html, text } = await template('license', { variables: email.variables })
    expect(html).toContain('Here are your Uplink keys again.')
    expect(html).toContain(LIFETIME.key)
    expect(html).toContain(MONTHLY.key)
    expect(html).toContain('https://uplink.stacksjs.com/thanks?session_id=cs_test_month')
    expect(html).not.toContain('renews')
    expect(`${html}${text}`).not.toMatch(/[–—]/)
  })

  it('still renders the purchase email as before, now with the way back to a lost key', async () => {
    const email = licenseEmail(MONTHLY, 'https://uplink.stacksjs.com/thanks?session_id=cs_test_month', false)!
    const { html } = await template('license', { variables: email.variables })
    expect(html).toContain('You have Uplink Monthly.')
    expect(html).toContain(MONTHLY.key)
    expect(html).toContain('renews on')
    expect(html).toContain('https://uplink.stacksjs.com/license')
    expect(html).not.toMatch(/[–—]/)
  })
})
