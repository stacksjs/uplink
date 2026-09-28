import type { Subprocess } from 'bun'

/**
 * Signing in without a terminal.
 *
 * `claude setup-token` and `codex login` both finish with a browser round trip
 * to a localhost callback, so the app can run them itself: the person approves
 * in the browser and nothing else. For Claude, the token the CLI prints is read
 * straight into the Keychain rather than copied by hand, which is how a token
 * cut at the terminal's 80-column wrap was once saved and then rejected.
 *
 * Both CLIs draw an interactive terminal UI, so they run in a pseudo-terminal
 * (Bun's own; macOS `script` refuses the socket Bun hands it as input). It is
 * far wider than a token, so the token is printed on one line.
 */

const ANSI = /\x1B\[[0-9;?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[@-Z\\-_]/g

/** Long-lived Claude tokens: `sk-ant-oat01-` and a long tail. */
const TOKEN = /sk-ant-oat\d+-[\w-]{40,}/g

/** Ten minutes to find the browser tab and approve, then give up. */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000

/**
 * Text without terminal control codes. Each code becomes a space rather than
 * nothing: a redraw that erases a half-printed line and prints it again would
 * otherwise read as the two run together.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, ' ')
}

/**
 * The token a `claude setup-token` run printed, or null. The longest match
 * wins: a terminal UI redraws, and a redraw caught halfway through is a
 * prefix of the real thing.
 */
export function tokenFromOutput(output: string): string | null {
  const matches = stripAnsi(output).match(TOKEN) ?? []
  return matches.sort((a, b) => b.length - a.length)[0] ?? null
}

export type SignInPhase = 'idle' | 'waiting' | 'done' | 'failed'

export interface SignInState {
  phase: SignInPhase
  detail: string
}

export interface SignInOptions {
  /** The CLI, and the arguments that sign it in. */
  command: string[]
  /** For Claude: called with the token it printed. */
  onToken?: (token: string) => Promise<void> | void
  /** Called when the CLI exits successfully, token or not. */
  onDone?: () => Promise<void> | void
  env?: Record<string, string | undefined>
  timeoutMs?: number
}

/**
 * One sign-in at a time. `start` is a no-op while one is waiting, so a second
 * click, or setup advancing again, cannot open a second browser tab.
 */
export class SignIn {
  private proc: Subprocess | null = null
  private current: SignInState = { phase: 'idle', detail: '' }

  get state(): SignInState {
    return this.current
  }

  get running(): boolean {
    return this.current.phase === 'waiting'
  }

  start(options: SignInOptions): void {
    if (this.running)
      return
    this.current = { phase: 'waiting', detail: 'Approve Uplink in the browser tab that opened.' }

    let output = ''
    let captured = false
    const decoder = new TextDecoder()
    const proc = Bun.spawn(options.command, {
      env: { ...process.env, ...options.env },
      terminal: {
        cols: 1000,
        rows: 50,
        data: (_terminal, chunk) => {
          output += decoder.decode(chunk, { stream: true })
          if (!options.onToken || captured)
            return
          // Wait for the token's line to end: a chunk can split it.
          const printed = /Your OAuth token[\s\S]*sk-ant-oat\d+-[\w-]+\s/.test(stripAnsi(output))
          const token = printed ? tokenFromOutput(output) : null
          if (!token)
            return
          captured = true
          void Promise.resolve(options.onToken(token))
            .catch(error => this.fail(error instanceof Error ? error.message : String(error)))
            .finally(() => proc.kill())
        },
      },
    })
    this.proc = proc

    const timer = setTimeout(() => {
      this.fail('Sign-in timed out. Try again when you are ready to approve it in the browser.')
      proc.kill()
    }, options.timeoutMs ?? SIGN_IN_TIMEOUT_MS)

    void proc.exited.then(async (code) => {
      clearTimeout(timer)
      this.proc = null
      if (this.current.phase === 'failed')
        return
      if (captured || (code === 0 && !options.onToken)) {
        this.current = { phase: 'done', detail: 'Signed in.' }
        await options.onDone?.()
        return
      }
      const said = stripAnsi(output).split('\n').map(line => line.trim()).filter(Boolean).at(-1)
      this.fail(said ? `Sign-in did not finish: ${said.slice(0, 160)}` : 'Sign-in did not finish.')
    })
  }

  cancel(): void {
    this.proc?.kill()
    this.proc = null
    this.current = { phase: 'idle', detail: '' }
  }

  private fail(detail: string): void {
    this.current = { phase: 'failed', detail }
  }
}
