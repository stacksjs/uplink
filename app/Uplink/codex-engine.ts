import type { Subprocess } from 'bun'
import type { Engine, EngineProbe, EngineRequest, EngineResult, EngineRun } from './engine'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { PROBE_TIMEOUT_MS } from './engine'
import { truncate } from './format'

/**
 * Runs a prompt through the OpenAI Codex CLI in its non-interactive mode
 * (`codex exec`).
 *
 * Same reasoning as the Claude engine: going through the CLI uses whatever
 * account it is logged into - a ChatGPT plan via `codex login`, no API key
 * needed - and brings Codex's own toolset and each repository's AGENTS.md.
 *
 * Four things about this CLI differ from Claude Code and shape everything
 * below. They were confirmed against a real run, not read off documentation.
 *
 *  1. Resuming is a subcommand, `codex exec resume <id> <prompt>`, not a flag.
 *     It accepts neither `-C/--cd` nor `-s/--sandbox`, so a resumed run takes
 *     its working directory from the recorded session. Session lookup is
 *     filtered by cwd, so the process still has to be spawned in the right
 *     directory.
 *  2. There is no `--append-system-prompt`. Uplink's instructions are prepended
 *     to the prompt instead, which works on every version.
 *  3. Codex refuses to run outside a git repository without
 *     `--skip-git-repo-check`, and Uplink's default working directory is the
 *     home directory. The flag is mandatory, not optional.
 *  4. The JSONL flag is spelled `--json` on some versions and
 *     `--experimental-json` on others, and without it the CLI prints prose
 *     there is nothing to parse. It is resolved against the installed binary
 *     rather than hardcoded.
 */

export interface CodexEngineOptions {
  bin: string
  model?: string | null
  /**
   * How much the agent may do without asking. `bypass` is the equivalent of
   * Claude Code's `bypassPermissions`, which is what Uplink has always used:
   * the point of the product is that nobody is at the Mac to approve anything.
   */
  permission: CodexPermission
  systemPrompt: string
  timeoutMs: number
  env?: Record<string, string | undefined>
}

export type CodexPermission = 'bypass' | 'danger-full-access' | 'workspace-write' | 'read-only'

export const CODEX_PERMISSIONS: readonly CodexPermission[] = ['bypass', 'danger-full-access', 'workspace-write', 'read-only']

/** A 401 from the backend, which is what a signed-out CLI produces. */
const UNAUTHORIZED = /\b401\b|unauthorized|missing bearer|not logged in|no codex credentials/i

export class CodexEngine implements Engine {
  readonly id = 'codex' as const
  readonly label = 'Codex'
  readonly authFailureHint = 'run "codex login" on the Mac (or "codex login --device-auth" over SSH)'

  constructor(private readonly options: CodexEngineOptions) {}

