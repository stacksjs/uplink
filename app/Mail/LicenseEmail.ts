import type { LicenseRecord } from '../Billing/licenses'
import { config } from '@stacksjs/config'
import { mail, template } from '@stacksjs/email'
import { formatCents, planById, SIX_MONTHS_FREE } from '../Billing/plans'

/**
 * The email that carries a new license key: sent once, when a purchase
 * becomes a license, from uplink@stacksjs.com. The key is also on the
 * thank-you page, which is where the Activate button in the email goes.
 */

export interface LicenseEmail {
  to: string
  subject: string
  variables: Record<string, string>
}

/** What renewal means for this license, in one sentence. */
export function renewalLine(license: LicenseRecord, freeMonths: boolean): string {
  const plan = planById(license.plan)
  if (!plan?.interval)
    return 'Paid once. It never renews.'
  if (freeMonths)
    return `Your first ${SIX_MONTHS_FREE.months} months are free. After that it is ${formatCents(plan.priceCents)} a month, so add a card in Manage before then to keep it.`
  const date = license.currentPeriodEnd
    ? new Date(license.currentPeriodEnd * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null
  return date ? `It renews on ${date} for ${formatCents(plan.priceCents)} until you cancel.` : `It renews every ${plan.interval} until you cancel.`
}

/** The email for a license, without sending it: what the tests check. */
export function licenseEmail(license: LicenseRecord, activateUrl: string, freeMonths: boolean): LicenseEmail | null {
  if (!license.email)
    return null
  const planName = planById(license.plan)?.name ?? 'Uplink'
  return {
    to: license.email,
    subject: 'Your Uplink license key',
    variables: {
      planName,
      licenseKey: license.key,
      activateUrl,
      renewal: renewalLine(license, freeMonths),
      subject: 'Your Uplink license key',
    },
  }
}

export async function sendLicenseEmail(license: LicenseRecord, activateUrl: string, freeMonths: boolean): Promise<void> {
  const email = licenseEmail(license, activateUrl, freeMonths)
  if (!email)
    return
  const { html, text } = await template('license', { variables: email.variables })
  if (!html)
    throw new Error('The license email template rendered nothing.')
  await mail.sendOrFail({
    from: { name: 'Uplink', address: config.email.from?.address || 'uplink@stacksjs.com' },
    to: email.to,
    subject: email.subject,
    html,
    text,
  })
}
