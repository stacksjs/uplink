import type { Subprocess } from 'bun'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { truncate } from './format'

/**
 * Runs a prompt through Claude Code in headless mode (`claude -p`).
 *
 * Going through the CLI rather than the API is the point: it uses whatever
 * account the CLI is logged into - a Claude Max subscription, via
 * `claude setup-token` - and it brings Claude Code's whole toolset (web
 * search, file edits, shell) plus each repository's CLAUDE.md, hooks and
 * settings. A text saying "improve ~/Code/stacks with X" gets exactly the
 * agent you would get at the keyboard.
 */

export interface EngineRequest {
  prompt: string
  cwd: string
  /** Resume this Claude Code session so a thread keeps its context. */
  sessionId?: string | null
  onEvent?: (event: EngineEvent) => void
}

export type EngineEvent =
  | { kind: 'session', sessionId: string }
  | { kind: 'tool', name: string, summary: string }
  | { kind: 'text', text: string }

export interface EngineResult {
  ok: boolean
  text: string
  sessionId: string | null
  /** Integer cents. On a Max plan this is what the run would have cost via the API, not a charge. */
  costCents: number | null
  durationMs: number
  turns: number | null
  /** Set when the failure is the CLI's login, so the reply can say so. */
  authFailure: boolean
}

export interface EngineRun {
  done: Promise<EngineResult>
  cancel: () => void
}

/** Which agent CLI answers a text. */
export type EngineId = 'claude' | 'codex'

export const ENGINE_IDS: readonly EngineId[] = ['claude', 'codex']

export function isEngineId(value: string): value is EngineId {
  return (ENGINE_IDS as readonly string[]).includes(value)
}

/**
 * Why an engine cannot answer. These are three different problems with three
 * different next steps, and setup used to collapse them into one: a missing
 * binary was reported inside the "Sign in" step, which sends the person to run
 * a command that does not exist either.
 */
export type ProbeReason = 'ok' | 'missing' | 'signed-out' | 'failed'

/** Whether a CLI can answer right now, for the doctor and the menubar. */
export interface EngineProbe {
  ok: boolean
  reason: ProbeReason
  detail: string
}

/** Where to get an engine that is not installed. */
export interface EngineInstall {
  command: string
  url: string
}

/** True when `bin` is something this machine can actually run. */
export function binaryExists(bin: string): boolean {
  // An absolute path from findClaude/findCodex, or a bare name to resolve
  // against PATH, which the launchers widen before anything spawns.
  return bin.includes('/') ? Bun.file(bin).size > 0 : Bun.which(bin) !== null
}

export interface Engine {
  readonly id: EngineId
  /** How the engine is named to a person: "Claude Code", "Codex". */
  readonly label: string
  /**
   * What to text back when a run failed on authentication. The person is away
   * from the Mac, so this has to name the CLI and the exact command.
   */
  readonly authFailureHint: string
  /** How to install this CLI, for a Mac that does not have it. */
  readonly install: EngineInstall
  run: (request: EngineRequest) => EngineRun
  /**
   * Can this CLI answer right now. Separate from `run` because setup has to
   * answer it before any text arrives, and because the two CLIs disagree on
   * what proof of life costs: Claude spends a turn, Codex does not.
   */
  probe: () => Promise<EngineProbe>
}

export interface ClaudeEngineOptions {
  bin: string
  model?: string | null
  permissionMode: string
  systemPrompt: string
  timeoutMs: number
  env?: Record<string, string | undefined>
}

const AUTH_FAILURE = /failed to authenticate|oauth|invalid api key|please run \/login|not logged in|credit balance/i

/** A probe that hangs is worse than one that fails: setup shows "Checking" for ever. */
export const PROBE_TIMEOUT_MS = 60_000

export class ClaudeEngine implements Engine {
  readonly id = 'claude' as const
  readonly label = 'Claude Code'
  readonly authFailureHint = 'run "claude setup-token" on the Mac and give Uplink the token'
  readonly install: EngineInstall = {
    command: 'bun install -g @anthropic-ai/claude-code',
    url: 'https://docs.claude.com/en/docs/claude-code',
  }

  constructor(private readonly options: ClaudeEngineOptions) {}

