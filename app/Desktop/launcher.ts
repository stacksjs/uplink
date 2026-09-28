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
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { format } from 'node:util'
import pkg from '../../package.json'
import { agentPath } from '../Uplink/agent-path'
import { acquireSingleInstance, startDesktopAgent } from '../Uplink/desktop-agent'
import { LOG_PATH } from '../Uplink/settings'

// Launched from Finder or from its own LaunchAgent, this process gets the bare
// launchd PATH, and everything below it inherits that: the engines, their
// probes, and osascript. Widen it once, here, before anything spawns. Without
// this a `claude` installed by bun, npm or nvm is invisible to the app on a Mac
// where it works in a terminal.
process.env.PATH = agentPath()

// Launched from Finder or at login there is no terminal, so keep a log where
// Console.app looks for one.
if (!process.stdout.isTTY) {
  mkdirSync(dirname(LOG_PATH), { recursive: true })
  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => appendFileSync(LOG_PATH, `${new Date().toISOString()} ${format(...args)}\n`)
  }
}

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

const agent = await startDesktopAgent({ version: pkg.version })
console.log(`[uplink] ${pkg.version} serving the menubar on 127.0.0.1:${agent.port}`)

// Headless: the status item appears and the popover stays hidden until it is
// clicked, or until the page opens it because setup is unfinished.
const craft = Bun.spawn([
  craftRuntime(),
  `http://127.0.0.1:${agent.port}/`,
  '--title',
  'Uplink',
  '--system-tray',
  '--headless',
  '--frameless',
  '--always-on-top',
  '--no-resize',
  '--width',
  '380',
  '--height',
  '600',
], { stdio: ['ignore', 'ignore', 'pipe'] })

void new Response(craft.stderr).text().then((stderr) => {
  if (stderr.trim())
    console.error(`[craft] ${stderr.trim()}`)
})

// The point is answering while you are away, so hold off idle sleep.
const keepAwake = Bun.spawn(['/usr/bin/caffeinate', '-i', '-w', String(process.pid)], { stdio: ['ignore', 'ignore', 'ignore'] })

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

// Quitting from the menu ends the Craft runtime; the app ends with it.
const exitCode = await craft.exited
console.log(`[uplink] menubar exited (${exitCode})`)
await shutdown(0)
