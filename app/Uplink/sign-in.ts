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

/** Long-lived Claude tokens: `sk-ant-oat01-` and a long tail. */
const TOKEN = /sk-ant-oat\d+-[\w-]{40,}/g

/** Ten minutes to find the browser tab and approve, then give up. */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000

const ROWS = 50

/**
 * What a terminal would show after `output`, as text.
 *
 * Not the output with its control codes removed. Claude Code's interface
 * redraws only the characters that changed since the last frame and jumps the
 * cursor over the rest (`ESC[nG`), so a character that already sat in a column
 * is never sent again - the token's `o` came from the welcome banner above it.
 * Removing the codes left "sk-ant- at01-...", which is no token at all. Replaying
 * the cursor movements onto a grid gives back what the person would have read.
 */
export function renderScreen(output: string): string {
  const lines: string[][] = [[]]
  let row = 0
  let col = 0
  const top = (): number => Math.max(0, lines.length - ROWS)
  const line = (): string[] => (lines[row] ??= [])

  for (let i = 0; i < output.length;) {
    const ch = output.charAt(i)
    if (ch === '\x1B') {
      const rest = output.slice(i, i + 64)
      const csi = /^\x1B\[([0-9;?<>=]*)[ -/]*([@-~])/.exec(rest)
      if (csi) {
        const params = csi[1] ?? ''
        const private_ = /^[?<>=]/.test(params)
        const [a = 0, b = 0] = params.replace(/^[?<>=]/, '').split(';').map(n => Number(n) || 0)
        const n = Math.max(1, a)
        if (!private_) {
          switch (csi[2]) {
            case 'G': case '`': col = n - 1; break
            case 'C': col += n; break
            case 'D': col = Math.max(0, col - n); break
            case 'A': row = Math.max(0, row - n); break
            case 'B': row += n; break
            case 'E': row += n; col = 0; break
            case 'F': row = Math.max(0, row - n); col = 0; break
            case 'H': case 'f': row = top() + Math.max(1, a) - 1; col = Math.max(1, b) - 1; break
            case 'K': {
              const current = line()
              if (a === 0)
                current.length = Math.min(current.length, col)
              else if (a === 1)
                current.fill(' ', 0, Math.min(col + 1, current.length))
              else
                current.length = 0
              break
            }
            case 'J':
              if (a === 0) {
                line().length = Math.min(line().length, col)
                lines.length = row + 1
              }
              else {
                lines.length = top()
                lines.push([])
                row = lines.length - 1
                col = 0
              }
              break
          }
        }
        i += csi[0].length
        continue
      }
      const other = /^\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|^\x1B[()][0-9A-Za-z]|^\x1B[\s\S]/.exec(rest)
      i += other ? other[0].length : 1
      continue
    }
    if (ch === '\r')
      col = 0
    else if (ch === '\n')
      row++
    else if (ch === '\b')
      col = Math.max(0, col - 1)
    else if (ch >= ' ') {
      const current = line()
      while (current.length < col)
        current.push(' ')
      current[col++] = ch
    }
    i++
  }
  return Array.from(lines, l => (l ?? []).join('').trimEnd()).join('\n')
}

/**
 * The token a `claude setup-token` run printed, read off the screen it drew,
 * or null. The longest match wins, so a frame caught mid-draw cannot beat the
 * finished one.
 */
export function tokenFromOutput(output: string): string | null {
  const matches = renderScreen(output).match(TOKEN) ?? []
  return matches.sort((a, b) => b.length - a.length)[0] ?? null
}

/** The screen's last line of words, for saying why a sign-in stopped. */
export function lastWords(output: string): string | null {
  return renderScreen(output).split('\n').map(l => l.trim()).filter(l => /[a-z]{3}/i.test(l) && !/sk-ant-oat\d+-/.test(l)).at(-1) ?? null
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
          // The line after the token means the token itself is complete: a
          // chunk can end halfway through it.
          if (/Store this token|CLAUDE_CODE_OAUTH_TOKEN=/.test(renderScreen(output)))
            void takeToken()
              .catch(error => this.fail(error instanceof Error ? error.message : String(error)))
              .finally(() => proc.kill())
        },
      },
    })
    this.proc = proc

    let taking: Promise<void> | null = null
    function takeToken(): Promise<void> {
      return taking ??= (async () => {
        const token = tokenFromOutput(output)
        if (!token || !options.onToken)
          return
        captured = true
        await options.onToken(token)
      })()
    }

    const timer = setTimeout(() => {
      this.fail('Sign-in timed out. Try again when you are ready to approve it in the browser.')
      proc.kill()
    }, options.timeoutMs ?? SIGN_IN_TIMEOUT_MS)

    void proc.exited.then(async (code) => {
      clearTimeout(timer)
      this.proc = null
      if (this.current.phase === 'failed')
        return
      // The CLI exits by itself once it has printed the token.
      if (options.onToken && !captured) {
        try {
          await takeToken()
        }
        catch (error) {
          this.fail(error instanceof Error ? error.message : String(error))
          return
        }
      }
      if (captured || (code === 0 && !options.onToken)) {
        this.current = { phase: 'done', detail: 'Signed in.' }
        await options.onDone?.()
        return
      }
      const said = lastWords(output)
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
