import type { LicenseRecord } from './licenses'
import { normalizeEmail } from './licenses'

/**
 * "Email me my license key again": what /license asks for.
 *
 * Anyone can ask for any address, so this is shaped around two attacks rather
 * than around the buyer:
 *
 * - Account enumeration. The answer never depends on whether the address
 *   bought Uplink. The lookup and the send happen after the answer is decided,
 *   in `delivery`, which the caller does not wait for, so not even the time it
 *   takes to answer says whether an email went out.
 * - Mail bombing a buyer. Every request counts against its IP, and every valid
 *   address against itself, whether or not it bought anything. A buyer gets at
 *   most `LIMITS.email.max` of these an hour however many machines ask.
 *
 * The keys only ever go to the address on the license records: `send` takes
 * the records, not an address, so there is no way to direct them elsewhere.
 */

export type ResendOutcome = 'accepted' | 'invalid' | 'limited'

export const LIMITS = {
  /** Per client IP, counted before anything else, so junk costs the sender too. */
  ip: { max: 10, windowSeconds: 60 * 60 },
  /** Per address, found or not, so the answer cannot be probed through the limit either. */
  email: { max: 3, windowSeconds: 60 * 60 },
} as const

export type ResendBucket = keyof typeof LIMITS

export interface ResendDeps {
  /**
   * Take a slot in a bucket; false once it is full. The IP bucket passes no
   * identity: the rate limiter reads the client address from the request.
   */
  allow: (bucket: ResendBucket, identity?: string) => Promise<boolean>
  /** The licenses bought with an address that are good now (`Licenses.activeFor`). */
  active: (email: string) => Promise<LicenseRecord[]>
  /** Send those licenses' keys to the address on them. */
  send: (licenses: LicenseRecord[]) => Promise<void>
}

export interface ResendRequest {
  outcome: ResendOutcome
  /**
   * The lookup and the send, already running. Never rejects: a failure is
   * logged without the address. Tests await it; the action does not.
   */
  delivery: Promise<void>
}

const NOTHING = Promise.resolve()

export async function requestLicenseResend(rawEmail: unknown, deps: ResendDeps): Promise<ResendRequest> {
  if (!await deps.allow('ip'))
    return { outcome: 'limited', delivery: NOTHING }

  const email = normalizeEmail(rawEmail)
  if (!email)
    return { outcome: 'invalid', delivery: NOTHING }

  if (!await deps.allow('email', email))
    return { outcome: 'limited', delivery: NOTHING }

  const delivery = (async () => {
    const licenses = await deps.active(email)
    if (licenses.length)
      await deps.send(licenses)
  })().catch((error) => {
    console.error(`[license-resend] could not resend keys: ${error instanceof Error ? error.message : String(error)}`)
  })

  return { outcome: 'accepted', delivery }
}
