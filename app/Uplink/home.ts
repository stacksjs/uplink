import { homedir, tmpdir } from 'node:os'
import process from 'node:process'

/**
 * Whether this process is inside the App Sandbox, as the Mac App Store build
 * is. macOS sets APP_SANDBOX_CONTAINER_ID for the sandboxed app itself, but a
 * helper that only inherits the sandbox does not reliably see it, and Uplink's
 * backend is exactly that. What every sandboxed process does share is a `$HOME`
 * inside `~/Library/Containers`.
 */
export const SANDBOXED = Boolean(process.env.APP_SANDBOX_CONTAINER_ID) || homedir().includes('/Library/Containers/')

/**
 * The person's own home directory.
 *
 * Under the sandbox `$HOME`, and so `os.homedir()`, is the app's container
 * (`~/Library/Containers/<id>/Data`), which has no Messages database, no
 * repositories and no agent CLI. Everything about the user's Mac lives under
 * the real home; Uplink's own files (settings, database, log) stay in the
 * container, which is where the sandbox lets it write without asking.
 *
 * Outside the sandbox the two are the same, so this is `homedir()`.
 */
export function userHome(): string {
  const home = homedir()
  if (!SANDBOXED)
    return home
  const at = home.indexOf('/Library/Containers/')
  return at === -1 ? home : home.slice(0, at)
}

/**
 * Somewhere an agent CLI can be started and write a scratch file.
 *
 * `os.tmpdir()` is right at a terminal. Inside the sandbox it follows `$TMPDIR`,
 * which a helper that only inherits the sandbox gets from whatever started the
 * app, and a directory the sandbox does not allow makes the CLI die at startup
 * with EPERM before it says anything. The container's own home always works.
 */
export function scratchDir(): string {
  return SANDBOXED ? homedir() : tmpdir()
}

/**
 * Environment the agent CLIs need to behave as they do at a terminal. Claude
 * Code and Codex keep their sign-in and settings under `$HOME`, and a sandboxed
 * parent hands them its container's instead, where they would find nothing and
 * report a signed-out agent.
 */
export function agentHomeEnv(): Record<string, string> {
  return SANDBOXED ? { HOME: userHome() } : {}
}
