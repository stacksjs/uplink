/* eslint-disable no-console */
import type { Server } from 'bun'
import type { UplinkConfig } from './config'
import type { EngineId, EngineInstall, EngineProbe, ProbeReason } from './engine'
import type { AutomationState } from './sender'
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
import { checkLicenseKey, describeLicense, isLicensed, normalizeKey, portalUrl, PRICING_URL, readLicenseKey, readLicenseState, RECHECK_MS, writeLicenseKey, writeLicenseState } from './license'
import { SignIn } from './sign-in'
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
  /** The person asked to quit, from the popover or the menu. */
  readonly quitRequested: boolean
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

  const sender = new AppleScriptSender()
  const store = new SqliteStore(DATABASE_PATH)
  // A database this app cannot open no longer takes the app with it, so the
  // one thing that must not happen is it going unmentioned.
  if (store.schemaError)
    console.error(`[uplink] ${store.schemaError}`)
  const startedAt = Date.now()
  let messages: MessagesDb | null = null
  let messagesError: string | null = null
  let uplink: Uplink | null = null
  let knownAllowed: string[] = []
  // Licensing: the key in the Keychain and the server's last answer, kept so a
  // Mac off-grid keeps answering (license.ts). Texts are answered only while
  // `isLicensed(license)`; everything else - setup, Full Disk Access, signing
  // in - works before a purchase, so buying is the last step, not the first.
  let licenseKey = readLicenseKey()
  let license = readLicenseState()
  let licenseProblem: string | null = null
  const engines = new Map<string, EngineState>()
  let checkingEngines = false
  let automation: AutomationState | null = null
  let checkingAutomation = false
  let quitRequested = false
  const signIn = new SignIn()
  // What setup has already done for the person this launch, so it happens
  // once rather than every few seconds.
  const setupDone = { openedFullDiskAccess: false, startedSignIn: false }

  /**
   * Whether macOS will let this app drive Messages. This process is Uplink.app,
   * so unlike `buddy uplink:doctor` under Terminal it is the right subject to
   * ask. The first call raises the prompt, which is why setup calls it rather
   * than leaving it to the first real reply.
   */
  const checkAutomation = async (): Promise<void> => {
    if (checkingAutomation)
      return
    checkingAutomation = true
    try {
      automation = await sender.canSend()
    }
    finally {
      checkingAutomation = false
    }
  }

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

  /**
   * Sign the selected engine in by running its own CLI: the browser opens, the
   * person approves, and for Claude the token it prints goes straight into the
   * Keychain. No terminal, nothing to copy.
   */
  const startSignIn = (): void => {
    if (config.engine === 'codex') {
      signIn.start({ command: [config.codexBin, 'login'], onDone: checkEngines })
      return
    }
    signIn.start({
      command: [config.claudeBin, 'setup-token'],
      // A stale token in the environment is what is being replaced.
      env: { CLAUDE_CODE_OAUTH_TOKEN: undefined },
      onToken: async (captured) => {
        const cleaned = cleanToken(captured)
        if (!tokenLooksValid(cleaned))
          throw new Error('Claude printed something that is not a token.')
        writeToken(cleaned)
        token = cleaned
        process.env.CLAUDE_CODE_OAUTH_TOKEN = cleaned
        await checkEngines()
      },
    })
  }

  /**
   * Setup that moves itself along, one macOS prompt at a time, so the person
   * only has to say yes: Full Disk Access (System Settings opens at the right
   * list), then signing in (the browser opens), then the prompt to let Uplink
   * control Messages. Each is started once per launch; a step already done is
   * skipped, and nothing here repeats a question someone declined.
   */
  const advanceSetup = (): void => {
    if (settings.paused)
      return
    if (!messages) {
      if (!setupDone.openedFullDiskAccess) {
        setupDone.openedFullDiskAccess = true
        Bun.spawnSync(['open', 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'])
      }
      return
    }
    const engine = engines.get(config.engine)
    if (engine?.reason === 'signed-out' && !setupDone.startedSignIn) {
      setupDone.startedSignIn = true
      startSignIn()
      return
    }
    // After signing in, so the Messages prompt does not land on top of the
    // browser tab someone is reading.
    if (!signIn.running && automation === null)
      void checkAutomation()
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
    // Messages is open either way - setup needs it for Full Disk Access and
    // for finding this Mac's own numbers - but texts are answered only on a
    // license.
    if (!isLicensed(license))
      return
    uplink = new Uplink({ config, messages, sender, engine: selectedEngine(config), store })
    await uplink.start()
  }

  /** Start or stop answering texts to match the license. */
  const followLicense = async (): Promise<void> => {
    if (isLicensed(license))
      await startWatching()
    else if (uplink) {
      await uplink.stop()
      uplink = null
    }
  }

  /**
   * Ask the license server about the key in the Keychain. An unreachable server
   * changes nothing (the last answer stands, off-grid); an answer replaces it.
   */
  const refreshLicense = async (): Promise<void> => {
    if (!licenseKey)
      return
    const result = await checkLicenseKey(licenseKey)
    if (result.kind === 'answered') {
      license = result.state
      licenseProblem = null
      writeLicenseState(license)
    }
    else if (result.kind === 'unknown-key') {
      license = { valid: false, plan: null, status: 'unknown', email: null, expiresAt: null, endsAtPeriodEnd: false, checkedAt: Date.now() }
      licenseProblem = 'The license server does not know that key.'
      writeLicenseState(license)
    }
    else {
      licenseProblem = `Could not reach the license server: ${result.error}`
    }
    await followLicense()
  }

  /** Take a key the person typed, pasted or clicked: keep it only if the server says it is good. */
  const activate = async (raw: unknown): Promise<{ ok: boolean, error?: string }> => {
    const key = normalizeKey(raw)
    if (!key)
      return { ok: false, error: 'That is not an Uplink license key. It looks like UPLK-XXXX-XXXX-XXXX-XXXX.' }
    const result = await checkLicenseKey(key)
    if (result.kind === 'unreachable')
      return { ok: false, error: `Could not reach the license server to check the key: ${result.error}` }
    if (result.kind === 'unknown-key')
      return { ok: false, error: 'Uplink did not issue that key. Check it against your thank-you page.' }
    writeLicenseKey(key)
    licenseKey = key
    license = result.state
    licenseProblem = null
    writeLicenseState(license)
    await followLicense()
    return result.state.valid ? { ok: true } : { ok: false, error: describeLicense(result.state) }
  }

  const restartWatching = async (): Promise<void> => {
    await uplink?.stop()
    uplink = null
    await startWatching()
  }

  const recheckLicense = setInterval(() => void refreshLicense(), RECHECK_MS)

  // Until Full Disk Access is granted, try again every few seconds: the
  // grant should take effect without the person having to relaunch. Then take
  // setup on to its next step.
  const retry = setInterval(() => {
    if (!uplink && !settings.paused)
      void startWatching().then(advanceSetup)
    else
      advanceSetup()
  }, RETRY_OPEN_MS)

  const keepMessagesOpen = setInterval(() => {
    if (uplink && Bun.spawnSync(['pgrep', '-x', 'Messages']).exitCode !== 0)
      Bun.spawnSync(['open', '-g', '-a', 'Messages'])
    // Re-ask while the answer is anything but yes. A refusal only changes in
    // System Settings, and a timeout from a Messages that was still starting
    // should not leave the app stuck in setup for ever.
    if (messages && automation && !automation.ok)
      void checkAutomation()
  }, 15_000)

  await startWatching()
  void refreshLicense()
  void checkEngines().then(advanceSetup)
  advanceSetup()

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
    // While paused there is no watcher to ask, and "Nobody yet" would be wrong:
    // the handles it last found still apply when it resumes.
    if (uplink)
      knownAllowed = uplink.allowedHandles
    // Before a license, or while paused, there is no watcher to ask; Messages
    // itself says whose Mac this is.
    else if (messages && knownAllowed.length === 0) {
      try {
        knownAllowed = messages.ownHandles()
      }
      catch {}
    }
    const allowed = uplink ? knownAllowed : settings.allowed.length > 0 ? settings.allowed : knownAllowed
    const checks: PopoverCheck[] = [
      {
        id: 'license',
        name: 'Activate Uplink',
        ok: isLicensed(license),
        detail: licenseProblem && !isLicensed(license) ? licenseProblem : describeLicense(license),
        informational: false,
      },
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
          detail: selected && signIn.state.phase === 'waiting'
            ? signIn.state.detail
            : selected && signIn.state.phase === 'failed' && !state?.ok
              ? signIn.state.detail
              : checkingEngines && !state ? 'Checking' : (state?.detail ?? 'Not checked yet'),
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
      {
        // The outbound half of the chain. Without this the app reported itself
        // ready while every reply was refused, so a first text produced a run
        // marked done and a phone that heard nothing.
        id: 'automation',
        name: 'Send replies',
        ok: automation?.ok ?? false,
        detail: uplink?.lastSendError
          ?? (checkingAutomation && !automation?.ok
            ? 'Click OK in the macOS prompt to let Uplink use Messages.'
            : automation?.detail ?? 'Uplink asks for this once the steps above are done.'),
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
      license: {
        licensed: isLicensed(license),
        plan: license?.plan ?? null,
        summary: describeLicense(license),
        // The portal manages subscriptions; lifetime has nothing to manage.
        manageable: Boolean(licenseKey && license?.plan && license.plan !== 'lifetime'),
        // Enough to recognise it by, never the key itself.
        keyHint: licenseKey ? licenseKey.slice(-4) : null,
      },
      engines: allEngines(config).map(engine => ({ id: engine.id, label: engine.label })),
      lastError: uplink?.lastError ?? null,
      // Not a check: a broken database is not a setup step anyone performs,
      // and it must not hold the app in `setup` when it is still answering
      // texts. The popover shows this in every state, which a check row cannot
      // do. See `SqliteStore.schemaError`.
      notice: store.schemaError,
      signIn: signIn.state,
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

        case '/api/automation/test':
          await checkAutomation()
          return json(automation)

        case '/api/open/automation': {
          Bun.spawnSync(['open', 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'])
          return json({ ok: true })
        }

        case '/api/open/install-docs': {
          // The selected engine's own documentation, so the link cannot drift
          // from the command shown beside it.
          const { url } = allEngines(config).find(engine => engine.id === config.engine)?.install ?? { url: '' }
          if (url)
            Bun.spawnSync(['open', url])
          return json({ ok: Boolean(url), url })
        }

        case '/api/license/activate':
          return json({ ...await activate(body.key), ...status() })

        case '/api/license/refresh':
          await refreshLicense()
          return json(status())

        case '/api/license/portal': {
          const url = licenseKey ? await portalUrl(licenseKey) : null
          if (url)
            Bun.spawnSync(['open', url])
          return json({ ok: Boolean(url), error: url ? undefined : 'Could not open billing right now. Try again in a minute.' })
        }

        case '/api/open/pricing':
          Bun.spawnSync(['open', PRICING_URL])
          return json({ ok: true })

        case '/api/engine/sign-in':
          startSignIn()
          return json(status())

        case '/api/engine/sign-in/cancel':
          signIn.cancel()
          return json(status())

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

        case '/api/stop':
          return json({ stopped: await uplink?.stopAll() ?? 0, ...status() })

        case '/api/quit':
          quitRequested = true
          setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50)
          return json({ ok: true })
      }

      return json({ error: 'not found' }, 404)
    },
  })

  return {
    port: server.port ?? 0,
    server,
    get quitRequested() {
      return quitRequested
    },
    stop: async () => {
      clearInterval(retry)
      clearInterval(recheckLicense)
      signIn.cancel()
      clearInterval(keepMessagesOpen)
      await uplink?.stop()
      server.stop(true)
      store.close()
      messages?.close()
      releaseSingleInstance()
    },
  }
}
