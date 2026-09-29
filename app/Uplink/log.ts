import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { LOG_MAX_BYTES, LOG_PATH } from './settings'

/**
 * ~/Library/Logs/Uplink.log, which is the whole support story for a
 * downloadable app: no crash reporting, no diagnostics bundle, and stdout that
 * nobody is attached to.
 *
 * So this file has two jobs the previous inline version did not do. It stays
 * within a size, because a watcher polling every two seconds appends forever.
 * And it survives a crash, because the failure most worth explaining was the
 * one the file could not describe: an uncaught throw went to a stderr the
 * LaunchAgent does not capture, and the process vanished with the log's last
 * line being whatever succeeded before it.
 */

// Checked on a counter rather than on every append: the watcher writes on a
// two second poll, and a stat per line would be most of the work.
const ROTATE_EVERY = 200
let writes = 0

/**
 * One timestamped line. Never throws: `~/Library/Logs` can be missing or
 * unwritable, and a crash reporter that crashes is worse than none.
 */
export function writeLog(line: string, path: string = LOG_PATH, maxBytes: number = LOG_MAX_BYTES): void {
  try {
    // Every write, not only on the rotation check: a directory that goes away
    // mid-run should not cost 200 lines before anyone notices.
    mkdirSync(dirname(path), { recursive: true })
    if (writes++ % ROTATE_EVERY === 0)
      rotate(path, maxBytes)
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`)
  }
  catch {
    // Nothing useful left to do: the place errors are reported is the thing
    // that failed.
  }
}

/**
 * One rotation, keeping `Uplink.log.1`. Kept rather than deleted because the
 * lines leading up to a crash are the ones worth reading, and a rotation
 * triggered by that crash's own output would otherwise throw them away.
 */
export function rotate(path: string = LOG_PATH, maxBytes: number = LOG_MAX_BYTES): void {
  if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > maxBytes)
    renameSync(path, `${path}.1`)
}

/**
 * Name, message and stack, and nothing else. A stack can carry a frame
 * argument in some runtimes, and a text somebody sent is not ours to write to
 * a file that outlives the run.
 */
export function describeFatal(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}\n${error.stack ?? '(no stack)'}`
    : String(error)
}

/**
 * Report an uncaught throw or a rejected promise, then stop.
 *
 * Stopping is the point. A handler that swallows the error leaves the agent
 * half alive: the watcher is gone and the loopback server is not, so the
 * menubar reports a healthy app that answers nothing.
 */
export function installCrashHandlers(options: { path?: string, shutdown?: (code: number) => void } = {}): void {
  const shutdown = options.shutdown ?? ((code: number) => process.exit(code))
  let fatal = false

  const report = (kind: string, error: unknown): void => {
    // Running twice turns one crash into two, and the second is never the
    // interesting one.
    if (fatal)
      return
    fatal = true
    const described = `[uplink] ${kind}: ${describeFatal(error)}`
    // Whatever the TTY says. From a terminal the developer also gets it on
    // stderr; the file gets the same entry either way.
    writeLog(described, options.path)
    if (process.stdout.isTTY)
      console.error(described)
    shutdown(1)
  }

  process.on('uncaughtException', error => report('uncaught exception', error))
  process.on('unhandledRejection', reason => report('unhandled rejection', reason))
}
