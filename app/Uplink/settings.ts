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
/**
 * Rotate past this. The watcher polls every two seconds and appends whatever
 * it finds, so the file is unbounded on a Mac that is simply left running.
 * One rotation is kept as `Uplink.log.1`, because the lines leading up to a
 * crash are the ones worth reading and a rotation triggered by that crash's
 * own output would otherwise throw them away.
 */
export const LOG_MAX_BYTES = 5 * 1024 * 1024

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

/**
 * One test per field, `undefined` meaning "not a value this build can use".
 *
 * Both directions go through these: reading a file written by a hand, an older
 * build or a half-finished save, and taking a field from the popover. Writing
 * the checks twice is how the two drift, and it is the read path that cannot
 * afford to be wrong: it runs before the menubar exists.
 */
const FIELDS: { [K in keyof Settings]: (value: unknown) => Settings[K] | undefined } = {
  allowed: value => Array.isArray(value) ? value.map(String).map(handle => handle.trim()).filter(Boolean) : undefined,
  engine: value => typeof value === 'string' && isEngineId(value) ? value : undefined,
  model: value => value === null || (typeof value === 'string' && value !== '') ? (value as string | null) : undefined,
  workdir: value => typeof value === 'string' && value !== '' ? value : undefined,
  openAtLogin: value => typeof value === 'boolean' ? value : undefined,
  paused: value => typeof value === 'boolean' ? value : undefined,
}

/**
 * Every field of `input` this build can use, and `base` for every field it
 * cannot. Never throws, whatever `input` is.
 *
 * `base` is what distinguishes the two callers: the defaults when reading a
 * file, which must always produce usable settings, and the current settings
 * when taking a partial update from the popover.
 */
export function coerceSettings(input: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const fields = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const settings = { ...base }
  for (const key of Object.keys(FIELDS) as Array<keyof Settings>) {
    const value = FIELDS[key](fields[key])
    if (value !== undefined)
      Object.assign(settings, { [key]: value })
  }
  return settings
}

/**
 * Always usable settings, because this is read at the desktop agent's first
 * statements: a throw here is a launchd restart loop, and the menubar that
 * would have explained it never starts. Only `engine` used to be checked, so
 * an `allowed` that was not an array reached `settingsEnv` and took the app
 * down on every launch, invisibly.
 */
export function readSettings(path: string = SETTINGS_PATH): Settings {
  if (!existsSync(path))
    return { ...DEFAULT_SETTINGS }
  try {
    return coerceSettings(JSON.parse(readFileSync(path, 'utf8')))
  }
  catch {
    // Not JSON at all.
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
