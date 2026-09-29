import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { DATA_DIR } from './settings'

/**
 * The Mac side of licensing: the key in the Keychain, and the last answer the
 * license server gave, kept so Uplink keeps working off-grid.
 *
 * Uplink answers texts only while licensed. It asks the server
 * (POST /api/license/check on uplink.stacksjs.com) at launch, on activation
 * and every few hours. When the server cannot be reached - a Mac on a boat, a
 * cabin with a satellite dish that is down - the last good answer stands for
 * two weeks. A server that answers "not valid" (a cancelled plan, a refund)
 * is believed straight away.
 */

export const LICENSE_SERVER = (process.env.UPLINK_LICENSE_SERVER || 'https://uplink.stacksjs.com').replace(/\/+$/, '')
export const PRICING_URL = `${LICENSE_SERVER}/pricing`

/** How often a licensed Mac asks again. */
export const RECHECK_MS = 6 * 60 * 60 * 1000
/** How long the last good answer stands without reaching the server. */
export const OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000

const KEYCHAIN_SERVICE = 'com.stacksjs.uplink'
const KEYCHAIN_ACCOUNT = 'license-key'
const CACHE_PATH = join(DATA_DIR, 'license.json')

/**
 * Stamped into the cache file, and bumped whenever `LicenseState` changes
 * shape. A file carrying any other version is refused rather than read.
 *
 * Refusing costs one request to the license server, which the launch makes
 * anyway. Reading an older shape as though it were this one is how a Mac ends
 * up entitled for two weeks on a field that used to mean something else, with
 * nothing in the file to say which build wrote it.
 */
const STATE_VERSION = 1

export const PLANS = ['monthly', 'yearly', 'lifetime'] as const
export type Plan = typeof PLANS[number]

export interface LicenseState {
  valid: boolean
  plan: Plan | null
  status: string
  email: string | null
  /** ISO time the paid period ends; null for lifetime. */
  expiresAt: string | null
  /** Cancelled: it will not renew. */
  endsAtPeriodEnd: boolean
  /** Epoch ms of the server's answer. */
  checkedAt: number
}

export type CheckResult =
  | { kind: 'answered', state: LicenseState }
  | { kind: 'unknown-key' }
  | { kind: 'unreachable', error: string }

/** Whether Uplink may answer texts now, from the last answer it has. */
export function isLicensed(state: LicenseState | null, now = Date.now()): boolean {
  return Boolean(state?.valid) && now - (state?.checkedAt ?? 0) < OFFLINE_GRACE_MS
}

/** The one line the menubar shows for a license. */
export function describeLicense(state: LicenseState | null, now = Date.now()): string {
  if (!state)
    return 'Not activated yet.'
  const plan = state.plan ? state.plan.charAt(0).toUpperCase() + state.plan.slice(1) : 'Uplink'
  const date = state.expiresAt ? new Date(state.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''
  if (!state.valid)
    return state.status === 'canceled' ? `${plan} ended. Choose a plan to keep using Uplink.` : `${plan} is not paid up (${state.status}).`
  if (!isLicensed(state, now))
    return `${plan}, not confirmed for two weeks. Connect to the internet once to keep using Uplink.`
  if (state.plan === 'lifetime')
    return 'Lifetime.'
  if (state.status === 'past_due')
    return `${plan}, payment overdue. Update your card in Manage Subscription.`
  if (state.endsAtPeriodEnd)
    return `${plan}, cancelled. Ends ${date}.`
  return date ? `${plan}, renews ${date}.` : `${plan}.`
}

/** Ask the license server where a key stands. */
export async function checkLicenseKey(key: string, fetcher: typeof fetch = fetch, now = Date.now()): Promise<CheckResult> {
  try {
    const response = await fetcher(`${LICENSE_SERVER}/api/license/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 404)
      return { kind: 'unknown-key' }
    if (!response.ok)
      return { kind: 'unreachable', error: `The license server answered ${response.status}.` }
    const body = await response.json() as Omit<LicenseState, 'checkedAt'>
    return {
      kind: 'answered',
      state: {
        valid: body.valid === true,
        plan: planOf(body.plan),
        status: String(body.status ?? ''),
        email: body.email ?? null,
        expiresAt: body.expiresAt ?? null,
        endsAtPeriodEnd: body.endsAtPeriodEnd === true,
        checkedAt: now,
      },
    }
  }
  catch (error) {
    return { kind: 'unreachable', error: error instanceof Error ? error.message : String(error) }
  }
}

/** A one-time link into the Stripe customer portal for this key's subscription. */
export async function portalUrl(key: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetcher(`${LICENSE_SERVER}/api/billing/portal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok)
      return null
    const body = await response.json() as { url?: string }
    return typeof body.url === 'string' && body.url.startsWith('https://') ? body.url : null
  }
  catch {
    return null
  }
}

/** A key as typed or pasted: case, spaces and a missing prefix forgiven. */
export function normalizeKey(input: unknown): string | null {
  if (typeof input !== 'string')
    return null
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^UPLK/, '')
  if (!/^[A-HJ-NP-Z2-9]{16}$/.test(compact))
    return null
  return `UPLK-${compact.match(/.{4}/g)!.join('-')}`
}

