import type { LicenseRecord } from '../Billing/licenses'
import { config } from '@stacksjs/config'
import type { TemplateVariables } from '@stacksjs/email'
import { mail, template } from '@stacksjs/email'
import { formatCents, planById, SIX_MONTHS_FREE } from '../Billing/plans'

/**
 * The email that carries license keys, from uplink@stacksjs.com: sent once
 * when a purchase becomes a license, and again whenever the buyer asks /license
 * for their keys (the resend variant of the same template). The key is also on
 * the thank-you page, which is where the Activate button in the email goes.
 */

export interface LicenseEmail {
  to: string
  subject: string
  variables: TemplateVariables
}

/** The thank-you page for the checkout that made a license: it shows the key and opens Uplink. */
export function licensePageUrl(license: LicenseRecord, origin = 'https://uplink.stacksjs.com'): string {
  return `${origin}/thanks?session_id=${encodeURIComponent(license.stripeCheckoutSessionId)}`
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

/**
 * The keys of an address again, in one email, for the licenses `activeFor`
 * found. It goes to the address on the license records and nowhere else:
 * there is no parameter for a recipient, so no caller can add one. Null when
 * there is nothing to send, which the caller must not reveal.
 */
export function licenseResendEmail(licenses: LicenseRecord[], origin?: string): LicenseEmail | null {
  const to = licenses.find(license => license.email)?.email
  if (!to)
    return null
  const mine = licenses.filter(license => license.email?.toLowerCase() === to.toLowerCase())
  const subject = mine.length > 1 ? 'Your Uplink license keys' : 'Your Uplink license key'
  // Newest last in the table, so the Activate button opens the latest one.
  const newest = mine[mine.length - 1]!
  return {
    to,
    subject,
    variables: {
      variant: 'resend',
      planName: planById(newest.plan)?.name ?? 'Uplink',
      licenseKey: newest.key,
      keys: mine.map(license => ({ planName: planById(license.plan)?.name ?? 'Uplink', key: license.key })),
      activateUrl: licensePageUrl(newest, origin),
      subject,
    },
  }
}

export async function sendLicenseEmail(license: LicenseRecord, activateUrl: string, freeMonths: boolean): Promise<void> {
  await deliver(licenseEmail(license, activateUrl, freeMonths))
}

export async function sendLicenseResendEmail(licenses: LicenseRecord[]): Promise<void> {
  const { siteOrigin } = await import('../Billing/checkout')
  await deliver(licenseResendEmail(licenses, siteOrigin()))
}

async function deliver(email: LicenseEmail | null): Promise<void> {
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
