import type { UplinkConfig } from '../../../app/Uplink/config'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../../app/Uplink/config'
import { MessagesDb } from '../../../app/Uplink/messages-db'
import { cleanToken, readSettings, settingsEnv, tokenLooksValid, writeSettings } from '../../../app/Uplink/settings'
import { SqliteStore } from '../../../app/Uplink/sqlite-store'
import { Uplink } from '../../../app/Uplink/uplink'
import { FakeChatDb, FakeEngine, FakeSender, ME, settle } from './fixtures'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'uplink-store-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe('SqliteStore', () => {
  it('round-trips the cursor, conversations and runs', async () => {
    const store = new SqliteStore(join(tempDir(), 'nested', 'uplink.sqlite'))
    expect(await store.cursor()).toBeNull()
    await store.setCursor(41)
    await store.setCursor(42)
    expect(await store.cursor()).toBe(42)

    const conversation = { chatGuid: 'g', handle: ME, service: 'iMessage', sessionId: 's', cwd: '/tmp', lastActiveAt: 5, moreText: 'x'.repeat(3000) }
    await store.saveConversation(conversation)
    await store.saveConversation({ ...conversation, sessionId: 's2' })
    expect(await store.conversation('g')).toEqual({ ...conversation, sessionId: 's2' })

    const id = await store.createRun({ chatGuid: 'g', messageGuid: 'm', prompt: 'p', cwd: '/tmp', status: 'queued' })
    await store.updateRun(id, { status: 'done', reply: 'r', costCents: 3, durationMs: 1200 })
    expect(store.recentRuns()[0]).toMatchObject({ id, status: 'done', reply: 'r', costCents: 3, durationMs: 1200, prompt: 'p' })
    store.close()
  })

  it('backs a whole conversation, the way the downloadable app runs', async () => {
    const fake = new FakeChatDb()
    const store = new SqliteStore(join(tempDir(), 'uplink.sqlite'))
    const engine = new FakeEngine()
    const sender = new FakeSender(fake)
    const config: UplinkConfig = { ...loadConfig({}), pollMs: 60_000, ackAfterMs: 0, progressEveryMs: 0 }
    const uplink = new Uplink({ config, messages: new MessagesDb(fake.path), sender, engine, store, log: { info() {}, warn() {}, error() {} } })
    await uplink.start({ poll: false })

    fake.add({ chat: ME, text: 'hello', fromMe: true })
    await uplink.tick()
    engine.finish(0, 'hi', { sessionId: 'abc' })
    await settle()
    fake.add({ chat: ME, text: 'again', fromMe: true })
    await uplink.tick()

    expect(sender.texts()).toEqual(['🛰 hi'])
    expect(engine.runs[1].request.sessionId).toBe('abc')
    expect(store.recentRuns().map(run => run.status)).toEqual(['running', 'done'])
    store.close()
    fake.close()
  })
})

describe('settings', () => {
  it('fills in defaults and survives a broken file', () => {
    const path = join(tempDir(), 'settings.json')
    expect(readSettings(path).openAtLogin).toBe(true)
    writeSettings({ ...readSettings(path), allowed: ['+15550001111'], model: 'sonnet' }, path)
    expect(readSettings(path)).toMatchObject({ allowed: ['+15550001111'], model: 'sonnet', paused: false })
    Bun.write(path, '{ not json')
    expect(readSettings(path).allowed).toEqual([])
  })

  it('feeds loadConfig without any .env', () => {
    const config = loadConfig(settingsEnv({ allowed: ['(555) 000-1111'], model: 'opus', workdir: '/tmp', openAtLogin: true, paused: false }, {}))
    expect(config).toMatchObject({ allowed: ['+15550001111'], model: 'opus', workdir: '/tmp' })
  })

  it('cleans a token pasted across a line wrap', () => {
    const token = `sk-ant-oat01-${'a'.repeat(60)}`
    expect(cleanToken(`${token.slice(0, 40)}\n  ${token.slice(40)}\n`)).toBe(token)
    expect(tokenLooksValid(token)).toBe(true)
    expect(tokenLooksValid(token.slice(0, 30))).toBe(false)
  })
})
