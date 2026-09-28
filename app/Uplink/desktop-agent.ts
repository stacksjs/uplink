/* eslint-disable no-console */
import type { Server } from 'bun'
import type { UplinkConfig } from './config'
import type { EngineId, EngineInstall, EngineProbe, ProbeReason } from './engine'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { loadConfig } from './config'
import { isEngineId } from './engine'
import { allEngines, selectedEngine } from './engines'
import { formatDuration, truncate } from './format'
import { MessagesAccessError, MessagesDb } from './messages-db'
import { AppleScriptSender } from './sender'
import { cleanToken, DATA_DIR, DATABASE_PATH, readSettings, readToken, settingsEnv, tokenLooksValid, writeSettings, writeToken } from './settings'
import { SqliteStore } from './sqlite-store'
import { Uplink } from './uplink'

// bun-types declares *.html as an HTMLBundle (for Bun.serve routes); with
// `type: 'text'` it is the file's contents.
const MENUBAR_HTML = menubarPage as unknown as string
// Embedded by `bun build --compile`, so the app carries its UI inside one binary.
import menubarPage from './menubar.html' with { type: 'text' }

/**
 * The downloadable app's runtime: the watcher, backed by SQLite and the
 * Keychain instead of a Stacks project, plus a loopback API the menubar
 * popover renders. Everything a person has to do - grant Full Disk Access,
 * sign in to Claude, choose who may text - is a button in that popover.
 */

export const LABEL = 'com.stacksjs.uplink'

/**
 * Login items and replacing another install only make sense for the real app.
 * Run from source (`bun app/Desktop/launcher.ts`) the executable is `bun`, and
 * a LaunchAgent pointing at it - or stopping the running service - would be
 * wrong.
 */
const IN_APP_BUNDLE = process.execPath.includes('.app/Contents/MacOS/')
const LOCK_PATH = join(DATA_DIR, 'uplink.pid')
const LAUNCH_AGENT = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const RETRY_OPEN_MS = 5_000

type EngineState = EngineProbe & { checkedAt: number }

/**
 * One row of the popover's setup list. Declared rather than inferred, because
 * the entries genuinely differ (only an engine row carries `install`) and an
 * inferred union puts the shared fields out of reach.
 */
interface PopoverCheck {
  id: string
  name: string
  ok: boolean
  detail: string
  /** Shown, but not counted towards readiness. */
  informational: boolean
  engineId?: EngineId
  label?: string
  reason?: ProbeReason
  install?: EngineInstall
}

export interface DesktopAgent {
  port: number
  server: Server<undefined>
  stop: () => Promise<void>
}

/** True if another live Uplink holds the lock. Otherwise takes it. */
export function acquireSingleInstance(): boolean {
  mkdirSync(DATA_DIR, { recursive: true })
  if (existsSync(LOCK_PATH)) {
    const pid = Number(readFileSync(LOCK_PATH, 'utf8'))
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0)
        return false
      }
      catch {
        // Stale lock from a crash.
      }
    }
  }
  writeFileSync(LOCK_PATH, String(process.pid))
  return true
}

function releaseSingleInstance(): void {
  try {
    if (readFileSync(LOCK_PATH, 'utf8') === String(process.pid))
      rmSync(LOCK_PATH)
  }
  catch {}
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`
}

/**
 * The source install (`buddy uplink:install`) and this app use one launchd
 * label, so they can never both answer texts. If that label is loaded with a
 * different program - the source build - stop it.
 */
function retireOtherInstall(): string | null {
  if (!IN_APP_BUNDLE)
    return null
  const print = Bun.spawnSync(['launchctl', 'print', `${domain()}/${LABEL}`], { stderr: 'ignore' })
  if (print.exitCode !== 0)
    return null
  const program = print.stdout.toString().match(/program = ([^\n]+)/)?.[1]?.trim()
  if (!program || program === process.execPath)
    return null
  Bun.spawnSync(['launchctl', 'bootout', `${domain()}/${LABEL}`], { stderr: 'ignore' })
  return program
}

/**
 * Open at login: a LaunchAgent for this executable. It restarts the app only
 * after a crash (SuccessfulExit false), so Quit stays quit. It is written, not
 * bootstrapped: loading it now would start a second copy of the app.
 */
export function setOpenAtLogin(enabled: boolean): void {
  if (!IN_APP_BUNDLE)
    return
  if (!enabled) {
    rmSync(LAUNCH_AGENT, { force: true })
    return
  }
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  writeFileSync(LAUNCH_AGENT, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${process.execPath.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`)
}