  /**
   * One real turn, on the cheapest model. Only asking "is a token set" passed a
   * token truncated at the terminal's 80-column wrap: set, well-formed, and
   * rejected with a 401 on first use.
   */
  async probe(): Promise<EngineProbe> {
    // Asked before spawning, because a missing binary and a logged-out one are
    // different problems and Bun throws rather than exiting 127 for the former.
    if (!binaryExists(this.options.bin))
      return { ok: false, reason: 'missing', detail: 'Claude Code is not installed on this Mac.' }

    try {
      const proc = Bun.spawn([this.options.bin, '-p', 'Reply with exactly: ok', '--model', 'haiku', '--output-format', 'json'], {
        cwd: tmpdir(),
        env: this.env(),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS)
      const text = await new Response(proc.stdout).text()
      clearTimeout(timer)
      await proc.exited
      const result = JSON.parse(text) as { is_error?: boolean, result?: string }
      if (result.is_error) {
        const said = truncate(result.result ?? 'Claude did not answer', 140)
        return AUTH_FAILURE.test(said)
          ? { ok: false, reason: 'signed-out', detail: 'Not signed in yet.' }
          : { ok: false, reason: 'failed', detail: said }
      }
      return {
        ok: true,
        reason: 'ok',
        detail: this.env().CLAUDE_CODE_OAUTH_TOKEN ? 'Signed in with your token' : 'Signed in through the Claude CLI',
      }
    }
    catch (error) {
      return { ok: false, reason: 'failed', detail: `Could not run ${this.options.bin}: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /**
   * A .env copied from .env.example carries `CLAUDE_CODE_OAUTH_TOKEN=`; an
   * empty token must not stand in for the CLI's own login. The probe needs the
   * same treatment as a run, or a fresh install reports a failure a real run
   * would not have.
   */
  private env(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env, ...this.options.env }
    if (!env.CLAUDE_CODE_OAUTH_TOKEN)
      delete env.CLAUDE_CODE_OAUTH_TOKEN
    return env
  }

  args(request: EngineRequest): string[] {
    const args = [
      '-p',
      request.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      this.options.permissionMode,
      '--append-system-prompt',
      this.options.systemPrompt,
    ]
    if (this.options.model)
      args.push('--model', this.options.model)
    if (request.sessionId)
      args.push('--resume', request.sessionId)
    return args
  }

  run(request: EngineRequest): EngineRun {
    const started = Date.now()
    let cancelled = false
    let timedOut = false

    const env = this.env()

    const proc: Subprocess<'ignore', 'pipe', 'pipe'> = Bun.spawn([this.options.bin, ...this.args(request)], {
      cwd: request.cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env,
      // Its own process group, so stopping a run also stops what the agent
      // started (shell commands, test runners, dev servers). Killing only
      // `claude` leaves those holding stdout open, and the run never ends.
      detached: true,
    })

    const killTree = (): void => {
      try {
        process.kill(-proc.pid, 'SIGTERM')
      }
      catch {
        proc.kill('SIGTERM')
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, this.options.timeoutMs)

    const done = (async (): Promise<EngineResult> => {
      let sessionId = request.sessionId ?? null
      let result: Record<string, any> | null = null
      let lastText = ''

      const handle = (line: string): void => {
        const event = parseLine(line)
        if (!event)
          return
        if (typeof event.session_id === 'string' && event.session_id !== sessionId) {
          sessionId = event.session_id
          request.onEvent?.({ kind: 'session', sessionId: event.session_id })
        }
        if (event.type === 'assistant') {
          for (const block of event.message?.content ?? []) {
            if (block.type === 'tool_use') {
              request.onEvent?.({ kind: 'tool', name: block.name, summary: summarizeTool(block.name, block.input) })
            }
            else if (block.type === 'text' && block.text?.trim()) {
              lastText = block.text
              request.onEvent?.({ kind: 'text', text: block.text })
            }
          }
        }
        if (event.type === 'result')
          result = event
      }

      const stderr = new Response(proc.stderr).text()
      const decoder = new TextDecoder()
      let buffered = ''
      for await (const bytes of proc.stdout) {
        buffered += decoder.decode(bytes, { stream: true })
        let newline = buffered.indexOf('\n')
        while (newline !== -1) {
          handle(buffered.slice(0, newline))
          buffered = buffered.slice(newline + 1)
          newline = buffered.indexOf('\n')
        }
      }
      if (buffered.trim())
        handle(buffered)

      const exitCode = await proc.exited
      clearTimeout(timer)
      const errorOutput = (await stderr).trim()
      const durationMs = Date.now() - started
      const final = result as Record<string, any> | null

      if (cancelled)
        return failure('Stopped.', sessionId, durationMs)
      if (timedOut)
        return failure(`Timed out after ${Math.round(this.options.timeoutMs / 60000)} minutes.`, sessionId, durationMs)

      if (final) {
        const text = String(final.result ?? lastText ?? '').trim()
        const isError = final.is_error === true || final.subtype !== 'success'
        return {
          ok: !isError,
          text: text || (isError ? 'The agent failed without saying why.' : 'Done.'),
          sessionId: final.session_id ?? sessionId,
          costCents: typeof final.total_cost_usd === 'number' ? Math.round(final.total_cost_usd * 100) : null,
          durationMs: typeof final.duration_ms === 'number' ? final.duration_ms : durationMs,
          turns: typeof final.num_turns === 'number' ? final.num_turns : null,
          authFailure: isError && AUTH_FAILURE.test(text),
        }
      }

      const reason = errorOutput || `claude exited with code ${exitCode} and no result`
      return { ...failure(truncate(reason, 400), sessionId, durationMs), authFailure: AUTH_FAILURE.test(reason) }
    })()

    return {
      done,
      cancel: () => {
        cancelled = true
        killTree()
      },
    }
  }
}

function failure(text: string, sessionId: string | null, durationMs: number): EngineResult {
  return { ok: false, text, sessionId, costCents: null, durationMs, turns: null, authFailure: false }
}

function parseLine(line: string): Record<string, any> | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{'))
    return null
  try {
    return JSON.parse(trimmed)
  }
  catch {
    return null
  }
}

/** One human-readable line for a tool call: "Edit router.ts", "Bash: bun test". */
export function summarizeTool(name: string, input: Record<string, any> | undefined): string {
  const detail = input?.file_path ?? input?.path ?? input?.command ?? input?.pattern
    ?? input?.query ?? input?.url ?? input?.description ?? input?.prompt ?? ''
  const shown = typeof detail === 'string' ? detail.replace(/^\/Users\/[^/]+/, '~') : ''
  return shown ? `${name}: ${truncate(shown, 80)}` : name
}
