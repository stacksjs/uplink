import type { UplinkConfig } from './config'
import type { Engine, ProbeReason } from './engine'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { allEngines } from './engines'
import { formatDuration } from './format'
import { MessagesDb } from './messages-db'
import { servicePaths, serviceState } from './service'

/**
 * Setup checks, shared by `buddy uplink:doctor` and the dashboard. Each one
 * says what is wrong and exactly what a person at the Mac has to do - most of
 * these are permissions only a human can grant.
 */

export interface Check {
  name: string
  ok: boolean
  detail: string
  fix?: string
  /**
   * Shown, but not counted towards whether Uplink is ready. An engine the
   * person has not selected belongs here: it is information, not a problem.
   */
  informational?: boolean
}

/** Whether every check that counts passed. */
export function checksPass(checks: Check[]): boolean {
  return checks.every(check => check.ok || check.informational)
}

export interface Heartbeat {
  pid: number
  startedAt: number
  lastPollAt: number | null
  lastError: string | null
  allowed: string[]
  own: string[]
  active: Array<{ prompt: string, startedAt: number, lastActivity: string | null, queued: number }>
  writtenAt: number
}

export function heartbeatPath(appDir: string): string {
  return join(appDir, 'storage', 'uplink', 'heartbeat.json')
}

export async function readHeartbeat(appDir: string): Promise<Heartbeat | null> {
  const file = Bun.file(heartbeatPath(appDir))
  if (!(await file.exists()))
    return null
  try {
    return await file.json() as Heartbeat
  }
  catch {
    return null
  }
}

/** A heartbeat older than this means the watcher is not really running. */
const HEARTBEAT_STALE_MS = 2 * 60_000

/**
 * What to do about an engine that cannot answer, which depends on why.
 *
 * A missing CLI used to be reported inside the sign-in step, so the person was
 * told to run a command that does not exist either. These are three problems
 * with three different next steps.
 */
function engineFix(engine: Engine, reason: ProbeReason): string {
  if (reason === 'missing')
    return `Install it: ${engine.install.command} (see ${engine.install.url}), then ./buddy uplink:restart`

  if (reason === 'signed-out') {
    return engine.id === 'claude'
      ? 'Run claude setup-token, copy the WHOLE token (it can wrap onto a second line), then ./buddy env:set CLAUDE_CODE_OAUTH_TOKEN <token> and ./buddy uplink:restart'
      : 'Run codex login (or codex login --device-auth if you are on SSH), then ./buddy uplink:restart'
  }

  return `${engine.label} is installed and signed in, but did not answer. The detail above is what it said.`
}

export async function runChecks(config: UplinkConfig, appDir: string): Promise<Check[]> {
  const checks: Check[] = []
  const paths = servicePaths(appDir)
  const heartbeat = await readHeartbeat(appDir)
  const service = await serviceState()

  if (!service.loaded)
    checks.push({ name: 'Background service', ok: false, detail: 'not installed', fix: 'Run ./buddy uplink:install' })
  else if (service.pid === null)
    checks.push({ name: 'Background service', ok: false, detail: `loaded but not running (last exit ${service.lastExit ?? 'unknown'})`, fix: `Check ${paths.log}` })
  else
    checks.push({ name: 'Background service', ok: true, detail: `running (pid ${service.pid})` })

  const fresh = heartbeat && Date.now() - heartbeat.writtenAt < HEARTBEAT_STALE_MS
  if (fresh) {
    checks.push(heartbeat.lastError
      ? { name: 'Reading Messages', ok: false, detail: heartbeat.lastError, fix: `Grant Full Disk Access to ${paths.bundle} in System Settings > Privacy & Security > Full Disk Access, then ./buddy uplink:restart` }
      : { name: 'Reading Messages', ok: true, detail: heartbeat.lastPollAt ? `last poll ${formatDuration(Date.now() - heartbeat.lastPollAt)} ago` : 'starting up' })
  }
  else {
    // No live watcher to ask, so check from this process instead.
    try {
      const db = new MessagesDb(config.messagesDb)
      const own = db.ownHandles()
      db.close()
      checks.push({ name: 'Reading Messages', ok: true, detail: `this process can read chat.db (own handles: ${own.join(', ') || 'none yet'})` })
    }
    catch (error) {
      checks.push({
        name: 'Reading Messages',
        ok: false,
        detail: error instanceof Error ? (error.message.split('. ')[0] ?? error.message) : String(error),
        fix: `Grant Full Disk Access to ${existsSync(paths.bundle) ? paths.bundle : 'Uplink.app (run ./buddy uplink:install first)'}`,
      })
    }
  }

  const allowed = config.allowed.length > 0 ? config.allowed : heartbeat?.own ?? []
  checks.push(allowed.length > 0
    ? { name: 'Who can text it', ok: true, detail: config.allowed.length > 0 ? `UPLINK_ALLOWED: ${allowed.join(', ')}` : `your own handles: ${allowed.join(', ')}` }
    : { name: 'Who can text it', ok: false, detail: 'nobody yet', fix: 'Set UPLINK_ALLOWED in .env to your phone number (and/or Apple ID email)' })

  // One check per engine. Only the selected one is allowed to fail the doctor:
  // a person using Codex has done nothing wrong by never signing in to Claude,
  // and seeing the other engine listed is how they learn they can switch.
  for (const engine of allEngines(config)) {
    const selected = engine.id === config.engine
    const probe = await engine.probe()
    const name = probe.reason === 'missing'
      ? `${engine.label} (not installed)`
      : selected ? `${engine.label} account` : `${engine.label} (available, not selected)`

    checks.push({
      name,
      ok: probe.ok,
      detail: probe.detail,
      informational: !selected,
      fix: probe.ok
        ? undefined
        : selected
          ? engineFix(engine, probe.reason)
          : `Optional. To use it, set UPLINK_ENGINE=${engine.id} in .env, then: ${engineFix(engine, probe.reason)}`,
    })
  }

  const messages = Bun.spawnSync(['pgrep', '-x', 'Messages'])
  checks.push(messages.exitCode === 0
    ? { name: 'Messages app', ok: true, detail: 'running' }
    : { name: 'Messages app', ok: false, detail: 'not running', fix: 'Open Messages and sign in with your Apple ID' })

  checks.push({ name: 'Sending replies', ok: true, detail: 'macOS asks once, on the first reply, to let Uplink control Messages - click Allow' })

  return checks
}

export function writeHeartbeat(appDir: string, heartbeat: Omit<Heartbeat, 'writtenAt'>): Promise<number> {
  return Bun.write(heartbeatPath(appDir), JSON.stringify({ ...heartbeat, writtenAt: Date.now() }, null, 2))
}
