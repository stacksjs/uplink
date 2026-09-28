import type { CodexPermission } from './codex-engine'
import type { EngineId } from './engine'
import type { UplinkConfig } from './types'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { applyEnvVarsToConfig } from 'bunfig'
import defaults from '../../config/uplink'
import { CODEX_PERMISSIONS } from './codex-engine'
import { isEngineId } from './engine'
import { parseHandleList } from './handles'

export type { UplinkConfig }

/**
 * Reads `config/uplink.ts`, applies the `UPLINK_*` environment over it, then
 * resolves what a config file cannot state: paths written with `~`, and where
 * the agent CLIs actually are on this Mac.
 *
 * The environment step is bunfig's own `applyEnvVarsToConfig`, the same
 * mechanism the rest of the Stacks family uses, rather than a hand-rolled
 * reader. It derives the variable name from the key, so `pollMs` is
 * `UPLINK_POLL_MS`, and coerces to the type of the default: numbers with
 * `Number`, booleans from "true", and a comma separated list into an array.
 *
 * Note it is NOT `loadConfig({ name: 'uplink', checkEnv: true })`, which looks
 * like the obvious call and would break every variable documented in
 * `.env.example`. bunfig applies the environment to `defaultConfig` and then
 * merges the config file OVER the result, so a key present in `config/uplink.ts`
 * would silently ignore its `UPLINK_*` variable. Uplink is configured through
 * `.env`, so the file is the defaults and the environment wins.
 */
export function loadConfig(env: Env = process.env): UplinkConfig {
  const applied = withEnv(env, () => applyEnvVarsToConfig('uplink', defaults) as UplinkConfig)

  return {
    ...applied,
    // Normalized rather than trusted: a handle can be written "(555) 123-4567"
    // in a config file as easily as in a variable.
    allowed: parseHandleList(applied.allowed.join(',')),
    messagesDb: expandHome(applied.messagesDb),
    workdir: expandHome(applied.workdir),
    engine: engineId(applied.engine),
    claudeBin: expandHome(applied.claudeBin) || findClaude(),
    // UPLINK_MODEL predates the second engine and meant Claude's model alias,
    // so an existing .env keeps working.
    claudeModel: applied.claudeModel || env.UPLINK_MODEL || null,
    codexBin: expandHome(applied.codexBin) || findCodex(),
    codexModel: applied.codexModel || null,
    codexPermission: codexPermission(applied.codexPermission),
  }
}

type Env = Record<string, string | undefined>

/**
 * `applyEnvVarsToConfig` reads `process.env` and takes no environment argument,
 * so an injected one is installed for the duration of the call. The call is
 * synchronous, so nothing else observes the swap.
 *
 * The downloadable app is the reason this exists: it has no `.env` and builds
 * an environment from `settings.json` instead.
 */
function withEnv<T>(env: Env, read: () => T): T {
  if (env === process.env)
    return read()
  const real = process.env
  process.env = env as NodeJS.ProcessEnv
  try {
    return read()
  }
  finally {
    process.env = real
  }
}

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.replace(/^~\//, `${homedir()}/`)
}

function engineId(value: string | undefined): EngineId {
  return value && isEngineId(value) ? value : 'claude'
}

function codexPermission(value: string | undefined): CodexPermission {
  return value && (CODEX_PERMISSIONS as readonly string[]).includes(value)
    ? value as CodexPermission
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
    // `bun install -g` and an npm global prefix, both of which the PATH the
    // launchers build also covers.
    join(homedir(), '.bun', 'bin', 'claude'),
    join(homedir(), '.npm-global', 'bin', 'claude'),
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