export async function startDesktopAgent(options: { version: string }): Promise<DesktopAgent> {
  mkdirSync(DATA_DIR, { recursive: true })
  const retired = retireOtherInstall()
  if (retired)
    console.log(`[uplink] stopped the other Uplink install (${retired}) so texts are answered once`)

  let settings = readSettings()
  let config: UplinkConfig = loadConfig(settingsEnv(settings))
  let token = readToken()
  if (token)
    process.env.CLAUDE_CODE_OAUTH_TOKEN = token
  // Rewrite a login item that starts something else - the source install's,
  // which shares this label - or at the next login that is what launchd runs.
  if (settings.openAtLogin && (!existsSync(LAUNCH_AGENT) || !readFileSync(LAUNCH_AGENT, 'utf8').includes(`<string>${process.execPath}</string>`)))
    setOpenAtLogin(true)

  const store = new SqliteStore(DATABASE_PATH)
  const startedAt = Date.now()
  let messages: MessagesDb | null = null
  let messagesError: string | null = null
  let uplink: Uplink | null = null
  const engines = new Map<string, EngineState>()
  let checkingEngines = false

  /**
   * Probe every engine, not only the selected one: the popover shows the other
   * as available rather than as a failure, which is how a person discovers they
   * can switch.
   */
  const checkEngines = async (): Promise<void> => {
    if (checkingEngines)
      return
    checkingEngines = true
    try {
      for (const engine of allEngines(config))
        engines.set(engine.id, { ...await engine.probe(), checkedAt: Date.now() })
    }
    finally {
      checkingEngines = false
    }
  }

  const startWatching = async (): Promise<void> => {
    if (uplink || settings.paused)
      return
    try {
      messages = messages ?? new MessagesDb(config.messagesDb)
      messagesError = null
    }
    catch (error) {
      messagesError = error instanceof MessagesAccessError ? 'Uplink needs Full Disk Access to read Messages.' : String(error)
      return
    }
    uplink = new Uplink({ config, messages, sender: new AppleScriptSender(), engine: selectedEngine(config), store })
    await uplink.start()
  }

  const restartWatching = async (): Promise<void> => {
    await uplink?.stop()
    uplink = null
    await startWatching()
  }

  // Until Full Disk Access is granted, try again every few seconds: the
  // grant should take effect without the person having to relaunch.
  const retry = setInterval(() => {
    if (!uplink && !settings.paused)
      void startWatching()
  }, RETRY_OPEN_MS)

  const keepMessagesOpen = setInterval(() => {
    if (uplink && Bun.spawnSync(['pgrep', '-x', 'Messages']).exitCode !== 0)
      Bun.spawnSync(['open', '-g', '-a', 'Messages'])
  }, 15_000)

  await startWatching()
  void checkEngines()

  const status = () => {
    const recent = store.recentRuns(8).map(run => ({
      prompt: truncate(run.prompt, 120),
      status: run.status,
      answer: truncate(run.reply ?? run.error ?? '', 160),
      when: run.startedAt ? formatDuration(Date.now() - run.startedAt) : '',
    }))
    const active = uplink?.activeRuns.map(run => ({
      prompt: truncate(run.prompt, 120),
      elapsed: formatDuration(Date.now() - run.startedAt),
      lastActivity: run.lastActivity ?? 'Thinking',
      queued: run.queued,
    })) ?? []
    const allowed = uplink?.allowedHandles ?? settings.allowed
    const checks: PopoverCheck[] = [
      {
        id: 'fda',
        name: 'Read Messages',
        ok: messages !== null,
        detail: messages ? 'Full Disk Access granted' : (messagesError ?? 'Waiting for Full Disk Access'),
        informational: false,
      },
      ...allEngines(config).map((engine) => {
        const state = engines.get(engine.id)
        const selected = engine.id === config.engine
        const reason = state?.reason ?? 'failed'
        const missing = reason === 'missing'
        return {
          // `engine` is the selected one, and the popover draws its sign-in
          // step. The other is listed so switching is discoverable.
          id: selected ? 'engine' : `engine:${engine.id}`,
          // A missing CLI is not a sign-in problem, and calling it one sends
          // the person to run a command that does not exist either.
          name: missing ? `Install ${engine.label}` : selected ? `Sign in to ${engine.label}` : engine.label,
          engineId: engine.id,
          label: engine.label,
          reason,
          install: engine.install,
          ok: state?.ok ?? false,
          detail: checkingEngines && !state ? 'Checking' : (state?.detail ?? 'Not checked yet'),
          informational: !selected,
        }
      }),
      {
        id: 'handles',
        name: 'Who can text it',
        ok: allowed.length > 0,
        detail: allowed.length > 0 ? allowed.join(', ') : 'No handles yet. Sign in to Messages, or add your number.',
        informational: false,
      },
    ]
    // An engine the person has not selected must not hold the app in setup.
    const ready = checks.every(check => check.ok || check.informational)
    const state = settings.paused ? 'paused' : !ready ? 'setup' : active.length > 0 ? 'working' : 'listening'
    return {
      state,
      version: options.version,
      uptime: formatDuration(Date.now() - startedAt),
      checks,
      active,
      recent,
      settings: { allowed: settings.allowed, engine: settings.engine, openAtLogin: settings.openAtLogin, paused: settings.paused, model: settings.model },
      engines: allEngines(config).map(engine => ({ id: engine.id, label: engine.label })),
      lastError: uplink?.lastError ?? null,
    }
  }

  /** The selected engine's probe, which is what a sign-in button wants back. */
  const engineResult = (): { ok: boolean, detail: string } => {
    const state = engines.get(config.engine)
    return { ok: state?.ok ?? false, detail: state?.detail ?? 'Not checked yet' }
  }

  const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      // The popover is the only client. Refuse cross-site requests so a web
      // page in a browser cannot drive this API through the loopback port.
      const origin = request.headers.get('origin')
      if (origin && origin !== url.origin)
        return json({ error: 'forbidden' }, 403)

      if (request.method === 'GET' && url.pathname === '/')
        return new Response(MENUBAR_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })

      if (request.method === 'GET' && url.pathname === '/api/status')
        return json(status())

      if (request.method !== 'POST')
        return json({ error: 'not found' }, 404)

      const body = await request.json().catch(() => ({})) as Record<string, any>

      switch (url.pathname) {
        case '/api/open/full-disk-access':
          Bun.spawnSync(['open', 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'])
          return json({ ok: true })

        case '/api/open/install-docs': {
          // The selected engine's own documentation, so the link cannot drift
          // from the command shown beside it.
          const { url } = allEngines(config).find(engine => engine.id === config.engine)?.install ?? { url: '' }
          if (url)
            Bun.spawnSync(['open', url])
          return json({ ok: Boolean(url), url })
        }

        case '/api/open/terminal': {
          // Both sign-ins need a real terminal for their browser round trip.
          const command = config.engine === 'codex' ? 'codex login' : 'claude setup-token'
          Bun.spawnSync(['osascript', '-e', `tell application "Terminal" to do script "${command}"`, '-e', 'tell application "Terminal" to activate'])
          return json({ ok: true, command })
        }

        case '/api/token': {
          const cleaned = cleanToken(String(body.token ?? ''))
          if (!tokenLooksValid(cleaned))
            return json({ ok: false, error: `That does not look like a whole token (${cleaned.length} characters). Copy all of it, including any part that wrapped onto a second line.` }, 400)
          writeToken(cleaned)
          token = cleaned
          process.env.CLAUDE_CODE_OAUTH_TOKEN = cleaned
          await checkEngines()
          return json(engineResult())
        }

        // `/api/claude/test` is the old name for this and still answers, because
        // a popover cached from an older build would otherwise have a dead button.
        case '/api/claude/test':
        case '/api/engine/test':
          await checkEngines()
          return json(engineResult())

        case '/api/settings': {
          if (Array.isArray(body.allowed))
            settings.allowed = body.allowed.map(String).map((s: string) => s.trim()).filter(Boolean)
          if (typeof body.engine === 'string' && isEngineId(body.engine))
            settings.engine = body.engine
          if (typeof body.paused === 'boolean')
            settings.paused = body.paused
          if (typeof body.openAtLogin === 'boolean') {
            settings.openAtLogin = body.openAtLogin
            setOpenAtLogin(body.openAtLogin)
          }
          writeSettings(settings)
          settings = readSettings()
          config = loadConfig(settingsEnv(settings))
          await restartWatching()
          // A switched engine has not been probed under the new selection yet,
          // and the popover reads the answer straight back.
          await checkEngines()
          return json(status())
        }

        case '/api/quit':
          setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50)
          return json({ ok: true })
      }

      return json({ error: 'not found' }, 404)
    },
  })

  return {
    port: server.port ?? 0,
    server,
    stop: async () => {
      clearInterval(retry)
      clearInterval(keepMessagesOpen)
      await uplink?.stop()
      server.stop(true)
      store.close()
      messages?.close()
      releaseSingleInstance()
    },
  }
}
