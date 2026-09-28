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

export interface Sender {
  send: (target: ReplyTarget, text: string) => Promise<void>
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

export class AppleScriptSender implements Sender {
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
