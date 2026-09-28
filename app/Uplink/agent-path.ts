import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

/**
 * The PATH an Uplink process needs.
 *
 * launchd hands agents a bare PATH, and Uplink shells out to `claude`, `codex`,
 * `git` and `osascript`. The from-source launcher has always built this list;
 * the downloadable app did not, so a `claude` installed by bun, npm or nvm was
 * invisible to it on a Mac where it works perfectly in a terminal. Both use
 * this now, so the two cannot drift.
 *
 * The user's own locations come first: Uplink's bundled tools must not shadow
 * the CLI a person deliberately installed. Whatever PATH already exists is kept
 * last, so a real environment (a terminal, a debugging session) still wins over
 * nothing.
 */
export function agentPath(options: { appDir?: string, env?: Record<string, string | undefined> } = {}): string {
  const env = options.env ?? process.env
  const home = env.HOME ?? homedir()

  return [
    // Where the installers put the agent CLIs.
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    // The from-source install's own pinned toolchain, after the user's.
    options.appDir ? join(options.appDir, 'pantry', '.bin') : '',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    env.PATH ?? '',
  ].filter(Boolean).join(':')
}
