import { describe, expect, it } from 'bun:test'

// SANDBOXED is read from the environment when the module loads, so each case
// runs in a process that has the environment it is about.
function probe(env: Record<string, string>): { home: string, agent: Record<string, string>, scratch: string } {
  const run = Bun.spawnSync([process.execPath, '-e', `
    const { userHome, agentHomeEnv, scratchDir } = await import('${import.meta.dir}/../../../app/Uplink/home.ts')
    console.log(JSON.stringify({ home: userHome(), agent: agentHomeEnv(), scratch: scratchDir() }))
  `], { env: { PATH: process.env.PATH ?? '', ...env }, stdout: 'pipe', stderr: 'pipe' })
  return JSON.parse(run.stdout.toString())
}

describe('userHome', () => {
  it('is the home directory outside the sandbox, and leaves the agents\' HOME alone', () => {
    const result = probe({ HOME: '/Users/ada', TMPDIR: '/var/folders/x/T/' })
    expect(result).toMatchObject({ home: '/Users/ada', agent: {} })
    expect(result.scratch).toContain('/var/folders/x/T')
  })

  it('is the real home, not the container, inside the sandbox', () => {
    const result = probe({
      APP_SANDBOX_CONTAINER_ID: 'com.stacksjs.uplink',
      HOME: '/Users/ada/Library/Containers/com.stacksjs.uplink/Data',
    })
    expect(result.home).toBe('/Users/ada')
    // Claude Code and Codex keep their sign-in under $HOME.
    expect(result.agent).toEqual({ HOME: '/Users/ada' })
  })

  it('treats a $HOME in a container as the sandbox even without the container variable', () => {
    // An inherited helper does not reliably get APP_SANDBOX_CONTAINER_ID.
    const result = probe({ HOME: '/Users/ada/Library/Containers/com.stacksjs.uplink/Data', TMPDIR: '/not/allowed/' })
    expect(result.home).toBe('/Users/ada')
    // Where an agent starts must not depend on a $TMPDIR the sandbox may refuse.
    expect(result.scratch).toBe('/Users/ada/Library/Containers/com.stacksjs.uplink/Data')
  })
})
