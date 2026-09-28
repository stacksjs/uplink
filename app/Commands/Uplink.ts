import { copyFileSync, existsSync, watch } from 'node:fs'
import process from 'node:process'
import { defineCommand } from '@stacksjs/cli'
import { loadConfig, systemPrompt } from '../Uplink/config'
import { runChecks, writeHeartbeat } from '../Uplink/doctor'
import { ClaudeEngine } from '../Uplink/engine'
import { formatDuration, toPlainText } from '../Uplink/format'
import { MessagesAccessError, MessagesDb } from '../Uplink/messages-db'
import { ModelStore } from '../Uplink/model-store'
import { AppleScriptSender } from '../Uplink/sender'
import { install, LABEL, restart, servicePaths, uninstall } from '../Uplink/service'
import { Uplink } from '../Uplink/uplink'
import { detectWorkdir } from '../Uplink/workdir'

// `buddy uplink:*` - run, install and check the text-to-agent bridge.
// Every file in this directory is a command; there is nothing to register.

const HEARTBEAT_MS = 15_000
const RETRY_OPEN_MS = 30_000

function engineFor(config: ReturnType<typeof loadConfig>): ClaudeEngine {
  return new ClaudeEngine({
    bin: config.claudeBin,
    model: config.model,
    permissionMode: config.permissionMode,
    systemPrompt: systemPrompt(config),
    timeoutMs: config.timeoutMs,
  })
}

async function openMessages(config: ReturnType<typeof loadConfig>, appDir: string, startedAt: number): Promise<MessagesDb> {
  // Without Full Disk Access this fails. Under launchd, exiting would only
  // restart-loop, so wait for the grant instead and say why in the heartbeat.
  for (;;) {
    try {
      return new MessagesDb(config.messagesDb)
    }
    catch (error) {
      const message = error instanceof MessagesAccessError ? error.message : String(error)
      console.error(`[uplink] ${message} Retrying in ${RETRY_OPEN_MS / 1000}s.`)
      await writeHeartbeat(appDir, { pid: process.pid, startedAt, lastPollAt: null, lastError: message, allowed: config.allowed, own: [], active: [] })
      await Bun.sleep(RETRY_OPEN_MS)
    }
  }
}

/**
 * What a fresh clone lacks before the service can run: a .env with an app
 * key, and the tables runs are recorded in. Both steps are idempotent, so
 * install can always run them.
 */
function prepareApp(appDir: string): void {
  const buddy = `${appDir}/buddy`
  if (!existsSync(`${appDir}/.env`)) {
    copyFileSync(`${appDir}/.env.example`, `${appDir}/.env`)
    console.log('Created .env from .env.example')
    Bun.spawnSync([buddy, 'key:generate'], { cwd: appDir, stdout: 'ignore', stderr: 'inherit' })
  }
  const migrate = Bun.spawnSync([buddy, 'migrate'], { cwd: appDir, stdout: 'ignore', stderr: 'pipe' })
  if (migrate.exitCode !== 0)
    throw new Error(`./buddy migrate failed: ${migrate.stderr.toString().trim()}`)
  console.log('Database ready')
}

