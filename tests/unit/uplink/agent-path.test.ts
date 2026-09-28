import { describe, expect, it } from 'bun:test'
import { agentPath } from '../../../app/Uplink/agent-path'

const env = { HOME: '/Users/someone', PATH: '/usr/bin:/bin' }

describe('agentPath', () => {
  it('covers every place the agent CLIs are installed', () => {
    const entries = agentPath({ env }).split(':')

    // The list the launchers used to disagree about. `~/.bun/bin` is the gap
    // that made a bun-installed claude invisible to the downloadable app.
    for (const expected of [
      '/Users/someone/.local/bin',
      '/Users/someone/.bun/bin',
      '/Users/someone/.npm-global/bin',
      '/Users/someone/.claude/local',
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ])
      expect(entries).toContain(expected)
  })

  it("puts the user's own locations before Uplink's bundled toolchain", () => {
    const entries = agentPath({ appDir: '/app', env }).split(':')
    expect(entries).toContain('/app/pantry/.bin')
    // Uplink's pinned bun must not shadow the CLI a person installed themselves.
    expect(entries.indexOf('/Users/someone/.bun/bin')).toBeLessThan(entries.indexOf('/app/pantry/.bin'))
  })

  it('keeps any existing PATH, last, so a real environment still wins', () => {
    const entries = agentPath({ env }).split(':')
    expect(entries.at(-1)).toBe('/bin')
    expect(entries.at(-2)).toBe('/usr/bin')
  })

  it('omits the app directory when there is none, rather than emitting an empty entry', () => {
    expect(agentPath({ env })).not.toContain('::')
    expect(agentPath({ env }).split(':').filter(Boolean).length).toBe(agentPath({ env }).split(':').length)
  })

  it('falls back to the real home when the environment has none', () => {
    expect(agentPath({ env: { PATH: '/usr/bin' } })).toContain('/.bun/bin')
  })
})
