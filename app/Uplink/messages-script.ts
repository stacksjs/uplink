// Hold the lock in the native process so it survives a restart of the caller.
// Texts uses the same per-user lock when it sends through Messages.
const TRANSACTION = `
ObjC.import('AppKit')
ObjC.bindFunction('mkdir', ['int', ['char *', 'int']])
ObjC.bindFunction('open', ['int', ['char *', 'int']])
ObjC.bindFunction('flock', ['int', ['int', 'int']])
ObjC.bindFunction('close', ['int', ['int']])
ObjC.bindFunction('kill', ['int', ['int', 'int']])

function waitUntil(deadline, complete) {
  while (!complete() && Date.now() < deadline)
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05))
  return complete()
}

function run(argv) {
  const timeout = Number(argv[0])
  const lockPath = ObjC.unwrap($.NSTemporaryDirectory()) + 'stacksjs-messages-automation'
  $.mkdir(lockPath, 0o700)
  // Read-only directory descriptor, with O_DIRECTORY, O_NOFOLLOW and O_CLOEXEC.
  const lock = $.open(lockPath, 0x01100100)
  if (lock < 0)
    throw new Error('Could not open the Messages automation lock.')

  let opened = null
  let tookFocus = false
  try {
    if (!waitUntil(Date.now() + 60000, () => $.flock(lock, 6) === 0))
      throw new Error('Another Messages operation is still running.')

    const bundle = 'com.apple.MobileSMS'
    if (Number($.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundle).count) === 0) {
      const workspace = $.NSWorkspace.sharedWorkspace
      const url = workspace.URLForApplicationWithBundleIdentifier(bundle)
      const failure = Ref()
      // Launch without activation. Keep the exact instance returned by Launch Services.
      const app = workspace.launchApplicationAtURLOptionsConfigurationError(url, 0x200, $({}), failure)
      if (app.isNil())
        throw new Error('Could not open Messages: ' + ObjC.unwrap(failure[0].localizedDescription))
      opened = app
    }

    const script = $.NSTask.alloc.init
    script.launchPath = '/usr/bin/osascript'
    script.arguments = $(['-e', argv[1], '--', ...argv.slice(2)])
    script.standardInput = $.NSFileHandle.fileHandleWithNullDevice
    script.launch
    function finished() {
      if (opened && opened.active)
        tookFocus = true
      return !script.running
    }
    if (!waitUntil(Date.now() + timeout, finished)) {
      script.terminate
      if (!waitUntil(Date.now() + 1000, finished))
        $.kill(script.processIdentifier, 9)
      throw new Error('Messages did not respond in time.')
    }
    if (script.terminationStatus !== 0)
      throw new Error('Messages did not accept the request.')
  }
  finally {
    if (opened && !opened.terminated && !tookFocus && !opened.active) {
      opened.terminate
      // A failed cold start cannot handle a normal quit event.
      if (!waitUntil(Date.now() + 3000, () => opened.terminated || opened.active)
        && !opened.finishedLaunching) {
        opened.forceTerminate
        waitUntil(Date.now() + 1000, () => opened.terminated)
      }
    }
    $.close(lock)
  }
}
`

export async function runMessagesScript(script: string, args: string[], timeout = 45_000): Promise<{ ok: boolean, output: string }> {
  const child = Bun.spawn(['/usr/bin/osascript', '-l', 'JavaScript', '-e', TRANSACTION, '--', String(timeout), script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { ok: code === 0, output: (code === 0 ? stdout : stderr).trim() }
}
