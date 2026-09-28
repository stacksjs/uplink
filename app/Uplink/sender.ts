/**
 * Sends replies through the Messages app with AppleScript.
 *
 * The text travels as an `osascript` argument rather than being spliced into
 * the script source, so quotes, backslashes and newlines in a reply can never
 * break (or inject into) the script.
 *
 * The first send asks once for permission to control Messages (System
 * Settings > Privacy & Security > Automation).
 */

export interface ReplyTarget {
  chatGuid: string
  handle: string
  service: string
}

/**
 * Whether macOS will let this process drive Messages.
 *
 * The grant is per app and per process identity: the watcher inside Uplink.app
 * and `buddy uplink:doctor` under Terminal are two different subjects, so a
 * result is only ever about the process that asked.
 */
export interface AutomationState {
  ok: boolean
  reason: 'ok' | 'denied' | 'failed'
  detail: string
}

export interface Sender {
  send: (target: ReplyTarget, text: string) => Promise<void>
  /**
   * Can this process send at all. The first call raises the macOS Automation
   * prompt, which is the point of having it: it has to happen while someone is
   * at the Mac, not on the first real reply to a phone that then hears nothing.
   */
  canSend: () => Promise<AutomationState>
}

const SCRIPT = `
on run argv
  set theText to item 1 of argv
  set chatGuid to item 2 of argv
  set theHandle to item 3 of argv
  set serviceName to item 4 of argv
  tell application "Messages"
    try
      send theText to chat id chatGuid
    on error
      if serviceName is "SMS" then
        set theService to 1st account whose service type = SMS
      else
        set theService to 1st account whose service type = iMessage
      end if
      send theText to participant theHandle of theService
    end try
  end tell
end run
`

/**
 * Reads from Messages and sends nothing, so it can be run during setup and on
 * demand. Counting accounts needs exactly the Automation permission a real
 * reply needs.
 */
const PROBE_SCRIPT = 'tell application "Messages" to count of accounts'

/** macOS error -1743 is "not authorized to send Apple events". */
const NOT_AUTHORIZED = /-1743|not authori[sz]ed|not allowed to send|doesn't have permission/i

/** -1712 is an AppleEvent timeout, which a busy or starting Messages produces. */
const TIMED_OUT = /-1712|timed out/i

/** Long enough for someone to read the macOS prompt and click Allow. */
const PROBE_TIMEOUT_MS = 60_000

export class AppleScriptSender implements Sender {
  async canSend(): Promise<AutomationState> {
    try {
      const proc = Bun.spawn(['osascript', '-e', PROBE_SCRIPT], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
      // The prompt itself blocks the script until someone answers it, and a
      // busy or starting Messages can time out on its own, so this waits
      // generously rather than reporting a refusal that has not happened.
      const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS)
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
      clearTimeout(timer)

      if (code === 0)
        return { ok: true, reason: 'ok', detail: 'Uplink can send through Messages' }

      const said = stderr.trim()
      if (NOT_AUTHORIZED.test(said))
        return { ok: false, reason: 'denied', detail: 'macOS has not been allowed to let Uplink control Messages' }

      // A timeout is not a refusal. Say so, because the two want different
      // things from the person reading it.
      return TIMED_OUT.test(said)
        ? { ok: false, reason: 'failed', detail: 'Messages did not answer in time. It may still be starting up.' }
        : { ok: false, reason: 'failed', detail: said || `osascript exited ${code}` }
    }
    catch (error) {
      return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) }
    }
  }

  async send(target: ReplyTarget, text: string): Promise<void> {
    const proc = Bun.spawn(
      ['osascript', '-e', SCRIPT, text, target.chatGuid, target.handle, target.service === 'SMS' ? 'SMS' : 'iMessage'],
      { stdout: 'ignore', stderr: 'pipe' },
    )
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    if (code !== 0)
      throw new Error(`Messages refused to send (osascript exit ${code}): ${stderr.trim()}`)
  }
}
