import { afterEach, describe, expect, it } from 'bun:test'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describeFatal, rotate, writeLog } from '../../../app/Uplink/log'

const dirs: string[] = []
function tempLog(): string {
  const dir = mkdtempSync(join(tmpdir(), 'uplink-log-'))
  dirs.push(dir)
  return join(dir, 'Uplink.log')
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe('the log file', () => {
  it('writes a timestamped line', () => {
    const path = tempLog()
    writeLog('hello', path)
    expect(readFileSync(path, 'utf8')).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z hello\n$/)
  })

  it('makes the directory rather than failing on a first run', () => {
    const path = join(tempLog(), '..', 'nested', 'Uplink.log')
    writeLog('first', path)
    expect(readFileSync(path, 'utf8')).toContain('first')
  })

  /**
   * The lines leading up to a crash are the ones worth reading, and a rotation
   * triggered by that crash's own output would otherwise throw them away. So
   * one generation is kept rather than truncated.
   */
  it('rotates once past the limit and keeps the previous contents', () => {
    const path = tempLog()
    appendFileSync(path, 'x'.repeat(2048))
    rotate(path, 1024)

    expect(existsSync(path)).toBe(false)
    expect(readFileSync(`${path}.1`, 'utf8')).toHaveLength(2048)

    // And it keeps logging afterwards.
    writeLog('after the rotation', path, 1024)
    expect(readFileSync(path, 'utf8')).toContain('after the rotation')
    expect(statSync(path).size).toBeLessThan(1024)
  })

  it('leaves a file that is under the limit alone', () => {
    const path = tempLog()
    appendFileSync(path, 'small')
    rotate(path, 1024)
    expect(readFileSync(path, 'utf8')).toBe('small')
    expect(existsSync(`${path}.1`)).toBe(false)
  })

  it('replaces an older rotation rather than accumulating them', () => {
    const path = tempLog()
    appendFileSync(`${path}.1`, 'the generation before last')
    appendFileSync(path, 'y'.repeat(2048))
    rotate(path, 1024)
    expect(readFileSync(`${path}.1`, 'utf8')).toHaveLength(2048)
    expect(existsSync(`${path}.2`)).toBe(false)
  })

  it('does not throw when the log cannot be written', () => {
    // A path whose parent is a file, so both mkdir and append fail.
    const blocked = tempLog()
    appendFileSync(blocked, 'i am a file')
    expect(() => writeLog('into the void', join(blocked, 'Uplink.log'))).not.toThrow()
  })
})

describe('describeFatal', () => {
  it('gives the name, message and stack', () => {
    const described = describeFatal(new TypeError('null is not an object'))
    expect(described).toContain('TypeError: null is not an object')
    expect(described).toContain('log.test.ts')
  })

  it('handles something thrown that is not an Error', () => {
    expect(describeFatal('just a string')).toBe('just a string')
    expect(describeFatal(undefined)).toBe('undefined')
  })
})

/**
 * The failure this exists for. An uncaught throw used to go to a stderr the
 * LaunchAgent does not capture, and the process vanished with the log's last
 * line being whatever succeeded before it.
 */
describe('crash handlers', () => {
  function crash(how: string): { exitCode: number, log: string } {
    const path = tempLog()
    const root = join(import.meta.dir, '..', '..', '..')
    const result = Bun.spawnSync(['bun', '-e', `
      import { installCrashHandlers } from ${JSON.stringify(join(root, 'app/Uplink/log.ts'))}
      installCrashHandlers({ path: ${JSON.stringify(path)} })
      ${how}
    `], { stderr: 'pipe', stdout: 'pipe', env: { ...process.env } })
    return { exitCode: result.exitCode, log: existsSync(path) ? readFileSync(path, 'utf8') : '' }
  }

  it('records an uncaught throw and exits non-zero', () => {
    const { exitCode, log } = crash(`setTimeout(() => { throw new Error('boom') }, 0)`)
    expect(exitCode).toBe(1)
    expect(log).toContain('uncaught exception')
    expect(log).toContain('Error: boom')
    // The stack, which is the part worth having.
    expect(log).toContain('at ')
  })

  it('records a rejected promise with no catch', () => {
    const { exitCode, log } = crash(`Promise.reject(new Error('nobody caught me'))`)
    expect(exitCode).toBe(1)
    expect(log).toContain('unhandled rejection')
    expect(log).toContain('nobody caught me')
  })

  it('reports one crash, not a cascade', () => {
    const { log } = crash(`setTimeout(() => { throw new Error('first') }, 0); setTimeout(() => { throw new Error('second') }, 1)`)
    expect(log).toContain('first')
    expect(log).not.toContain('second')
  })
})
