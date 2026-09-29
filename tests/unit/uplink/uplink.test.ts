import type { UplinkConfig } from '../../../app/Uplink/config'
import { afterEach, describe, expect, it } from 'bun:test'
import { MessagesDb } from '../../../app/Uplink/messages-db'
import { MemoryStore } from '../../../app/Uplink/store'
import { Uplink } from '../../../app/Uplink/uplink'
import { FakeChatDb, FakeEngine, FakeSender, FRIEND, ME, settle } from './fixtures'

const silent = { info: () => {}, warn: () => {}, error: () => {} }

function config(overrides: Partial<UplinkConfig> = {}): UplinkConfig {
  return {
    allowed: [],
    messagesDb: '',
    pollMs: 60_000,
    catchUpMs: 30 * 60_000,
    replyPrefix: '🛰 ',
    maxChars: 1200,
    maxParts: 3,
    ackAfterMs: 0,
    progressEveryMs: 0,
    sessionIdleMs: 6 * 3_600_000,
    workdir: '/tmp',
    claudeBin: 'claude',
    model: null,
    permissionMode: 'bypassPermissions',
    timeoutMs: 60_000,
    ...overrides,
  }
}

interface Harness {
  fake: FakeChatDb
  sender: FakeSender
  engine: FakeEngine
  store: MemoryStore
  uplink: Uplink
}

let open: FakeChatDb | undefined

async function harness(overrides: Partial<UplinkConfig> = {}, seed?: (fake: FakeChatDb) => void): Promise<Harness> {
  const fake = new FakeChatDb()
  open = fake
  seed?.(fake)
  const sender = new FakeSender(fake)
  const engine = new FakeEngine()
  const store = new MemoryStore()
  const uplink = new Uplink({ config: config(overrides), messages: new MessagesDb(fake.path), sender, engine, store, log: silent })
  await uplink.start({ poll: false }) // Each test drives tick() itself.
  return { fake, sender, engine, store, uplink }
}

afterEach(() => open?.close())

