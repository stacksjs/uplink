import type { UplinkConfig } from './config'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { formatDuration, truncate } from './format'
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
 * Whether the claude CLI can actually answer, checked with one real turn.
 *
 * Only asking "is a token set" passed a token truncated at the terminal's
 * 80-column wrap: set, well-formed, and rejected with a 401 on first use.
 */
async function claudeAuth(bin: string): Promise<{ ok: boolean, detail: string }> {
  try {
    const proc = Bun.spawn([bin, '-p', 'Reply with exactly: ok', '--model', 'haiku', '--output-format', 'json'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: tmpdir(),
    })
    const timer = setTimeout(() => proc.kill(), 60_000)
    const text = await new Response(proc.stdout).text()
    clearTimeout(timer)
    await proc.exited
    const result = JSON.parse(text) as { is_error?: boolean, result?: string }
    const via = process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'the CLI login'
    if (!result.is_error)
      return { ok: true, detail: `answers (via ${via})` }
    const hint = process.env.CLAUDE_CODE_OAUTH_TOKEN
      ? ` - the token is ${process.env.CLAUDE_CODE_OAUTH_TOKEN.length} characters; a paste cut at a line wrap is the usual cause`
      : ''
    return { ok: false, detail: `${truncate(result.result ?? 'no answer', 120)}${hint}` }
  }
  catch (error) {
    return { ok: false, detail: `could not run ${bin}: ${error instanceof Error ? error.message : String(error)}` }
  }
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

  const auth = await claudeAuth(config.claudeBin)
  checks.push(auth.ok
    ? { name: 'Claude account', ok: true, detail: auth.detail }
    : { name: 'Claude account', ok: false, detail: auth.detail, fix: 'Run claude setup-token, copy the WHOLE token (it can wrap onto a second line), then ./buddy env:set CLAUDE_CODE_OAUTH_TOKEN <token> and ./buddy uplink:restart' })

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
