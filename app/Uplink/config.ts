import type { CodexPermission } from './codex-engine'
import type { EngineId } from './engine'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { CODEX_PERMISSIONS } from './codex-engine'
import { isEngineId } from './engine'
import { parseHandleList } from './handles'
import { DEFAULT_MESSAGES_DB } from './messages-db'

export interface UplinkConfig {
  /** Handles allowed to command Uplink. Empty means "my own handles only". */
  allowed: string[]
  messagesDb: string
  pollMs: number
  /** On start, ignore commands older than this, so a Mac waking up does not replay a day of texts. */
  catchUpMs: number
  replyPrefix: string
  /** Characters per text; longer replies are split. */
  maxChars: number
  /** Parts sent at once; the rest waits for "more". */
  maxParts: number
  /** Send "Working on it" once a run passes this. 0 disables. */
  ackAfterMs: number
  /** Send a progress line this often during long runs. 0 disables. */
  progressEveryMs: number
  /** A thread idle longer than this starts a fresh agent session. */
  sessionIdleMs: number
  workdir: string
  /** Which agent CLI answers a text, unless a thread says otherwise. */
  engine: EngineId
  claudeBin: string
  claudeModel: string | null
  /** How much Claude Code may do without asking. */
  permissionMode: string
  codexBin: string
  codexModel: string | null
  /** How much Codex may do without asking. The two CLIs spell this differently. */
  codexPermission: CodexPermission
  timeoutMs: number
}

type Env = Record<string, string | undefined>

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name]
  const value = raw === undefined || raw === '' ? Number.NaN : Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function str(env: Env, name: string, fallback: string): string {
  const raw = env[name]
  return raw === undefined || raw === '' ? fallback : raw
}

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.replace(/^~\//, `${homedir()}/`)
}

const MINUTE = 60_000

/** From .env in the Stacks app; the downloadable app passes `settingsEnv(settings)`. */
export function loadConfig(env: Env = process.env): UplinkConfig {
  return {
    allowed: parseHandleList(env.UPLINK_ALLOWED),
    messagesDb: expandHome(str(env, 'UPLINK_MESSAGES_DB', DEFAULT_MESSAGES_DB)),
    pollMs: int(env, 'UPLINK_POLL_MS', 2000),
    catchUpMs: int(env, 'UPLINK_CATCH_UP_MS', 30 * MINUTE),
    replyPrefix: str(env, 'UPLINK_REPLY_PREFIX', '🛰 '),
    maxChars: int(env, 'UPLINK_MAX_CHARS', 1200),
    maxParts: int(env, 'UPLINK_MAX_PARTS', 3),
    ackAfterMs: int(env, 'UPLINK_ACK_AFTER_MS', 20_000),
    progressEveryMs: int(env, 'UPLINK_PROGRESS_EVERY_MS', 10 * MINUTE),
    sessionIdleMs: int(env, 'UPLINK_SESSION_IDLE_MS', 6 * 60 * MINUTE),
    workdir: expandHome(str(env, 'UPLINK_WORKDIR', homedir())),
    engine: engineId(env.UPLINK_ENGINE),
    claudeBin: expandHome(str(env, 'UPLINK_CLAUDE_BIN', findClaude())),
    // UPLINK_MODEL predates the second engine and meant Claude's model alias,
    // so an existing .env keeps working.
    claudeModel: env.UPLINK_CLAUDE_MODEL || env.UPLINK_MODEL || null,
    permissionMode: str(env, 'UPLINK_PERMISSION_MODE', 'bypassPermissions'),
    codexBin: expandHome(str(env, 'UPLINK_CODEX_BIN', findCodex())),
    codexModel: env.UPLINK_CODEX_MODEL || null,
    codexPermission: codexPermission(env.UPLINK_CODEX_PERMISSION),
    timeoutMs: int(env, 'UPLINK_TIMEOUT_MS', 90 * MINUTE),
  }
}

function engineId(value: string | undefined): EngineId {
  return value && isEngineId(value) ? value : 'claude'
}

function codexPermission(value: string | undefined): CodexPermission {
  return value && (CODEX_PERMISSIONS as readonly string[]).includes(value)
    ? value as CodexPermission
    // Claude Code runs with bypassPermissions, because nobody is at the Mac to
    // approve anything. Codex's equivalent is the same trade, spelled its way.
    : 'bypass'
}

/**
 * launchd starts agents with a bare PATH, so `claude` from an interactive
 * shell is not necessarily findable. Check where the installers put it.
 */
function findClaude(): string {
  const fromPath = Bun.which('claude')
  if (fromPath)
    return fromPath
  for (const candidate of [
    join(homedir(), '.local', 'bin', 'claude'),
    join(homedir(), '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]) {
    if (Bun.file(candidate).size > 0)
      return candidate
  }
  return 'claude'
}

/**
 * The same bare-PATH problem as findClaude, plus one path that is easy to miss:
 * the ChatGPT desktop app bundles its own codex binary and does not put it on
 * PATH. On a Mac with ChatGPT installed that is the working Codex, so a search
 * that skips it reports Codex missing on a machine that has it.
 */
function findCodex(): string {
  const fromPath = Bun.which('codex')
  if (fromPath)
    return fromPath
  for (const candidate of [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    join(homedir(), '.local', 'bin', 'codex'),
    join(homedir(), '.bun', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ]) {
    if (Bun.file(candidate).size > 0)
      return candidate
  }
  return 'codex'
}

export function systemPrompt(config: UplinkConfig): string {
  return [
    'You are Uplink, reached by text message. The user is away from this Mac and texting from a phone,',
    'often over a satellite connection with no internet access of their own: your reply is the only way',
    'they see anything. So:',
    '- Answer in plain text. No markdown, no tables, no code blocks, no headings.',
    `- Be brief. Aim for under 500 characters; never pad. Replies over ${config.maxChars} characters are split across texts.`,
    '- For anything live (scores, weather, news, prices, schedules), search the web, then give the answer itself, not links.',
    '- For work on this Mac (code, files, repos under ~/Code), do the whole task autonomously, verify it',
    '  (tests, typecheck, lint as the repo expects), and follow each repo\'s CLAUDE.md / AGENTS.md. Do not',
    '  ask clarifying questions unless the request is truly ambiguous; pick the sensible reading and say which.',
    '- Only commit, push, deploy or send anything outward if the text asks for it.',
    '- Finish with a short summary of what you did and anything that still needs the user.',
    `- The user's home directory is ${homedir()}.`,
  ].join('\n')
}
