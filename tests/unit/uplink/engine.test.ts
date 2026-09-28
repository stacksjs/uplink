import type { EngineEvent } from '../../../app/Uplink/engine'
import { afterAll, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeEngine, summarizeTool } from '../../../app/Uplink/engine'
import { chunk, toPlainText } from '../../../app/Uplink/format'
import { detectWorkdir } from '../../../app/Uplink/workdir'

const dir = mkdtempSync(join(tmpdir(), 'uplink-engine-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/**
 * A stand-in `claude` that prints the stream-json Claude Code emits: an init
 * event, an assistant turn with a tool call, and a result. It records its
 * argv and cwd so the test can check what Uplink asked for.
 */
function stubClaude(result: Record<string, unknown>, extra = ''): string {
  const path = join(dir, `claude-${Math.random().toString(36).slice(2)}`)
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'sess-9' },
    { type: 'assistant', session_id: 'sess-9', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'NFL scores today' } }] } },
    { type: 'result', session_id: 'sess-9', ...result },
  ].map(line => `echo '${JSON.stringify(line)}'`).join('\n')
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "${path}.args"\npwd > "${path}.cwd"\n${extra}\n${lines}\n`)
  chmodSync(path, 0o755)
  return path
}

function engine(bin: string, timeoutMs = 10_000): ClaudeEngine {
  return new ClaudeEngine({ bin, permissionMode: 'bypassPermissions', systemPrompt: 'be brief', timeoutMs, model: 'sonnet' })
}

describe('ClaudeEngine', () => {
  it('passes the prompt, session and cwd, and parses the stream', async () => {
    const bin = stubClaude({ subtype: 'success', is_error: false, result: 'Chiefs 24-21', total_cost_usd: 0.0249, duration_ms: 4200, num_turns: 3 })
    const events: EngineEvent[] = []
    const run = engine(bin).run({ prompt: 'scores?', cwd: dir, sessionId: 'prev', onEvent: e => events.push(e) })
    const result = await run.done

    expect(result).toEqual({ ok: true, text: 'Chiefs 24-21', sessionId: 'sess-9', costCents: 2, durationMs: 4200, turns: 3, authFailure: false })
    expect(events).toContainEqual({ kind: 'session', sessionId: 'sess-9' })
    expect(events).toContainEqual({ kind: 'tool', name: 'WebSearch', summary: 'WebSearch: NFL scores today' })

    const args = (await Bun.file(`${bin}.args`).text()).trim().split('\n')
    expect(args.slice(0, 2)).toEqual(['-p', 'scores?'])
    expect(args).toContain('stream-json')
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', 'prev'])
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'sonnet'])
    expect((await Bun.file(`${bin}.cwd`).text()).trim()).toEndWith(dir.replace(/^\/private/, ''))
  })

  it('flags a logged-out CLI', async () => {
    const bin = stubClaude({ subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' })
    const result = await engine(bin).run({ prompt: 'x', cwd: dir }).done
    expect(result.ok).toBe(false)
    expect(result.authFailure).toBe(true)
  })

  it('reports a crash without a result event', async () => {
    const path = join(dir, 'claude-crash')
    writeFileSync(path, '#!/bin/sh\necho "boom: something broke" >&2\nexit 3\n')
    chmodSync(path, 0o755)
    const result = await engine(path).run({ prompt: 'x', cwd: dir }).done
    expect(result).toMatchObject({ ok: false, text: 'boom: something broke' })
  })

  it('cancels and times out', async () => {
    const slow = stubClaude({ subtype: 'success', is_error: false, result: 'late' }, 'sleep 5')
    const cancelled = engine(slow).run({ prompt: 'x', cwd: dir })
    setTimeout(() => cancelled.cancel(), 50)
    expect(await cancelled.done).toMatchObject({ ok: false, text: 'Stopped.' })

    const timedOut = await engine(slow, 100).run({ prompt: 'x', cwd: dir }).done
    expect(timedOut.ok).toBe(false)
    expect(timedOut.text).toStartWith('Timed out')
  })

  it('summarizes tool calls in one short line', () => {
    expect(summarizeTool('Bash', { command: 'bun test' })).toBe('Bash: bun test')
    expect(summarizeTool('Edit', { file_path: '/Users/someone/Code/x.ts' })).toBe('Edit: ~/Code/x.ts')
    expect(summarizeTool('TodoWrite', {})).toBe('TodoWrite')
  })
})

describe('format', () => {
  it('strips markdown to plain text', () => {
    expect(toPlainText('## Scores\n\n**Chiefs** 24, *Bills* 21\n\n- one\n* two\n\n[ESPN](https://espn.com)\n\n```ts\nconst x = 1\n```'))
      .toBe('Scores\n\nChiefs 24, Bills 21\n\n- one\n- two\n\nESPN (https://espn.com)\n\nconst x = 1')
  })

  it('splits on the best boundary and never exceeds the limit', () => {
    const text = 'First paragraph here.\n\nSecond paragraph is a bit longer than the first one.'
    expect(chunk(text, 40)).toEqual(['First paragraph here.', 'Second paragraph is a bit longer than', 'the first one.'])
    for (const part of chunk('x'.repeat(250), 100))
      expect(part.length).toBeLessThanOrEqual(100)
  })
})

describe('detectWorkdir', () => {
  it('runs a task inside the repository it names', () => {
    const home = join(dir, 'home')
    mkdirSync(join(home, 'Code', 'stacks', '.git'), { recursive: true })
    mkdirSync(join(home, 'Code', 'stacks', 'storage', 'framework'), { recursive: true })

    expect(detectWorkdir('please improve ~/Code/stacks with feature xyz', '/fallback', home)).toBe(join(home, 'Code', 'stacks'))
    expect(detectWorkdir('look at ~/Code/stacks/storage/framework/nope.ts.', '/fallback', home)).toBe(join(home, 'Code', 'stacks'))
    expect(detectWorkdir('whats the NFL score', '/fallback', home)).toBe('/fallback')
    expect(detectWorkdir('clean up ~', '/fallback', home)).toBe('/fallback')
  })
})
