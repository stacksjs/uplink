import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * Picks the directory an agent run starts in.
 *
 * "please improve ~/Code/stacks with X" should run inside ~/Code/stacks, not
 * the home directory: Claude Code loads CLAUDE.md, hooks and settings from its
 * working directory, and sessions are stored per directory, so the wrong cwd
 * means the wrong project rules and a session that cannot be resumed.
 *
 * The first path in the text that exists wins, widened to its git repository
 * root. No path means the default workdir.
 */
export function detectWorkdir(prompt: string, fallback: string, home: string = homedir()): string {
  const candidates = prompt.match(/(?:~|\/Users\/[^/\s]+)(?:\/[\w.@+-]+)+\/?|~(?=\s|$)/g) ?? []

  for (const raw of candidates) {
    const expanded = resolve(raw.replace(/^~/, home).replace(/[.,;:!?)]+$/, ''))
    const dir = nearestDirectory(expanded)
    if (!dir || dir === '/' || dir === home)
      continue
    return gitRoot(dir, home) ?? dir
  }

  return fallback
}

function nearestDirectory(path: string): string | null {
  let current = path
  while (current !== dirname(current)) {
    if (existsSync(current))
      return statSync(current).isDirectory() ? current : dirname(current)
    current = dirname(current)
  }
  return null
}

/** Stops below `home`, so a dotfiles repo in ~ never swallows every project. */
function gitRoot(dir: string, home: string): string | null {
  let current = dir
  while (current !== dirname(current) && current !== home) {
    if (existsSync(join(current, '.git')))
      return current
    current = dirname(current)
  }
  return null
}
