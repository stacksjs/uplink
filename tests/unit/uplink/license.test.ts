import type { LicenseState } from '../../../app/Uplink/license'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkLicenseKey, describeLicense, isLicensed, keyFromLink, normalizeKey, OFFLINE_GRACE_MS, parseLicenseState, portalUrl, readLicenseState, writeLicenseState } from '../../../app/Uplink/license'

const NOW = Date.parse('2026-10-01T12:00:00Z')
const KEY = 'UPLK-ABCD-EFGH-JKLM-NPQR'

function state(overrides: Partial<LicenseState> = {}): LicenseState {
  return { valid: true, plan: 'monthly', status: 'active', email: 'a@example.com', expiresAt: '2026-10-28T12:00:00Z', endsAtPeriodEnd: false, checkedAt: NOW, ...overrides }
}

function answering(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
}

describe('isLicensed', () => {
  it('holds while the last good answer is under two weeks old, so it works off-grid', () => {
    expect(isLicensed(state(), NOW + OFFLINE_GRACE_MS - 1)).toBe(true)
    expect(isLicensed(state(), NOW + OFFLINE_GRACE_MS + 1)).toBe(false)
  })

  it('believes a "not valid" straight away', () => {
    expect(isLicensed(state({ valid: false, status: 'canceled' }), NOW)).toBe(false)
    expect(isLicensed(null, NOW)).toBe(false)
  })
})

describe('describeLicense', () => {
  it('says what a person needs to know about their plan', () => {
    expect(describeLicense(state(), NOW)).toBe('Monthly, renews Oct 28, 2026.')
    expect(describeLicense(state({ endsAtPeriodEnd: true }), NOW)).toBe('Monthly, cancelled. Ends Oct 28, 2026.')
    expect(describeLicense(state({ plan: 'lifetime', expiresAt: null, status: 'lifetime' }), NOW)).toBe('Lifetime.')
    expect(describeLicense(state({ status: 'past_due' }), NOW)).toContain('payment overdue')
    expect(describeLicense(state({ valid: false, status: 'canceled' }), NOW)).toBe('Monthly ended. Choose a plan to keep using Uplink.')
    expect(describeLicense(state(), NOW + OFFLINE_GRACE_MS + 1)).toContain('Connect to the internet once')
    expect(describeLicense(null)).toBe('Not activated yet.')
  })
})

describe('checkLicenseKey', () => {
  it('keeps the server\'s answer with when it was given', async () => {
    const result = await checkLicenseKey(KEY, answering(200, { valid: true, plan: 'yearly', status: 'active', email: 'a@example.com', expiresAt: '2027-09-28T00:00:00.000Z', endsAtPeriodEnd: false }), NOW)
    expect(result).toEqual({ kind: 'answered', state: { valid: true, plan: 'yearly', status: 'active', email: 'a@example.com', expiresAt: '2027-09-28T00:00:00.000Z', endsAtPeriodEnd: false, checkedAt: NOW } })
  })

  it('tells an unknown key from an unreachable server', async () => {
    expect(await checkLicenseKey(KEY, answering(404, { valid: false }))).toEqual({ kind: 'unknown-key' })
    expect((await checkLicenseKey(KEY, answering(502, 'Bad Gateway'))).kind).toBe('unreachable')
    const offline = (async () => { throw new TypeError('Unable to connect') }) as unknown as typeof fetch
    expect(await checkLicenseKey(KEY, offline)).toEqual({ kind: 'unreachable', error: 'Unable to connect' })
  })
})

describe('portalUrl', () => {
  it('only ever hands back an https link', async () => {
    expect(await portalUrl(KEY, answering(200, { url: 'https://billing.stripe.com/p/session/x' }))).toBe('https://billing.stripe.com/p/session/x')
    expect(await portalUrl(KEY, answering(200, { url: 'javascript:alert(1)' }))).toBeNull()
    expect(await portalUrl(KEY, answering(404, { error: 'no' }))).toBeNull()
  })
})

