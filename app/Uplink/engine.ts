import type { Subprocess } from 'bun'
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

export interface Engine {
  run: (request: EngineRequest) => EngineRun
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

export class ClaudeEngine implements Engine {
  constructor(private readonly options: ClaudeEngineOptions) {}

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

    const proc: Subprocess<'ignore', 'pipe', 'pipe'> = Bun.spawn([this.options.bin, ...this.args(request)], {
      cwd: request.cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...this.options.env },
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
