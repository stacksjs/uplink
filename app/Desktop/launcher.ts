/* eslint-disable no-console */
/**
 * `Uplink.app/Contents/MacOS/Uplink`, compiled by `buddy build:desktop`.
 *
 * One process owns everything that needs a permission: it reads Messages
 * (Full Disk Access is granted to Uplink.app, and this is its executable),
 * sends replies through osascript, and runs Claude Code. The Craft runtime
 * beside it only draws the menubar item and the popover, which talk back to
 * this process over 127.0.0.1.
 *
 * Run from source for development with `bun app/Desktop/launcher.ts`; Craft
 * then comes from CRAFT_BIN or PATH (pantry installs it).
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { format } from 'node:util'
import pkg from '../../package.json'
import { agentPath } from '../Uplink/agent-path'
import { acquireSingleInstance, startDesktopAgent } from '../Uplink/desktop-agent'
import { installCrashHandlers, writeLog } from '../Uplink/log'

// Launched from Finder or from its own LaunchAgent, this process gets the bare
// launchd PATH, and everything below it inherits that: the engines, their
// probes, and osascript. Widen it once, here, before anything spawns. Without
// this a `claude` installed by bun, npm or nvm is invisible to the app on a Mac
// where it works in a terminal.
process.env.PATH = agentPath()

// Launched from Finder or at login there is no terminal, so keep a log where
// Console.app looks for one. From a terminal the developer keeps stderr.
if (!process.stdout.isTTY) {
  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => writeLog(format(...args))
  }
}

/**
 * Whether the things `shutdown` closes over exist yet. A crash during startup
 * is both the one most worth reporting and the one where calling `shutdown`
 * would itself throw, so that case exits directly. The single instance lock is
 * reaped by the next start.
 */
let running = false

installCrashHandlers({
  shutdown: (code) => {
    if (!running)
      process.exit(code)
    // A hung agent.stop() must not keep a half dead process alive.
    setTimeout(() => process.exit(code), 3000).unref()
    void shutdown(code)
  },
})

if (!acquireSingleInstance()) {
  console.log('[uplink] already running')
  process.exit(0)
}

function craftRuntime(): string {
  const bundled = join(dirname(process.execPath), 'craft-runtime')
  if (existsSync(bundled))
    return bundled
  const found = process.env.CRAFT_BIN || Bun.which('craft')
  if (!found)
    throw new Error('Craft runtime not found: set CRAFT_BIN or run `pantry install`.')
  return found
}

// Anything thrown in here happens before the menubar exists, and launchd's
// KeepAlive restarts a non-zero exit, so the loop would be silent: the plist
// sets no StandardErrorPath, and the rebinding above only catches what goes
// through `console`. Exit the same way, having said why first.
const agent = await startDesktopAgent({ version: pkg.version }).catch((error: unknown) => {
  console.error(`[uplink] could not start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  return process.exit(1)
})
console.log(`[uplink] ${pkg.version} serving the menubar on 127.0.0.1:${agent.port}`)

// --tray-popover: Craft hangs the page under the status item on the popover
// material, opens and closes it on the item's click, and closes it on a click
// anywhere else. It stays hidden until then, or until the page opens it itself
// because setup is unfinished. The page sizes it to its content.
const craft = Bun.spawn([
  craftRuntime(),
  `http://127.0.0.1:${agent.port}/`,
  '--title',
  'Uplink',
  '--tray-popover',
  '--width',
  '340',
  '--height',
  '420',
], { stdio: ['ignore', 'ignore', 'pipe'] })

void new Response(craft.stderr).text().then((stderr) => {
  if (stderr.trim())
    console.error(`[craft] ${stderr.trim()}`)
})

// The point is answering while you are away, so hold off idle sleep.
const keepAwake = Bun.spawn(['/usr/bin/caffeinate', '-i', '-w', String(process.pid)], { stdio: ['ignore', 'ignore', 'ignore'] })
// Everything `shutdown` touches now exists, so a crash from here on can go
// through it rather than exiting on the spot.
running = true

let stopping = false
async function shutdown(code: number): Promise<never> {
  if (!stopping) {
    stopping = true
    craft.kill()
    keepAwake.kill()
    await agent.stop()
  }
  process.exit(code)
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
  process.on(signal, () => void shutdown(0))

const menubarStartedAt = Date.now()
const exitCode = await craft.exited
console.log(`[uplink] menubar exited (${exitCode})`)

// Quit from the popover or the menu goes through the agent, so it is known to
// be the person's. Anything else that ends the menubar cleanly is macOS: the
// "Quit & Reopen" System Settings offers after Full Disk Access is switched on
// quits the menubar and then reopens nothing, which left Uplink closed at the
// one moment setup needed it running. So open it again. Not after a crash, and
// not for a menubar that died at once, which would only loop.
const bundle = process.execPath.match(/^(.*?\.app)\/Contents\/MacOS\//)?.[1]
if (!stopping && !agent.quitRequested && exitCode === 0 && bundle && Date.now() - menubarStartedAt > 10_000) {
  console.log('[uplink] macOS quit the menubar; opening Uplink again')
  stopping = true
  keepAwake.kill()
  // Stopped first, so the new copy finds the single-instance lock free.
  await agent.stop()
  Bun.spawn(['/usr/bin/open', '-n', bundle], { stdio: ['ignore', 'ignore', 'ignore'] }).unref()
  process.exit(0)
}
await shutdown(0)
