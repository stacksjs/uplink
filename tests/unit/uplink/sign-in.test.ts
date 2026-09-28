import { afterAll, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lastWords, renderScreen, SignIn, tokenFromOutput } from '../../../app/Uplink/sign-in'

const TOKEN = `sk-ant-oat01-${'Ab3_-'.repeat(19)}`
const dir = mkdtempSync(join(tmpdir(), 'uplink-signin-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function stub(name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

async function settle(signIn: SignIn): Promise<void> {
  for (let i = 0; i < 200 && signIn.running; i++)
    await Bun.sleep(25)
}

describe('renderScreen', () => {
  it('keeps a character the interface skipped because it was already there', () => {
    // What Claude Code sent: the `o` of `oat01` was on screen from an earlier
    // frame, so the redraw jumped over it with ESC[9G.
    const sent = `Welcomeo\r\x1B[1Gsk-ant-\x1B[9Gat01-${TOKEN.slice(13)}\r\n`
    expect(renderScreen(sent).split('\n')[0]).toBe(TOKEN)
  })

  it('applies erases and moves the way a terminal does', () => {
    expect(renderScreen('abc\x1B[2K\rxy')).toBe('xy')
    expect(renderScreen('one\r\ntwo\x1B[1A\x1B[1GONE')).toBe('ONE\ntwo')
    expect(renderScreen('\x1B[?25l\x1B[>4m\x1B[<u\x1B(Bplain\x1B[0m')).toBe('plain')
  })
})

describe('tokenFromOutput', () => {
  it('reads the token through the colour codes a terminal UI draws', () => {
    const drawn = `\x1B[2K\x1B[1GYour OAuth token (valid for 1 year):\r\n\r\n\x1B[1m${TOKEN}\x1B[22m\r\n\r\nUse this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>`
    expect(tokenFromOutput(drawn)).toBe(TOKEN)
  })

  it('finds nothing before the token is printed', () => {
    expect(tokenFromOutput('Opening browser to sign in...\r\nPaste code here if prompted > ')).toBeNull()
  })
})

describe('lastWords', () => {
  it('is words, never the control codes a closing interface sends', () => {
    expect(lastWords('OAuth error: access denied\r\n\x1B(B\x1B[>4m\x1B[<u 7 8 \x1B[>4m\x1B[<u')).toBe('OAuth error: access denied')
  })
})

describe('SignIn', () => {
  it('captures the token a CLI prints, on a terminal wide enough for it', async () => {
    // Prints the width it was given, so a wrap would show.
    const cli = stub('claude', `echo "cols $(tput cols)"; sleep 0.2; printf 'Your OAuth token (valid for 1 year):\\n\\n${TOKEN}\\n\\nStore this token securely.\\n'; sleep 30`)
    const tokens: string[] = []
    const signIn = new SignIn()
    signIn.start({ command: [cli, 'setup-token'], onToken: token => void tokens.push(token) })
    expect(signIn.running).toBe(true)
    signIn.start({ command: [cli, 'setup-token'], onToken: token => void tokens.push(token) })
    await settle(signIn)
    expect(tokens).toEqual([TOKEN])
    expect(signIn.state.phase).toBe('done')
  }, 15_000)

  it('treats a clean exit as done when there is no token to read', async () => {
    const signIn = new SignIn()
    let done = false
    signIn.start({ command: [stub('codex', 'echo "Successfully logged in"'), 'login'], onDone: () => { done = true } })
    await settle(signIn)
    expect(signIn.state.phase).toBe('done')
    expect(done).toBe(true)
  }, 15_000)

  it('says why when the CLI gives up', async () => {
    const signIn = new SignIn()
    signIn.start({ command: [stub('claude-fails', 'echo "OAuth error: access denied"; exit 1'), 'setup-token'], onToken: () => {} })
    await settle(signIn)
    expect(signIn.state).toEqual({ phase: 'failed', detail: 'Sign-in did not finish: OAuth error: access denied' })
  }, 15_000)

  it('gives up after its timeout', async () => {
    const signIn = new SignIn()
    signIn.start({ command: [stub('claude-slow', 'sleep 30'), 'setup-token'], onToken: () => {}, timeoutMs: 300 })
    await settle(signIn)
    expect(signIn.state.phase).toBe('failed')
    expect(signIn.state.detail).toContain('timed out')
  }, 15_000)
})