describe('activation links', () => {
  it('read the key from uplink://activate', () => {
    expect(keyFromLink(`uplink://activate?key=${encodeURIComponent(KEY)}`)).toBe(KEY)
    expect(keyFromLink('uplink://activate?key=abcd efgh jkLm npqr')).toBe(KEY)
    expect(keyFromLink(`uplink://something-else?key=${KEY}`)).toBeNull()
    expect(keyFromLink(`https://evil.example/activate?key=${KEY}`)).toBeNull()
    expect(normalizeKey('UPLK-0000-1111-2222-3333')).toBeNull()
  })
})

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'uplink-license-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe('the cached answer', () => {
  it('reads back exactly what it wrote', () => {
    const path = join(tempDir(), 'license.json')
    writeLicenseState(state(), path)
    expect(readLicenseState(path)).toEqual(state())

    writeLicenseState(state({ plan: 'lifetime', expiresAt: null, email: null }), path)
    expect(readLicenseState(path)).toEqual(state({ plan: 'lifetime', expiresAt: null, email: null }))
  })

  /**
   * 0.1.4 shipped before the version existed, so a Mac activated then has an
   * unstamped file. Refusing it would ask exactly the wrong people, the ones
   * off-grid, to connect. The shape has not changed, so it is this version.
   */
  it('accepts the unstamped file 0.1.4 wrote', () => {
    const { version, ...unstamped } = { version: 1, ...state() }
    expect(version).toBe(1)
    expect(parseLicenseState(unstamped)).toEqual(state())
  })

  it('refuses a version it does not understand rather than reading it', () => {
    expect(parseLicenseState({ ...state(), version: 2 })).toBeNull()
    expect(parseLicenseState({ ...state(), version: 0 })).toBeNull()
    expect(parseLicenseState({ ...state(), version: 'one' })).toBeNull()
  })

  /**
   * The file entitles a Mac for two weeks without reaching the server, so
   * anything it is wrong about makes the whole file not evidence. Null just
   * means the launch asks the server, which it does anyway.
   */
  it('refuses a file that is wrong about any field', () => {
    expect(parseLicenseState({ ...state(), valid: 'true' })).toBeNull()
    expect(parseLicenseState({ ...state(), checkedAt: '123' })).toBeNull()
    expect(parseLicenseState({ ...state(), checkedAt: Number.NaN })).toBeNull()
    expect(parseLicenseState({ ...state(), plan: 'enterprise' })).toBeNull()
    expect(parseLicenseState({ ...state(), status: 42 })).toBeNull()
    expect(parseLicenseState({ ...state(), endsAtPeriodEnd: 'no' })).toBeNull()
    expect(parseLicenseState({ ...state(), email: 5 })).toBeNull()
    expect(parseLicenseState({ ...state(), expiresAt: 0 })).toBeNull()
    // And the shapes that are not a state at all.
    for (const body of [null, undefined, [], 'UPLK', 7, {}])
      expect(parseLicenseState(body)).toBeNull()
  })

  it('survives a file that is missing or not JSON', () => {
    const path = join(tempDir(), 'license.json')
    expect(readLicenseState(path)).toBeNull()
    Bun.write(path, '{ not json')
    expect(readLicenseState(path)).toBeNull()
  })

  /**
   * `checkLicenseKey` writes what the server said, so a plan name this build
   * does not know must be refused there rather than stored and refused on the
   * next read, which would cost the Mac its cache for no reason.
   */
  it('never stores a plan it would refuse to read back', async () => {
    const result = await checkLicenseKey(KEY, answering(200, { valid: true, plan: 'enterprise', status: 'active', email: null, expiresAt: null, endsAtPeriodEnd: false }), NOW)
    expect(result.kind).toBe('answered')
    if (result.kind !== 'answered')
      return
    expect(result.state.plan).toBeNull()

    const path = join(tempDir(), 'license.json')
    writeLicenseState(result.state, path)
    expect(readLicenseState(path)).toEqual(result.state)
  })
})
