import type { EngineId } from '../Uplink/engine'
import { copyFileSync, existsSync, watch } from 'node:fs'
import process from 'node:process'
import { defineCommand } from '@stacksjs/cli'
import { loadConfig } from '../Uplink/config'
import { checksPass, runChecks, writeHeartbeat } from '../Uplink/doctor'
import { ENGINE_IDS, isEngineId } from '../Uplink/engine'
import { engineFor, selectedEngine } from '../Uplink/engines'
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
      await writeHeartbeat(appDir, { pid: process.pid, startedAt, lastPollAt: null, lastError: message, automation: null, lastSendError: null, allowed: config.allowed, own: [], active: [] })
      await Bun.sleep(RETRY_OPEN_MS)
    }
  }
}

/**
 * What a fresh clone lacks before the service can run: a .env with an app
 * key, and the tables runs are recorded in. Both steps are idempotent, so
 * install can always run them.
 */
const CHANGELOG_HEADING = '# Uplink Changelog'

/** A changelog file without its heading, so two of them can be stacked. */
function changelogBody(markdown: string): string {
  return markdown.replace(CHANGELOG_HEADING, '').trim()
}

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
      const sender = new AppleScriptSender()
      const uplink = new Uplink({
        config,
        messages,
        sender,
        engine: selectedEngine(config),
        engineFor: id => engineFor(id, config),
        store: new ModelStore(`${appDir}/storage/uplink/cursor`),
      })
      await uplink.start()

      // The Automation grant is per app, so only this process can prove that
      // Uplink.app may drive Messages. Ask once at start, and again whenever a
      // send has failed, so the doctor and the dashboard report the subject
      // that actually sends rather than whichever terminal ran them.
      let automation = await sender.canSend()
      if (!automation.ok)
        console.error(`[uplink] cannot send through Messages: ${automation.detail}`)

      const beat = async (): Promise<number> => {
        if (uplink.lastSendError && automation.ok)
          automation = await sender.canSend()
        return writeHeartbeat(appDir, {
          pid: process.pid,
          startedAt,
          lastPollAt: uplink.lastPollAt,
          lastError: uplink.lastError,
          automation: { ok: automation.ok, detail: automation.detail },
          lastSendError: uplink.lastSendError,
          allowed: uplink.allowedHandles,
          own: uplink.ownHandles,
          active: uplink.activeRuns,
        })
      }
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
    .option('--engine <name>', 'claude or codex (default: UPLINK_ENGINE)')
    .action(async (prompt: string, options: { cwd?: string, engine?: string }) => {
      const config = loadConfig()
      const cwd = options.cwd ?? detectWorkdir(prompt, config.workdir)
      // Naming an engine here is how the other one gets tried without editing
      // .env, which is the whole point of this command.
      if (options.engine && !isEngineId(options.engine)) {
        console.error(`[uplink] unknown engine "${options.engine}". Use ${ENGINE_IDS.join(' or ')}.`)
        process.exit(1)
      }
      const engine = options.engine ? engineFor(options.engine as EngineId, config) : selectedEngine(config)
      console.log(`[uplink] running in ${cwd} on ${engine.label}`)
      const run = engine.run({
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
      process.exit(checksPass(checks) ? 0 : 1)
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

      const git = (...args: string[]): string =>
        Bun.spawnSync(['git', ...args], { cwd: appDir, stderr: 'pipe' }).stdout.toString().trim()

      const refuse = (...lines: string[]): never => {
        console.error(lines.join('\n'))
        return process.exit(1)
      }

      // Everything below runs before a single byte is built. A release that
      // turns out to be unverifiable after `gh release create` has to be
      // deleted by hand, and the download links resolve against `latest` from
      // the moment it exists.
      //
      // The build runs out of the working tree, so an uncommitted edit ends up
      // in the shipped binary with nothing naming the source it came from.
      const dirty = git('status', '--porcelain')
      if (dirty) {
        refuse(
          'The working tree is not clean, and the build comes out of it.',
          'Commit or stash these first, or the signed binary contains changes no tag names:',
          dirty,
        )
      }

      // `gh release create` cuts the tag from the remote's default branch when
      // the tag does not exist, not from local HEAD. A stale or unpushed local
      // tree therefore produces a binary whose source is not the tagged source.
      step(['git', 'fetch', '--quiet', '--tags'])
      const head = git('rev-parse', 'HEAD')
      const upstream = git('rev-parse', '@{u}')
      if (!upstream) {
        refuse('This branch has no upstream, so there is nothing to publish from. Push it first.')
      }
      if (head !== upstream) {
        refuse(
          'Local HEAD and the tracked remote branch are not the same commit.',
          `  local:  ${head}`,
          `  remote: ${upstream}`,
          'Push or pull first. The tag would otherwise name a commit that did not build this.',
        )
      }

      const tag = `v${version}`
      if (git('tag', '--list', tag) || git('ls-remote', '--tags', 'origin', tag)) {
        refuse(
          `${tag} already exists, so this would publish under a tag that names something else.`,
          'Bump the version in package.json, or delete the tag and its release first.',
        )
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

      // Against the copy that gets uploaded, not only the build output: the
      // stable name is what releases/latest/download serves, and it is the
      // file a user actually opens. Three claims are made about it on the
      // homepage and in the README, and until now nothing checked any of them.
      step(['codesign', '--verify', '--deep', '--strict', '--verbose=2', stable])
      step(['spctl', '-a', '-t', 'open', '--context', 'context:primary-signature', stable])
      step(['xcrun', 'stapler', 'validate', stable])

      // Published so a download can be checked against something. The file is
      // hashed after verification and before anything is written, so the digest
      // belongs to the bytes that were verified.
      const sha256 = new Bun.CryptoHasher('sha256').update(await Bun.file(stable).arrayBuffer()).digest('hex')
      console.log(`Uplink.dmg  sha256  ${sha256}`)

      // What the homepage's download button reads.
      await Bun.write(`${appDir}/resources/data/release.json`, `${JSON.stringify({
        version,
        bytes: Bun.file(built).size,
        sha256,
        minimumMacOS: '13',
        url: 'https://github.com/stacksjs/uplink/releases/latest/download/Uplink.dmg',
      }, null, 2)}\n`)

      // `buddy changelog` rewrites the file with the commits since the last
      // tag and nothing else, so the older entries are carried over by hand.
      // A changelog that forgets every release but the newest is not one.
      const changelogPath = `${appDir}/CHANGELOG.md`
      const kept = changelogBody(await Bun.file(changelogPath).text())
      step(['./buddy', 'changelog', '--no-interaction'])
      const generated = changelogBody(await Bun.file(changelogPath).text())
      const sections = [`## v${version}\n`, `${generated}\n`, kept && `${kept}\n`].filter(Boolean)
      await Bun.write(changelogPath, `${CHANGELOG_HEADING}\n\n${sections.join('\n')}`)

      // Committed and pushed here rather than left as a note to whoever is
      // releasing. `gh` cuts the tag from the remote tip, so this has to land
      // first or the tagged commit does not contain its own release notes or
      // the version the site advertises. Skipped when nothing changed, so
      // re-running a release for the same version is not an error.
      const pending = Bun.spawnSync(['git', 'status', '--porcelain', 'resources/data/release.json', 'CHANGELOG.md'], { cwd: appDir }).stdout.toString().trim()
      if (pending) {
        step(['git', 'add', 'resources/data/release.json', 'CHANGELOG.md'])
        step(['git', 'commit', '-m', `chore: Uplink ${version} is out`])
        step(['git', 'push'])
      }

      // The only thing that writes a release body. The workflow used to create
      // a second release for the same tag with its own generated notes, so
      // which text a reader got came down to which of the two finished last.
      const notesPath = `${appDir}/storage/framework/desktop-dmg/notes.md`
      await Bun.write(notesPath, [
        `Uplink ${version} for macOS 13 or later. Signed with a Developer ID and notarized by Apple.`,
        '',
        '```',
        `shasum -a 256 Uplink.dmg`,
        `${sha256}  Uplink.dmg`,
        '```',
        '',
        generated,
        '',
      ].join('\n'))

      // The commit that carries this release's own metadata, pinned as a full
      // SHA. Without `--target`, `gh` cuts the tag from the remote's default
      // branch instead, which is not necessarily what was built.
      const tagged = git('rev-parse', 'HEAD')
      console.log(`${tag} will name ${tagged}`)
      step(['gh', 'release', 'create', tag, stable, built, '--target', tagged, '--title', `Uplink ${version}`, '--notes-file', notesPath, ...(options.draft ? ['--draft'] : [])])
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
