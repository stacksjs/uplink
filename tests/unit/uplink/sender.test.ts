import { expect, it, spyOn } from 'bun:test'
import { AppleScriptSender } from '../../../app/Uplink/sender'

async function probe(runningPid: number | null, exitsDuringLookup = false) {
  const addressed: number[] = []
  const spawn = spyOn(Bun, 'spawn').mockImplementation((command) => {
    const args = Array.isArray(command) ? command : command.cmd
    expect(args.slice(0, 4)).toEqual(['/usr/bin/osascript', '-l', 'JavaScript', '-e'])
    const run = new Function('ObjC', '$', 'Application', `${args[4]}\nreturn run()`)
    let pid = runningPid
    const stdout = run(
      { import() {} },
      { NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => ({ count: pid === null ? '0' : '1', firstObject: { processIdentifier: pid } }) } },
      (target: number) => {
        addressed.push(target)
        if (exitsDuringLookup) {
          pid = null
          throw new Error('Application no longer exists')
        }
        return { running: () => true, accounts: () => [] }
      },
    )
    return {
      stdout: new Response(stdout).body,
      stderr: new Response('').body,
      exited: Promise.resolve(0),
    } as unknown as ReturnType<typeof Bun.spawn>
  })

  try {
    return { result: await new AppleScriptSender().canSend(), addressed }
  }
  finally {
    spawn.mockRestore()
  }
}

it('checks Automation without contacting Messages when it is closed', async () => {
  const { result, addressed } = await probe(null)
  expect(result).toMatchObject({ ok: false, reason: 'closed' })
  expect(addressed).toEqual([])
})

it('probes the exact running Messages process', async () => {
  const { result, addressed } = await probe(1234)
  expect(result).toMatchObject({ ok: true, reason: 'ok' })
  expect(addressed).toEqual([1234])
})

it('reports Messages closed when it quits during the permission check', async () => {
  const { result, addressed } = await probe(1234, true)
  expect(result).toMatchObject({ ok: false, reason: 'closed' })
  expect(addressed).toEqual([1234])
})
