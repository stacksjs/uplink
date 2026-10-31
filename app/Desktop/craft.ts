import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The compiled Craft executable `build:desktop` needs as CRAFT_BIN.
 *
 * Pantry puts a shell wrapper at `pantry/.bin/craft`, and `build:desktop`
 * refuses it ("points at a script, not a native binary"). The binary itself is
 * under `pantry/craft-native.org/<version>/bin/craft`, so this finds the newest
 * one installed and falls back to the wrapper, whose rejection then says what
 * is wrong, rather than guessing.
 */
export function craftBinary(appDir: string): string {
  const root = join(appDir, 'pantry', 'craft-native.org')
  const versions = existsSync(root)
    ? readdirSync(root)
        .filter(name => /^v\d+\.\d+\.\d+$/.test(name))
        .sort((a, b) => compare(b, a))
    : []

  for (const version of versions) {
    const binary = join(root, version, 'bin', 'craft')
    if (existsSync(binary))
      return binary
  }
  return join(appDir, 'pantry', '.bin', 'craft')
}

function compare(a: string, b: string): number {
  const left = a.slice(1).split('.').map(Number)
  const right = b.slice(1).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0)
      return difference
  }
  return 0
}
