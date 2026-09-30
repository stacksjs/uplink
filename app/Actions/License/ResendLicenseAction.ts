import type { RequestInstance } from '@stacksjs/types'
import type { ResendBucket, ResendOutcome } from '../../Billing/license-resend'
import { Action } from '@stacksjs/actions'
import { rateLimit, response } from '@stacksjs/router'
import { LIMITS, requestLicenseResend } from '../../Billing/license-resend'
import { licenses } from '../../Billing/license-store'
import { sendLicenseResendEmail } from '../../Mail/LicenseEmail'

/**
 * POST /api/license/resend { email } - email the keys bought with an address
 * to that address. The /license page posts here as a plain form (CSRF-checked:
 * a browser with a cookie is exactly who a forged form would ride), and gets
 * sent back to /license with the outcome; a JSON caller gets JSON.
 *
 * Whether the address bought anything is never part of the answer. See
 * app/Billing/license-resend.ts for why, and for the limits.
 */

/** Take a slot from the framework's limiter; false instead of its 429. */
export async function allow(bucket: ResendBucket, identity?: string): Promise<boolean> {
  const { max, windowSeconds } = LIMITS[bucket]
  try {
    await rateLimit(`license-resend-${bucket}`, max, identity === undefined ? {} : { identity }).over(windowSeconds)
    return true
  }
  catch (error) {
    if ((error as { status?: number }).status === 429)
      return false
    throw error
  }
}

const SAID: Record<ResendOutcome, { status: 202 | 422 | 429, message: string }> = {
  accepted: { status: 202, message: 'If that address bought Uplink, the key is on its way. It can take a few minutes.' },
  invalid: { status: 422, message: 'That does not look like an email address.' },
  limited: { status: 429, message: 'That is a lot of requests. Try again in an hour.' },
}

/** Where the form lands: the same page, told only which of the three answers it got. */
const FORM_RETURN: Record<ResendOutcome, string> = {
  accepted: '/license?sent=1',
  invalid: '/license?error=invalid',
  limited: '/license?error=busy',
}

export default new Action({
  name: 'Resend License',
  description: 'Email the license keys bought with an address to that address',
  method: 'POST',

  async handle(request: RequestInstance) {
    const { outcome, delivery } = await requestLicenseResend(request.get('email'), {
      allow,
      active: async email => (await licenses()).activeFor(email),
      send: sendLicenseResendEmail,
    })
    // Deliberately not awaited: how long the answer takes must not depend on
    // whether an email went out. `delivery` never rejects.
    void delivery

    const contentType = request.headers.get('content-type') ?? ''
    if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data'))
      return response.redirect(FORM_RETURN[outcome], 303)

    const { status, message } = SAID[outcome]
    return response.json(outcome === 'accepted' ? { ok: true, message } : { ok: false, error: message }, status)
  },
})
