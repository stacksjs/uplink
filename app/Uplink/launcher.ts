/* eslint-disable no-console */
/**
 * `Uplink.app/Contents/MacOS/Uplink` - what launchd starts.
 *
 * Reading Messages needs Full Disk Access, and macOS grants that per app.
 * TCC charges a child process's access to the app that launched it, so this
 * tiny binary is the one thing that needs the grant: it runs
 * `./buddy uplink:watch` in the app directory, and the watcher, osascript and
 * every `claude` run below it inherit Uplink's permissions - rather than
 * granting Full Disk Access to `bun`, which every script on the machine runs.
 *
 * It also keeps the Mac from idle-sleeping while it runs (`caffeinate -i`):
 * the whole point is answering while you are away from it.
 *
 * Compiled by `buddy uplink:install` with the app directory baked in.
 */
import { join } from 'node:path'
import process from 'node:process'

declare const UPLINK_APP_DIR: string

const appDir = process.env.UPLINK_APP_DIR || UPLINK_APP_DIR
const home = process.env.HOME ?? ''

// launchd hands agents a bare PATH; the watcher shells out to claude, git and osascript.
const PATH = [
  join(appDir, 'pantry', '.bin'),
  join(home, '.local', 'bin'),
  join(home, '.bun', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  process.env.PATH ?? '',
].filter(Boolean).join(':')

const watcher = Bun.spawn([join(appDir, 'buddy'), 'uplink:watch'], {
  cwd: appDir,
  env: { ...process.env, PATH },
  stdio: ['ignore', 'inherit', 'inherit'],
})

// Read from launchd's environment, not .env (this binary never loads .env).
const keepAwake = process.env.UPLINK_KEEP_AWAKE === 'false'
  ? null
  : Bun.spawn(['/usr/bin/caffeinate', '-i', '-w', String(watcher.pid)], { stdio: ['ignore', 'ignore', 'ignore'] })

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    watcher.kill(signal)
    keepAwake?.kill()
  })
}

const code = await watcher.exited
keepAwake?.kill()
console.log(`[uplink] watcher exited with ${code}`)
process.exit(code ?? 1)