export default defineCommand((cli) => {
  cli
    .command('uplink:watch', 'Watch Messages for texts and answer them (what the background service runs)')
    .action(async () => {
      const config = loadConfig()
      const appDir = process.cwd()
      const startedAt = Date.now()

      // Replies go through Messages, and a quit Messages is easy to miss from
      // a phone - so keep it running (in the background) for as long as we are.
      const keepMessagesOpen = (): void => {
        if (Bun.spawnSync(['pgrep', '-x', 'Messages']).exitCode !== 0) {
          console.log('[uplink] Messages was not running; reopening it in the background')
          Bun.spawnSync(['open', '-g', '-a', 'Messages'])
        }
      }
      keepMessagesOpen()

      const messages = await openMessages(config, appDir, startedAt)
      const uplink = new Uplink({
        config,
        messages,
        sender: new AppleScriptSender(),
        engine: engineFor(config),
        store: new ModelStore(`${appDir}/storage/uplink/cursor`),
      })
      await uplink.start()

      const beat = (): Promise<number> => writeHeartbeat(appDir, {
        pid: process.pid,
        startedAt,
        lastPollAt: uplink.lastPollAt,
        lastError: uplink.lastError,
        allowed: uplink.allowedHandles,
        own: uplink.ownHandles,
        active: uplink.activeRuns,
      })
      // .env is read once, at start. Editing it (a new token, say) used to do
      // nothing until someone remembered uplink:restart, and every text in
      // between failed. Under launchd, which restarts us, pick it up on our
      // own - but never in the middle of a run.
      let envChanged = false
      if (process.env.XPC_SERVICE_NAME === LABEL) {
        watch(`${appDir}/.env`, () => {
          if (!envChanged)
            console.log('[uplink] .env changed; restarting once no run is in progress')
          envChanged = true
        })
      }

      await beat()
      setInterval(async () => {
        keepMessagesOpen()
        await beat()
        if (envChanged && uplink.activeRuns.length === 0) {
          await uplink.stop()
          process.exit(0)
        }
      }, HEARTBEAT_MS)

      const shutdown = async (): Promise<void> => {
        await uplink.stop()
        process.exit(0)
      }
      process.on('SIGTERM', shutdown)
      process.on('SIGINT', shutdown)
      // The poll timer keeps the process alive from here.
    })

  cli
    .command('uplink:ask <prompt>', 'Run one prompt through the agent exactly as a text would, and print the reply')
    .option('--cwd <dir>', 'Working directory (default: detected from the prompt)')
    .action(async (prompt: string, options: { cwd?: string }) => {
      const config = loadConfig()
      const cwd = options.cwd ?? detectWorkdir(prompt, config.workdir)
      console.log(`[uplink] running in ${cwd}`)
      const run = engineFor(config).run({
        prompt,
        cwd,
        onEvent: (event) => {
          if (event.kind === 'tool')
            console.log(`  ${event.summary}`)
        },
      })
      const result = await run.done
      console.log(`\n${toPlainText(result.text)}\n`)
      console.log(`[uplink] ${result.ok ? 'ok' : 'failed'} in ${formatDuration(result.durationMs)}${result.costCents !== null ? `, ${result.costCents}¢ at API rates` : ''}`)
      process.exit(result.ok ? 0 : 1)
    })

  cli
    .command('uplink:doctor', 'Check everything Uplink needs, and say how to fix what is missing')
    .action(async () => {
      const checks = await runChecks(loadConfig(), process.cwd())
      for (const check of checks) {
        console.log(`${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`)
        if (!check.ok && check.fix)
          console.log(`    → ${check.fix}`)
      }
      process.exit(checks.every(c => c.ok) ? 0 : 1)
    })

  cli
    .command('uplink:install', 'Build Uplink.app and start it at login (launchd)')
    .option('--rebuild', 'Recompile Uplink.app (you will need to grant Full Disk Access again)', { default: false })
    .action(async (options: { rebuild: boolean }) => {
      const paths = servicePaths(process.cwd())
      prepareApp(process.cwd())
      await install(paths, { rebuild: options.rebuild })
      console.log(`Installed ${paths.bundle}`)
      console.log(`Logs: ${paths.log}`)
      console.log('\nNext: grant it Full Disk Access (System Settings > Privacy & Security > Full Disk Access > +),')
      console.log('then run ./buddy uplink:restart and ./buddy uplink:doctor.')
      // Opens the pane only; the grant itself is yours to make.
      Bun.spawnSync(['open', 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'])
      Bun.spawnSync(['open', '-R', paths.bundle])
      process.exit(0)
    })

  cli
    .command('uplink:release', 'Build, sign and notarize Uplink.app, and publish it as a GitHub release')
    .option('--identity <identity>', 'Developer ID Application certificate (name or SHA-1); default DESKTOP_SIGNING_IDENTITY')
    .option('--notary-profile <profile>', 'notarytool keychain profile; default DESKTOP_NOTARY_PROFILE')
    .option('--draft', 'Create the GitHub release as a draft', { default: false })
    .action(async (options: { identity?: string, notaryProfile?: string, draft: boolean }) => {
      const appDir = process.cwd()
      const version = (await Bun.file(`${appDir}/package.json`).json()).version as string
      const identity = options.identity || process.env.DESKTOP_SIGNING_IDENTITY
      const notaryProfile = options.notaryProfile || process.env.DESKTOP_NOTARY_PROFILE
      // A release other Macs open without a warning needs both. Refuse rather
      // than publish something Gatekeeper will block.
      if (!identity || !notaryProfile) {
        console.error('A release needs a Developer ID identity and a notarytool profile: --identity and --notary-profile (or DESKTOP_SIGNING_IDENTITY / DESKTOP_NOTARY_PROFILE).')
        process.exit(1)
      }

      const step = (args: string[], env: Record<string, string> = {}): void => {
        console.log(`> ${args.join(' ')}`)
        const result = Bun.spawnSync(args, { cwd: appDir, env: { ...process.env, ...env }, stdout: 'inherit', stderr: 'inherit' })
        if (result.exitCode !== 0)
          process.exit(result.exitCode ?? 1)
      }

      step(['./buddy', 'build:desktop'], { CRAFT_BIN: `${appDir}/pantry/.bin/craft` })
      step(['./buddy', 'build:dmg'], {
        DESKTOP_APP_NAME: 'Uplink',
        DESKTOP_BUNDLE_ID: 'com.stacksjs.uplink',
        DESKTOP_APP_VERSION: version,
        DESKTOP_SIGNING_IDENTITY: identity,
        DESKTOP_NOTARY_PROFILE: notaryProfile,
      })

      // One stable name, so https://github.com/stacksjs/uplink/releases/latest/download/Uplink.dmg
      // always serves the newest; the versioned copy keeps old releases findable.
      const built = `${appDir}/storage/framework/desktop-dmg/Uplink-${version}.dmg`
      const stable = `${appDir}/storage/framework/desktop-dmg/Uplink.dmg`
      copyFileSync(built, stable)
      // The homepage's download button states the version and size; commit this.
      await Bun.write(`${appDir}/resources/data/release.json`, `${JSON.stringify({
        version,
        bytes: Bun.file(built).size,
        minimumMacOS: '13',
        url: 'https://github.com/stacksjs/uplink/releases/latest/download/Uplink.dmg',
      }, null, 2)}\n`)
      step(['gh', 'release', 'create', `v${version}`, stable, built, '--title', `Uplink ${version}`, '--notes', `Uplink ${version} for macOS 13 or later. Signed with a Developer ID and notarized by Apple.`, ...(options.draft ? ['--draft'] : [])])
      process.exit(0)
    })

  cli
    .command('uplink:uninstall', 'Stop the background service and remove it from login')
    .action(async () => {
      await uninstall(servicePaths(process.cwd()))
      console.log('Uplink will no longer start at login.')
      process.exit(0)
    })

  cli
    .command('uplink:restart', 'Restart the background service (after granting permissions or editing .env)')
    .action(async () => {
      await restart()
      console.log('Restarted.')
      process.exit(0)
    })
})
