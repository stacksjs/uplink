import type { EngineEvent } from '../../../app/Uplink/engine'
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearJsonFlagCache, CodexEngine, summarizeItem } from '../../../app/Uplink/codex-engine'

const dir = mkdtempSync(join(tmpdir(), 'uplink-codex-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => clearJsonFlagCache())

let counter = 0

/**
 * A stand-in `codex` printing the JSONL that `codex exec --json` really emits,
 * captured from a run of codex-cli 0.155: a thread.started carrying the id, a
 * turn.started, one item.completed per thing the agent did, and a
 * turn.completed carrying token usage and no cost.
 *
 * It also answers `exec --help`, because the engine asks the binary which
 * spelling of the JSONL flag it offers before using it.
 */
function stubCodex(options: { events?: object[], exit?: number, stderr?: string, jsonFlag?: string, lastMessage?: string } = {}): string {
  const path = join(dir, `codex-${counter += 1}`)
  const events = options.events ?? [
    { type: 'thread.started', thread_id: 'th-9' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'git log --oneline -3', exit_code: 0 } },
    { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Chiefs 24-21' } },
    { type: 'turn.completed', usage: { input_tokens: 15119, cached_input_tokens: 12032, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } },
  ]
  const lines = events.map(event => `echo '${JSON.stringify(event)}'`).join('\n')
  // `-o <file>` is the last-message file; the real CLI writes it on success only.
  const writeLast = options.lastMessage === undefined
    ? `for a in "$@"; do if [ "$prev" = "--output-last-message" ]; then printf '%s' "${options.lastMessage ?? 'Chiefs 24-21'}" > "$a"; fi; prev="$a"; done`
    : `for a in "$@"; do if [ "$prev" = "--output-last-message" ]; then printf '%s' "${options.lastMessage}" > "$a"; fi; prev="$a"; done`

  writeFileSync(path, `#!/bin/sh
if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then
  echo "Usage: codex exec [OPTIONS] [PROMPT]"
  echo "      ${options.jsonFlag ?? '--json'}"
  echo "          Print events to stdout as JSONL"
  exit 0
fi
printf '%s\\n' "$@" > "${path}.args"
pwd > "${path}.cwd"
prev=""
${writeLast}
${lines}
${options.stderr ? `echo "${options.stderr}" >&2` : ''}
exit ${options.exit ?? 0}
`)
  chmodSync(path, 0o755)
  return path
}

function engine(bin: string, overrides: Partial<{ model: string | null, permission: 'bypass' | 'workspace-write', timeoutMs: number }> = {}): CodexEngine {
  return new CodexEngine({
    bin,
    model: overrides.model ?? null,
    permission: overrides.permission ?? 'bypass',
    systemPrompt: 'Answer in plain text.',
    timeoutMs: overrides.timeoutMs ?? 10_000,
  })
}

/**
 * The flags, one per line. The prompt is deliberately excluded: it carries the
 * system prompt and is many lines long, so it would otherwise be scattered
 * across this array. Use `rawArgsOf` to assert on it.
 */
function argsOf(bin: string): string[] {
  return rawArgsOf(bin).split('\n').filter(line => line.startsWith('-') || !line.includes(' '))
}

function rawArgsOf(bin: string): string {
  return readFileSync(`${bin}.args`, 'utf8').trim()
}

describe('CodexEngine', () => {
  it('parses the event stream into a result and events', async () => {
    const bin = stubCodex()
    const events: EngineEvent[] = []
    const result = await engine(bin).run({ prompt: 'scores?', cwd: dir, onEvent: e => events.push(e) }).done

    expect(result.ok).toBe(true)
    expect(result.text).toBe('Chiefs 24-21')
    expect(result.sessionId).toBe('th-9')
    // Codex reports tokens and no dollar figure, so a cost here would be invented.
    expect(result.costCents).toBeNull()
    expect(result.turns).toBe(1)
    expect(result.authFailure).toBe(false)

    expect(events).toContainEqual({ kind: 'session', sessionId: 'th-9' })
    expect(events).toContainEqual({ kind: 'text', text: 'Chiefs 24-21' })
    expect(events).toContainEqual({ kind: 'tool', name: 'command_execution', summary: 'command_execution: git log --oneline -3' })
  })

  it('always passes --skip-git-repo-check, because the default workdir is not a repo', async () => {
    const bin = stubCodex()
    await engine(bin).run({ prompt: 'x', cwd: dir }).done
    expect(argsOf(bin)).toContain('--skip-git-repo-check')
  })

  it('starts a fresh run with exec, --cd and the bypass flag', async () => {
    const bin = stubCodex()
    await engine(bin).run({ prompt: 'scores?', cwd: dir }).done
    const args = argsOf(bin)

    expect(args[0]).toBe('exec')
    expect(args).toContain('--json')
    expect(args.slice(args.indexOf('--cd'), args.indexOf('--cd') + 2)).toEqual(['--cd', dir])
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox')
    // No --append-system-prompt exists, so the instructions ride on the prompt,
    // which is why the prompt is many lines and the last argv line is not it.
    const raw = rawArgsOf(bin)
    expect(raw).toContain('Answer in plain text.')
    expect(raw).toEndWith('scores?')
    expect(readFileSync(`${bin}.cwd`, 'utf8').trim()).toEndWith(dir.replace(/^\/private/, ''))
  })

  it('resumes through the subcommand, with the session id positional', async () => {
    const bin = stubCodex()
    await engine(bin).run({ prompt: 'who won?', cwd: dir, sessionId: 'th-7' }).done
    const args = argsOf(bin)

    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'th-7'])
    // `resume` rejects both of these with "unexpected argument" and exit 2.
    expect(args).not.toContain('--cd')
    expect(args).not.toContain('--sandbox')
  })

  it('sets a non-bypass sandbox through -c, which resume accepts', async () => {
    const bin = stubCodex()
    await engine(bin, { permission: 'workspace-write' }).run({ prompt: 'x', cwd: dir, sessionId: 'th-7' }).done
    const args = argsOf(bin)

    expect(args).not.toContain('--sandbox')
    expect(args.slice(args.indexOf('--config'), args.indexOf('--config') + 2))
      .toEqual(['--config', 'sandbox_mode="workspace-write"'])
  })

  it('passes the model only when one is set', async () => {
    const withModel = stubCodex()
    await engine(withModel, { model: 'gpt-5-codex' }).run({ prompt: 'x', cwd: dir }).done
    const args = argsOf(withModel)
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'gpt-5-codex'])

    clearJsonFlagCache()
    const without = stubCodex()
    await engine(without).run({ prompt: 'x', cwd: dir }).done
    expect(argsOf(without)).not.toContain('--model')
  })

  it('uses the version spelling of the JSONL flag that the binary offers', async () => {
    const bin = stubCodex({ jsonFlag: '--experimental-json' })
    await engine(bin).run({ prompt: 'x', cwd: dir }).done
    const args = argsOf(bin)
    expect(args).toContain('--experimental-json')
    expect(args).not.toContain('--json')
  })

  it('falls back to the streamed message when the last-message file is absent', async () => {
    // The real CLI does not write that file when a turn fails, so the stream has
    // to be the source of truth.
    const bin = stubCodex({ lastMessage: '' })
    const result = await engine(bin).run({ prompt: 'x', cwd: dir }).done
    expect(result.text).toBe('Chiefs 24-21')
  })

  it('reports a turn.failed as a failure', async () => {
    const bin = stubCodex({
      events: [
        { type: 'thread.started', thread_id: 'th-9' },
        { type: 'turn.failed', error: { message: 'context window exceeded' } },
      ],
      exit: 1,
      lastMessage: '',
    })
    const result = await engine(bin).run({ prompt: 'x', cwd: dir }).done
    expect(result.ok).toBe(false)
    expect(result.text).toContain('context window exceeded')
    expect(result.sessionId).toBe('th-9')
  })

  it('flags a signed-out CLI from the failure text', async () => {
    const bin = stubCodex({
      events: [],
      exit: 1,
      stderr: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
      lastMessage: '',
    })
    const result = await engine(bin).run({ prompt: 'x', cwd: dir }).done
    expect(result.ok).toBe(false)
    expect(result.authFailure).toBe(true)
  })

  it('cancels a run', async () => {
    const bin = stubCodex()
    const run = engine(bin).run({ prompt: 'x', cwd: dir })
    run.cancel()
    const result = await run.done
    expect(result.ok).toBe(false)
    expect(result.text).toBe('Stopped.')
  })

  describe('probe', () => {
    it('is signed in when codex login status exits 0', async () => {
      const path = join(dir, `codex-login-ok-${counter += 1}`)
      // The real CLI prints this on stderr, not stdout.
      writeFileSync(path, '#!/bin/sh\necho "Logged in using ChatGPT" >&2\nexit 0\n')
      chmodSync(path, 0o755)
      expect(await engine(path).probe()).toEqual({ ok: true, detail: 'Logged in using ChatGPT' })
    })

    it('is not signed in when it exits non-zero', async () => {
      const path = join(dir, `codex-login-bad-${counter += 1}`)
      writeFileSync(path, '#!/bin/sh\necho "Not logged in" >&2\nexit 1\n')
      chmodSync(path, 0o755)
      const probe = await engine(path).probe()
      expect(probe.ok).toBe(false)
      expect(probe.detail).toContain('Not logged in')
    })

    it('says so when the binary is missing', async () => {
      const probe = await engine(join(dir, 'not-installed')).probe()
      expect(probe.ok).toBe(false)
      expect(probe.detail).toContain('Is Codex installed?')
    })
  })
})

describe('summarizeItem', () => {
  it('reads whichever descriptive field an item carries', () => {
    expect(summarizeItem({ type: 'command_execution', command: 'bun test' })).toBe('command_execution: bun test')
    expect(summarizeItem({ type: 'web_search', query: 'nfl scores' })).toBe('web_search: nfl scores')
    expect(summarizeItem({ type: 'file_change', path: '/Users/someone/Code/app.ts' })).toBe('file_change: ~/Code/app.ts')
    // Unknown kinds still produce a line, because the set is not closed.
    expect(summarizeItem({ type: 'something_new' })).toBe('something_new')
  })
})
