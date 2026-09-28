import type { EngineId } from './engine'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isEngineId } from './engine'

/**
 * Settings for the downloadable app, which has no .env: a JSON file for
 * preferences and the macOS Keychain for the Claude token.
 *
 * The token goes in the Keychain rather than the settings file because it
 * signs in to a paid account: a file in Application Support is readable by
 * anything running as the user, and gets swept into backups and dotfile repos.
 */

export const DATA_DIR = join(homedir(), 'Library', 'Application Support', 'Uplink')
export const SETTINGS_PATH = join(DATA_DIR, 'settings.json')
export const DATABASE_PATH = join(DATA_DIR, 'uplink.sqlite')
export const LOG_PATH = join(homedir(), 'Library', 'Logs', 'Uplink.log')

const KEYCHAIN_SERVICE = 'com.stacksjs.uplink'
// Claude Code's token. Codex keeps its own credentials in CODEX_HOME via
// `codex login`, so there is nothing of its to store here.
const KEYCHAIN_ACCOUNT = 'claude-oauth-token'

export interface Settings {
  /** Handles allowed to command Uplink. Empty: this Mac's own handles. */
  allowed: string[]
  /** Which agent CLI answers a text. */
  engine: EngineId
  /** Claude's model alias for runs, or null for the CLI's default. */
  model: string | null
  /** Where a run starts when a text names no path. */
  workdir: string
  /** Whether the menubar app starts at login. */
  openAtLogin: boolean
  /** Pause: read nothing, answer nothing, until resumed. */
  paused: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  allowed: [],
  engine: 'claude',
  model: null,
  workdir: homedir(),
  openAtLogin: true,
  paused: false,
}

export function readSettings(path: string = SETTINGS_PATH): Settings {
  if (!existsSync(path))
    return { ...DEFAULT_SETTINGS }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Settings>
    const settings = { ...DEFAULT_SETTINGS, ...parsed }
    // A hand-edited or downgraded file can name an engine this build does not
    // have. Falling back beats refusing to start.
    if (!isEngineId(String(settings.engine)))
      settings.engine = DEFAULT_SETTINGS.engine
    return settings
  }
  catch {
    // A hand-edited file with a typo must not stop the app from starting.
    return { ...DEFAULT_SETTINGS }
  }
}

export function writeSettings(settings: Settings, path: string = SETTINGS_PATH): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
}

/**
 * The environment `loadConfig` reads, built from settings instead of .env.
 * Anything already in the real environment still wins, for debugging.
 */
export function settingsEnv(settings: Settings, env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  return {
    UPLINK_ALLOWED: settings.allowed.join(','),
    UPLINK_ENGINE: settings.engine,
    UPLINK_MODEL: settings.model ?? '',
    UPLINK_WORKDIR: settings.workdir,
    ...Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('UPLINK_'))),
  }
}

export function readToken(): string | null {
  const result = Bun.spawnSync(['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'], { stderr: 'ignore' })
  const token = result.exitCode === 0 ? result.stdout.toString().trim() : ''
  return token || null
}

export function writeToken(token: string): void {
  // -U updates an existing item. The token goes on argv only for the
  // lifetime of this call; `security` has no stdin form for -w.
  const result = Bun.spawnSync(['security', 'add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-l', 'Uplink Claude token', '-w', token], { stderr: 'pipe' })
  if (result.exitCode !== 0)
    throw new Error(`Could not save the token to the Keychain: ${result.stderr.toString().trim()}`)
}

export function deleteToken(): void {
  Bun.spawnSync(['security', 'delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT], { stderr: 'ignore', stdout: 'ignore' })
}

/**
 * A token as pasted from `claude setup-token` or a terminal: the paste often
 * carries the line break a narrow terminal wrapped it at (the first attempt at
 * this app lost the second half of one that way), so whitespace is removed.
 */
export function cleanToken(pasted: string): string {
  return pasted.replace(/\s+/g, '')
}

export function tokenLooksValid(token: string): boolean {
  return /^sk-ant-[a-z0-9]+-[\w-]{40,}$/i.test(token)
}