describe('Uplink', () => {
  it('starts at the newest message instead of replaying history', async () => {
    const h = await harness({}, (fake) => {
      fake.add({ chat: ME, text: 'old task from last week', fromMe: true })
    })
    await h.uplink.tick()
    expect(h.engine.runs).toHaveLength(0)
    expect(h.store.cursorValue).toBe(1)
  })

  it('answers a text to myself and resumes the session on the next one', async () => {
    const h = await harness()
    h.fake.add({ chat: ME, text: 'Whats the NFL score rn?', fromMe: true })
    await h.uplink.tick()

    expect(h.engine.runs).toHaveLength(1)
    expect(h.engine.runs[0].request).toMatchObject({ prompt: 'Whats the NFL score rn?', cwd: '/tmp', sessionId: null })

    h.engine.finish(0, '**Chiefs 24**, Bills 21 (Q4 2:10)', { sessionId: 'abc' })
    await settle()
    expect(h.sender.texts()).toEqual(['🛰 Chiefs 24, Bills 21 (Q4 2:10)'])
    expect(h.store.runs.get(1)).toMatchObject({ status: 'done', sessionId: 'abc' })

    // The reply is now in chat.db as a message from me. It must not become a command.
    h.fake.add({ chat: ME, text: 'and the Eagles?', fromMe: true })
    await h.uplink.tick()
    expect(h.engine.runs).toHaveLength(2)
    expect(h.engine.runs[1].request).toMatchObject({ prompt: 'and the Eagles?', sessionId: 'abc' })
  })

  it('acts once on a self-text that chat.db holds twice', async () => {
    const h = await harness()
    const at = Date.now()
    h.fake.add({ chat: ME, text: 'ping', fromMe: true, at })
    h.fake.add({ chat: ME, text: 'ping', fromMe: false, sender: ME, at: at + 800 })
    await h.uplink.tick()
    expect(h.sender.texts()).toHaveLength(1)
    expect(h.sender.texts()[0]).toStartWith('🛰 pong')
  })

  it('acts once on a self-text filed under both my number and my email', async () => {
    const h = await harness()
    const at = Date.now()
    h.fake.add({ chat: ME, text: 'ping', fromMe: true, at })
    h.fake.add({ chat: 'me@icloud.com', text: 'ping', fromMe: true, at: at + 500 })
    await h.uplink.tick()
    expect(h.sender.texts()).toHaveLength(1)
  })

  it('ignores strangers, groups, and my texts to other people', async () => {
    const h = await harness()
    h.fake.add({ chat: '+15559999999', text: 'rm -rf everything' })
    h.fake.add({ chat: FRIEND, text: 'see you at 7', fromMe: true })
    h.fake.add({ chat: 'chat123', text: 'group task', sender: ME }, 43)
    await h.uplink.tick()
    expect(h.engine.runs).toHaveLength(0)
    expect(h.sender.sent).toHaveLength(0)
  })

  it('takes commands from a configured number, and only from it', async () => {
    const h = await harness({ allowed: [FRIEND] })
    h.fake.add({ chat: FRIEND, text: 'status' })
    h.fake.add({ chat: ME, text: 'status', fromMe: true })
    await h.uplink.tick()
    expect(h.sender.sent.map(s => s.target.handle)).toEqual([FRIEND])
  })

  it('skips commands older than the catch-up window', async () => {
    const h = await harness()
    h.fake.add({ chat: ME, text: 'deploy prod', fromMe: true, at: Date.now() - 3 * 3_600_000 })
    await h.uplink.tick()
    expect(h.engine.runs).toHaveLength(0)
  })

  it('queues a second task, reports status, and stop cancels both', async () => {
    const h = await harness()
    h.fake.add({ chat: ME, text: 'please improve ~/Code with feature xyz', fromMe: true })
    h.fake.add({ chat: ME, text: 'then run the tests', fromMe: true })
    await h.uplink.tick()
    expect(h.engine.runs).toHaveLength(1)
    expect(h.sender.texts()[0]).toContain('Queued behind the current task (1 waiting)')

    h.engine.emit(0, { kind: 'tool', name: 'Edit', summary: 'Edit: ~/Code/stacks/router.ts' })
    h.fake.add({ chat: ME, text: 'Status', fromMe: true })
    await h.uplink.tick()
    expect(h.sender.texts()[1]).toContain('Latest: Edit: ~/Code/stacks/router.ts')
    expect(h.sender.texts()[1]).toContain('1 queued.')

    h.fake.add({ chat: ME, text: 'stop', fromMe: true })
    await h.uplink.tick()
    await settle()
    expect(h.engine.runs[0].cancelled).toBe(true)
    expect(h.engine.runs).toHaveLength(1) // The queued task never started.
    expect(h.sender.texts()[2]).toContain('Stopped: please improve ~/Code with feature xyz and cleared 1 queued.')
    expect([...h.store.runs.values()].map(r => r.status)).toEqual(['stopped', 'stopped'])
    expect(h.sender.texts()).toHaveLength(3) // No "That failed: Stopped." after a stop.
  })

  it('stops everything from the Mac and tells the thread', async () => {
    const h = await harness()
    h.fake.add({ chat: ME, text: 'refactor the router', fromMe: true })
    h.fake.add({ chat: ME, text: 'then run the tests', fromMe: true })
    await h.uplink.tick()
    expect(h.uplink.activeRuns).toHaveLength(1)

    expect(await h.uplink.stopAll()).toBe(1)
    await settle()
    expect(h.engine.runs[0].cancelled).toBe(true)
    expect(h.uplink.activeRuns).toHaveLength(0)
    expect(h.sender.texts().at(-1)).toContain('Stopped on the Mac: refactor the router and cleared 1 queued.')
    expect([...h.store.runs.values()].map(r => r.status)).toEqual(['stopped', 'stopped'])
    expect(await h.uplink.stopAll()).toBe(0)
  })

  it('does not double the punctuation of a question it stopped', async () => {
    const h = await harness()
    h.fake.add({ chat: ME, text: 'Whats the NFL score rn?', fromMe: true })
    await h.uplink.tick()
    await h.uplink.stopAll()
    expect(h.sender.texts().at(-1)).toBe('🛰 Stopped on the Mac: Whats the NFL score rn?')
  })

  it('runs the queue in order once the current task finishes', async () => {
    const h = await harness()
    h.fake.add({ chat: ME, text: 'first', fromMe: true })
    h.fake.add({ chat: ME, text: 'second', fromMe: true })
    await h.uplink.tick()
    h.engine.finish(0, 'one', { sessionId: 's1' })
    await settle()
    expect(h.engine.runs).toHaveLength(2)
    expect(h.engine.runs[1].request).toMatchObject({ prompt: 'second', sessionId: 's1' })
  })

  it('splits long replies and holds the rest for "more"', async () => {
    const h = await harness({ maxChars: 60, maxParts: 2 })
    h.fake.add({ chat: ME, text: 'long answer please', fromMe: true })
    await h.uplink.tick()
    const sentences = Array.from({ length: 8 }, (_, i) => `Sentence number ${i + 1} is here.`)
    h.engine.finish(0, sentences.join(' '))
    await settle()
    expect(h.sender.texts()).toHaveLength(2)
    expect(h.sender.texts()[1]).toMatch(/more, text "more"\)$/)
    for (const text of h.sender.texts())
      expect(text.length).toBeLessThanOrEqual(60 + 30)

    h.fake.add({ chat: ME, text: 'more', fromMe: true })
    await h.uplink.tick()
    expect(h.sender.texts().slice(2).join(' ')).toContain('Sentence number 8 is here.')
  })

  it('"new" drops the session so the next text starts fresh', async () => {
    const h = await harness()
    h.fake.add({ chat: ME, text: 'hello', fromMe: true })
    await h.uplink.tick()
    h.engine.finish(0, 'hi', { sessionId: 's1' })
    await settle()
    h.fake.add({ chat: ME, text: 'new', fromMe: true })
    h.fake.add({ chat: ME, text: 'who won?', fromMe: true })
    await h.uplink.tick()
    expect(h.engine.runs[1].request.sessionId).toBeNull()
  })

  it('does not record a run as done when the reply could not be delivered', async () => {
    const h = await harness()
    // What a refused Messages Automation grant looks like from here. Without
    // this the run was recorded done, the dashboard showed an answer, and the
    // phone heard nothing at all.
    h.sender.refuse = 'Messages refused to send (osascript exit 1): not authorized to send Apple events'
    h.fake.add({ chat: ME, text: 'hello', fromMe: true })
    await h.uplink.tick()
    h.engine.finish(0, 'Here are the scores')
    await settle()

    expect(h.sender.texts()).toEqual([])
    expect(h.store.runs.get(1)?.status).toBe('failed')
    expect(h.store.runs.get(1)?.error).toContain('could not be delivered')
    expect(h.uplink.lastSendError).toContain('not authorized')
  })

  it('tells the user which CLI is not logged in, and how to fix it', async () => {
    const h = await harness()
    h.fake.add({ chat: ME, text: 'hello', fromMe: true })
    await h.uplink.tick()
    h.engine.finish(0, 'Failed to authenticate', { ok: false, authFailure: true })
    await settle()
    // The remedy comes from the engine, so a Codex install is told about Codex
    // rather than about a claude token and a .env the app does not have.
    expect(h.sender.texts()[0]).toContain('Claude Code')
    expect(h.sender.texts()[0]).toContain('claude setup-token')
    expect(h.store.runs.get(1)?.status).toBe('failed')
  })

  /**
   * #16. The cutoff is right: a Mac waking up must not replay a day of texts.
   * Saying nothing was not, because over a satellite link the send itself may
   * have taken minutes and silence is the worst available answer.
   */
  it('tells you a text arrived while the Mac was asleep, and does not run it', async () => {
    const h = await harness()
    h.fake.add({ chat: ME, text: 'deploy the thing', fromMe: true, at: Date.now() - 2 * 3_600_000 })
    await h.uplink.tick()

    expect(h.sender.texts()).toHaveLength(1)
    expect(h.sender.texts()[0]).toContain('while this Mac was asleep')
    expect(h.sender.texts()[0]).toContain('Send it again')
    // Never run automatically: that is what the cutoff is for.
    expect(h.engine.runs).toHaveLength(0)
    expect(h.store.runs.size).toBe(0)
  })

  it('answers a backlog once, not once per text', async () => {
    const h = await harness()
    const asleep = Date.now() - 2 * 3_600_000
    for (let i = 0; i < 8; i++)
      h.fake.add({ chat: ME, text: `task ${i}`, fromMe: true, at: asleep + i * 1000 })
    await h.uplink.tick()

    expect(h.sender.texts()).toHaveLength(1)
    expect(h.sender.texts()[0]).toContain('8 texts')
    expect(h.engine.runs).toHaveLength(0)
  })

  it('says nothing about a control word that was skipped', async () => {
    const h = await harness()
    // Answered live or not at all: reporting an unanswered midnight "status"
    // is noise, not information.
    h.fake.add({ chat: ME, text: 'status', fromMe: true, at: Date.now() - 2 * 3_600_000 })
    h.fake.add({ chat: ME, text: 'stop', fromMe: true, at: Date.now() - 2 * 3_600_000 })
    await h.uplink.tick()
    expect(h.sender.texts()).toEqual([])
  })

  it('says nothing about a text from last week', async () => {
    const h = await harness()
    h.fake.add({ chat: ME, text: 'a task', fromMe: true, at: Date.now() - 7 * 24 * 3_600_000 })
    await h.uplink.tick()
    expect(h.sender.texts()).toEqual([])
  })

  it('runs the fresh text in the same wake and explains only the old one', async () => {
    const h = await harness()
    h.fake.add({ chat: ME, text: 'old task', fromMe: true, at: Date.now() - 2 * 3_600_000 })
    h.fake.add({ chat: ME, text: 'new task', fromMe: true })
    await h.uplink.tick()

    expect(h.engine.runs).toHaveLength(1)
    expect(h.engine.runs[0].request.prompt).toContain('new task')
    expect(h.sender.texts().filter(t => t.includes('while this Mac was asleep'))).toHaveLength(1)
  })
})