  /**
   * `codex login status` exits 0 and says which account when signed in. Unlike
   * Claude Code, proof of life costs nothing here: no turn is spent, so this
   * can be checked as often as the UI likes.
   */
  async probe(): Promise<EngineProbe> {
    try {
      const proc = Bun.spawn([this.options.bin, 'login', 'status'], {
        cwd: tmpdir(),
        env: this.env(),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS)
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      const exitCode = await proc.exited
      clearTimeout(timer)
      const said = truncate((out.trim() || err.trim()) || 'Codex said nothing', 140)
      return exitCode === 0
        ? { ok: true, detail: said }
        : { ok: false, detail: said === 'Codex said nothing' ? 'Not signed in yet.' : said }
    }
    catch {
      return { ok: false, detail: `Could not run ${this.options.bin}. Is Codex installed?` }
    }
  }

  /**
   * Which spelling of the JSONL flag this binary offers, asked once per binary
   * per process. The two are not interchangeable and passing the wrong one
   * fails silently: the CLI prints prose instead of events and the run looks
   * empty rather than broken. `--help` is inert, so asking is cheap and safe.
   */
  resolveJsonFlag(): Promise<string> {
    return resolveJsonFlag(this.options.bin, this.env())
  }

  args(request: EngineRequest, jsonFlag: string, lastMessageFile: string): string[] {
    const prompt = `${this.options.systemPrompt}\n\n---\n\n${request.prompt}`

    // `codex exec resume` accepts a much shorter flag list than `codex exec`:
    // `--sandbox` and `--cd` are both rejected with "unexpected argument" and
    // exit 2. So the sandbox is set through `-c sandbox_mode=`, which both
    // forms accept, and only a fresh run gets `--cd`.
    const permission = this.options.permission === 'bypass'
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--config', `sandbox_mode="${this.options.permission}"`]

    const args = request.sessionId
      ? ['exec', 'resume', request.sessionId]
      : ['exec']

    args.push(jsonFlag, '--skip-git-repo-check', '--output-last-message', lastMessageFile)
    // Resume has no --cd: it takes the working directory from the recorded
    // session, which is why the process is spawned in `request.cwd` regardless.
    if (!request.sessionId)
      args.push('--cd', request.cwd)
    args.push(...permission)
    if (this.options.model)
      args.push('--model', this.options.model)
    args.push(prompt)
    return args
  }

  run(request: EngineRequest): EngineRun {
    const started = Date.now()
    let cancelled = false
    let timedOut = false
    const lastMessageFile = join(tmpdir(), `uplink-codex-${randomUUID()}.txt`)

    let proc: Subprocess<'ignore', 'pipe', 'pipe'> | null = null
    const killTree = (): void => {
      if (!proc)
        return
      try {
        process.kill(-proc.pid, 'SIGTERM')
      }
      catch {
        proc.kill('SIGTERM')
      }
    }

    let timer: ReturnType<typeof setTimeout> | null = null

    const done = (async (): Promise<EngineResult> => {
      const jsonFlag = await this.resolveJsonFlag()

      proc = Bun.spawn([this.options.bin, ...this.args(request, jsonFlag, lastMessageFile)], {
        cwd: request.cwd,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: this.env(),
        // Its own process group, so stopping a run also stops what the agent
        // started. Killing only `codex` leaves those holding stdout open and
        // the run never ends.
        detached: true,
      })

      // Cancelling before the process existed still has to take effect.
      if (cancelled) {
        killTree()
        return failure('Stopped.', request.sessionId ?? null, Date.now() - started)
      }

      timer = setTimeout(() => {
        timedOut = true
        killTree()
      }, this.options.timeoutMs)

      let sessionId = request.sessionId ?? null
      let lastText = ''
      let turns = 0
      let failed: string | null = null

      const handle = (line: string): void => {
        const event = parseLine(line)
        if (!event)
          return
        switch (event.type) {
          case 'thread.started': {
            const id = typeof event.thread_id === 'string' ? event.thread_id : null
            if (id && id !== sessionId) {
              sessionId = id
              request.onEvent?.({ kind: 'session', sessionId: id })
            }
            break
          }
          case 'item.completed': {
            const item = event.item as Record<string, any> | undefined
            if (!item)
              break
            if (item.type === 'agent_message') {
              const text = String(item.text ?? '')
              if (text.trim()) {
                lastText = text
                request.onEvent?.({ kind: 'text', text })
              }
            }
            // `reasoning` is the model thinking aloud, not an action worth
            // texting as progress. Everything else is something it did.
            else if (item.type !== 'reasoning') {
              request.onEvent?.({ kind: 'tool', name: String(item.type ?? 'tool'), summary: summarizeItem(item) })
            }
            break
          }
          case 'turn.completed':
            turns += 1
            break
          case 'turn.failed':
            failed = errorText(event) ?? 'the turn failed'
            break
        }
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
      if (timer)
        clearTimeout(timer)
      const errorOutput = (await stderr).trim()
      const durationMs = Date.now() - started

      // The last message is written to a file as well as streamed, so a stream
      // this version spells differently still yields the answer.
      const fromFile = await readAndRemove(lastMessageFile)

      if (cancelled)
        return failure('Stopped.', sessionId, durationMs)
      if (timedOut)
        return failure(`Timed out after ${Math.round(this.options.timeoutMs / 60000)} minutes.`, sessionId, durationMs)

      const text = (fromFile || lastText).trim()

      if (exitCode === 0 && !failed) {
        return {
          ok: true,
          text: text || 'Done.',
          sessionId,
          // Codex reports tokens, never a cost. A figure invented from a price
          // table would read as measured, the way Claude's genuinely is.
          costCents: null,
          durationMs,
          turns: turns || null,
          authFailure: false,
        }
      }

      const reason = failed ?? errorOutput ?? ''
      const said = truncate(reason || text || `codex exited with code ${exitCode}`, 400)
      return { ...failure(said, sessionId, durationMs), authFailure: await this.looksUnauthenticated(said) }
    })()

    return {
      done,
      cancel: () => {
        cancelled = true
        killTree()
      },
    }
  }

  /**
   * Asked rather than pattern-matched where possible. A regex over failure text
   * is how Claude's engine has to do it, but Codex will answer the question
   * directly, and a wrong answer here sends someone to the wrong fix.
   */
  private async looksUnauthenticated(said: string): Promise<boolean> {
    if (UNAUTHORIZED.test(said))
      return true
    const probe = await this.probe()
    return !probe.ok
  }

  private env(): Record<string, string | undefined> {
    return { ...process.env, ...this.options.env }
  }
}

/** One answer per binary, for the life of the process. */
const jsonFlags = new Map<string, Promise<string>>()

export function resolveJsonFlag(bin: string, env: Record<string, string | undefined>): Promise<string> {
  const cached = jsonFlags.get(bin)
  if (cached)
    return cached
  const resolved = (async (): Promise<string> => {
    try {
      const proc = Bun.spawn([bin, 'exec', '--help'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env })
      const help = await new Response(proc.stdout).text()
      await proc.exited
      // Prefer the plain spelling when a version offers both.
      if (/(^|\s)--json(\s|$)/m.test(help))
        return '--json'
      return /--experimental-json/.test(help) ? '--experimental-json' : '--json'
    }
    catch {
      return '--json'
    }
  })()
  jsonFlags.set(bin, resolved)
  return resolved
}

/** Forget the cached answers. For tests, which use a different stub per case. */
export function clearJsonFlagCache(): void {
  jsonFlags.clear()
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

function errorText(event: Record<string, any>): string | null {
  const error = event.error ?? event.message
  if (typeof error === 'string')
    return error
  if (error && typeof error.message === 'string')
    return error.message
  return null
}

/**
 * One human-readable line for something the agent did. The item kinds beyond
 * `agent_message` and `reasoning` are not a closed set across versions, so this
 * reads whichever descriptive field is present rather than switching on a name.
 */
export function summarizeItem(item: Record<string, any>): string {
  const name = String(item.type ?? 'tool')
  const detail = item.command ?? item.path ?? item.query ?? item.url ?? item.name ?? item.text ?? ''
  const shown = typeof detail === 'string'
    ? detail.replace(/^\/Users\/[^/]+/, '~')
    : Array.isArray(detail) ? detail.join(' ') : ''
  return shown ? `${name}: ${truncate(shown, 80)}` : name
}

async function readAndRemove(path: string): Promise<string> {
  try {
    const file = Bun.file(path)
    const text = await file.exists() ? await file.text() : ''
    rmSync(path, { force: true })
    return text
  }
  catch {
    return ''
  }
}