/** The key from an `uplink://activate?key=...` link, or null. */
export function keyFromLink(link: unknown): string | null {
  if (typeof link !== 'string')
    return null
  try {
    const url = new URL(link)
    if (url.protocol !== 'uplink:' || (url.hostname || url.pathname.replace(/^\/+/, '')) !== 'activate')
      return null
    return normalizeKey(url.searchParams.get('key'))
  }
  catch {
    return null
  }
}

export function readLicenseKey(): string | null {
  const result = Bun.spawnSync(['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'], { stderr: 'ignore' })
  return result.exitCode === 0 ? normalizeKey(result.stdout.toString().trim()) : null
}

export function writeLicenseKey(key: string): void {
  const result = Bun.spawnSync(['security', 'add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-l', 'Uplink license key', '-w', key], { stderr: 'pipe' })
  if (result.exitCode !== 0)
    throw new Error(`Could not save the license key to the Keychain: ${result.stderr.toString().trim()}`)
}

export function readLicenseState(path = CACHE_PATH): LicenseState | null {
  if (!existsSync(path))
    return null
  try {
    return parseLicenseState(JSON.parse(readFileSync(path, 'utf8')))
  }
  catch {
    // Not JSON at all.
    return null
  }
}

/**
 * The cached answer, or null for anything this build cannot vouch for.
 *
 * Null is not a failure worth reporting: the key is in the Keychain, the
 * launch asks the server, and an online Mac never notices. A Mac that is
 * offline at the moment it upgrades is asked to connect once, which is the
 * right thing to ask and the wrong thing to guess.
 */
export function parseLicenseState(input: unknown): LicenseState | null {
  if (!input || typeof input !== 'object')
    return null
  const state = input as Record<string, unknown>

  // 0.1.4 wrote no version and the shape has not changed since, so an
  // unstamped file is this one. Refusing those would have locked out exactly
  // the Macs this cache exists for, the ones that are not online.
  const version = state.version === undefined ? STATE_VERSION : state.version
  if (version !== STATE_VERSION)
    return null

  // `valid` and `checkedAt` are the two that decide whether Uplink answers at
  // all, and the rest is what the menubar prints. A file that is wrong about
  // any of them was not written by this build, so none of it is evidence.
  if (typeof state.valid !== 'boolean' || typeof state.checkedAt !== 'number' || !Number.isFinite(state.checkedAt))
    return null
  if (state.plan !== null && planOf(state.plan) === null)
    return null
  if (typeof state.status !== 'string' || typeof state.endsAtPeriodEnd !== 'boolean')
    return null
  if (state.email !== null && typeof state.email !== 'string')
    return null
  if (state.expiresAt !== null && typeof state.expiresAt !== 'string')
    return null

  return {
    valid: state.valid,
    plan: planOf(state.plan),
    status: state.status,
    email: state.email,
    expiresAt: state.expiresAt,
    endsAtPeriodEnd: state.endsAtPeriodEnd,
    checkedAt: state.checkedAt,
  }
}

function planOf(value: unknown): Plan | null {
  return typeof value === 'string' && (PLANS as readonly string[]).includes(value) ? value as Plan : null
}

export function writeLicenseState(state: LicenseState | null, path = CACHE_PATH): void {
  mkdirSync(join(path, '..'), { recursive: true })
  // The version leads, so the first line of the file says which build's
  // meaning the rest carries.
  const body = state === null ? null : { version: STATE_VERSION, ...state }
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
}
