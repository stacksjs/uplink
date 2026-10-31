import type { Subprocess } from 'bun'
import process from 'node:process'

/**
 * How long a stopped agent gets to exit on SIGTERM before the whole group is
 * sent SIGKILL.
 */
export const KILL_GRACE_MS = 5_000

/**
 * Stops an agent and everything it started. The agent runs in its own process
 * group, so signalling the negative pid reaches its shell commands, test
 * runners and dev servers too; killing only the CLI leaves those holding
 * stdout open and the run never ends.
 *
 * SIGTERM first, because a CLI that is allowed to finish may save its session.
 * An agent that ignores it, or a child stuck in an uninterruptible wait, would
 * otherwise keep a thread "running" for ever after someone texted `stop`, so a
 * SIGKILL follows if the group is still there after `graceMs`.
 */
export function killTree(proc: Pick<Subprocess, 'pid' | 'kill' | 'killed'>, graceMs = KILL_GRACE_MS): void {
  signal(proc, 'SIGTERM')
  const timer = setTimeout(() => {
    if (groupAlive(proc.pid))
      signal(proc, 'SIGKILL')
  }, graceMs)
  // The escalation must never be the thing that keeps the app from quitting.
  timer.unref?.()
}

function signal(proc: Pick<Subprocess, 'pid' | 'kill'>, name: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(-proc.pid, name)
  }
  catch {
    try {
      proc.kill(name)
    }
    catch {}
  }
}

/** Signal 0 checks that something in the group can still be signalled. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  }
  catch {
    return false
  }
}
