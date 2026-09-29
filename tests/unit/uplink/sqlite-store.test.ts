import type { UplinkConfig } from '../../../app/Uplink/config'
import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../../app/Uplink/config'
import { MessagesDb } from '../../../app/Uplink/messages-db'
import { cleanToken, readSettings, settingsEnv, tokenLooksValid, writeSettings } from '../../../app/Uplink/settings'
import { migrate, RUN_COLUMNS, schemaVersion, SqliteStore, TABLES } from '../../../app/Uplink/sqlite-store'
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

/**
 * The shape Uplink 0.1.3 wrote, which is what is on every Mac that already
 * runs it. Frozen on purpose: it is the oldest database a new build has to
 * open, so it is the thing an upgrade has to be proved against.
 */
const SHIPPED = {
  state: 'key TEXT PRIMARY KEY, value TEXT NOT NULL',
  conversations: 'chat_guid TEXT PRIMARY KEY, handle TEXT NOT NULL, service TEXT NOT NULL DEFAULT \'iMessage\', session_id TEXT, cwd TEXT, last_active_at INTEGER, more_text TEXT',
  runs: 'id INTEGER PRIMARY KEY AUTOINCREMENT, chat_guid TEXT NOT NULL, message_guid TEXT NOT NULL, prompt TEXT NOT NULL, cwd TEXT, status TEXT NOT NULL DEFAULT \'queued\', reply TEXT, error TEXT, session_id TEXT, cost_cents INTEGER, duration_ms INTEGER, last_activity TEXT, started_at INTEGER, finished_at INTEGER',
}

function write(path: string, tables: Record<string, string>): void {
  const db = new Database(path, { create: true })
  for (const [name, columns] of Object.entries(tables))
    db.run(`CREATE TABLE ${name} (${columns})`)
  db.close()
}

function columnsOf(path: string, table: string): string[] {
  const db = new Database(path)
  const names = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name)
  db.close()
  return names
}

/**
 * Compared as a set, not a list. `ALTER TABLE ADD COLUMN` appends, so a column
 * written into the middle of `TABLES` is last on an upgraded database and
 * mid-list on a new one. Both are correct, and an order-sensitive assertion
 * would fail the upgrade that worked.
 */
function sameColumns(path: string, table: { name: string, columns: Record<string, string> }): void {
  expect([...columnsOf(path, table.name)].sort()).toEqual(Object.keys(table.columns).sort())
}

function versionOf(path: string): number {
  const db = new Database(path)
  const version = schemaVersion(db)
  db.close()
  return version
}

describe('SqliteStore migrations', () => {
  it('creates a database that is already current', () => {
    const path = join(tempDir(), 'uplink.sqlite')
    const store = new SqliteStore(path)
    expect(store.schemaError).toBeNull()
    store.close()

    for (const table of TABLES)
      expect(columnsOf(path, table.name)).toEqual(Object.keys(table.columns))

    expect(versionOf(path)).toBeGreaterThan(0)
  })

  /**
   * The bug this exists for. `CREATE TABLE IF NOT EXISTS` is a no-op against a
   * database that is already there, so before this every column added to the
   * schema was a column an installed copy would never get, and its first INSERT
   * after the update would fail. Here `runs` is missing the four columns a
   * newer build names and `conversations` is missing entirely.
   */
  it('adds what an installed database is missing, without losing its rows', async () => {
    const path = join(tempDir(), 'uplink.sqlite')
    write(path, {
      state: SHIPPED.state,
      runs: 'id INTEGER PRIMARY KEY AUTOINCREMENT, chat_guid TEXT NOT NULL, message_guid TEXT NOT NULL, prompt TEXT NOT NULL, cwd TEXT, status TEXT NOT NULL DEFAULT \'queued\', reply TEXT, error TEXT, session_id TEXT, cost_cents INTEGER',
    })
    const older = new Database(path)
    older.run('INSERT INTO runs (chat_guid, message_guid, prompt, cwd, status, reply) VALUES (?, ?, ?, ?, ?, ?)', ['g', 'm', 'answered before the update', '/tmp', 'done', 'hi'])
    older.close()

    const store = new SqliteStore(path)
    expect(store.schemaError).toBeNull()

    // The history it already had is still there.
    expect(store.recentRuns()[0]).toMatchObject({ prompt: 'answered before the update', status: 'done', reply: 'hi' })

    // And the columns it did not have are usable, which is the INSERT that
    // used to fail on every text.
    const id = await store.createRun({ chatGuid: 'g', messageGuid: 'm2', prompt: 'after', cwd: '/tmp', status: 'queued' })
    await store.updateRun(id, { status: 'done', durationMs: 7, lastActivity: 'Thinking', startedAt: 1, finishedAt: 8 })
    expect(store.recentRuns()[0]).toMatchObject({ id, durationMs: 7, lastActivity: 'Thinking', startedAt: 1, finishedAt: 8 })

    // A table that did not exist at all is created rather than altered.
    await store.saveConversation({ chatGuid: 'g', handle: ME, service: 'iMessage', sessionId: 's', cwd: '/tmp', lastActiveAt: 5, moreText: null })
    expect(await store.conversation('g')).toMatchObject({ sessionId: 's' })
    store.close()
  })

  /**
   * The guard that makes the mechanism worth having. SQLite will not ALTER in
   * a PRIMARY KEY or UNIQUE column at all, and refuses a NOT NULL column with
   * no default, or a non-constant default, **once the table has rows**. A
   * column written any of those ways reaches every new install and no existing
   * one, which is the failure this whole file is about, one level up.
   *
   * The rows are the point. On an empty table SQLite 3.51 accepts both
   * `NOT NULL` with no default and `DEFAULT (datetime())`, so a version of
   * this test that migrated an empty 0.1.3 database would pass while every
   * real Mac, which has a history, failed.
   *
   * It passes trivially while the schema is unchanged and fails the day
   * someone adds a column that could not travel.
   */
  it('can add every column to a shipped database that is already in use', () => {
    // A table added after 0.1.3 would be created rather than altered, and this
    // test would quietly stop covering it. Add it to SHIPPED, or state here
    // why it does not need the guard.
    expect(TABLES.map(table => table.name).sort()).toEqual(Object.keys(SHIPPED).sort())

    const path = join(tempDir(), 'uplink.sqlite')
    write(path, SHIPPED)
    const used = new Database(path)
    used.run('INSERT INTO state (key, value) VALUES (?, ?)', ['cursor', '1'])
    used.run('INSERT INTO conversations (chat_guid, handle) VALUES (?, ?)', ['g', ME])
    used.run('INSERT INTO runs (chat_guid, message_guid, prompt) VALUES (?, ?, ?)', ['g', 'm', 'p'])
    used.close()

    expect(versionOf(path)).toBe(0)

    const store = new SqliteStore(path)
    expect(store.schemaError).toBeNull()
    store.close()

    for (const table of TABLES)
      sameColumns(path, table)
    // Stamped on an upgraded database, not only on a new one. Without this a
    // migration could leave the version at 0 and every other test stay green.
    const fresh = join(tempDir(), 'fresh.sqlite')
    new SqliteStore(fresh).close()
    expect(versionOf(path)).toBe(versionOf(fresh))
  })

  /**
   * The claim in this file's header is that a column is added in one place.
   * TypeScript only half enforces it: `RUN_COLUMNS` is a `Record` over
   * `RunRecord`, so those two cannot drift, but nothing ties either to
   * `TABLES`. A column named in one and not the other is exactly #9 again, so
   * it is pinned here instead of in the type system.
   */
  it('names the same runs columns in TABLES and in RUN_COLUMNS', () => {
    const declared = Object.keys(TABLES.find(table => table.name === 'runs')!.columns)
    // `id` is the key SQLite assigns; nothing writes it.
    expect(Object.values(RUN_COLUMNS).sort()).toEqual(declared.filter(name => name !== 'id').sort())
  })

  /**
   * During an update two Uplinks hold this file for a moment, and the loser of
   * a write lock abandons it for an in-memory database and loses the history.
   * A launch that changes nothing must therefore not ask for a write lock, and
   * almost every launch changes nothing.
   *
   * Not covered here: the launch that does have work to do and meets a lock.
   * That one waits on `PRAGMA busy_timeout`, and proving it needs a second
   * process, because SQLite's wait blocks this one's event loop.
   */
  it('opens a current database while another process is writing to it', async () => {
    const path = join(tempDir(), 'uplink.sqlite')
    new SqliteStore(path).close()

    const other = new Database(path)
    other.exec('BEGIN IMMEDIATE')
    other.run('INSERT INTO state (key, value) VALUES (?, ?)', ['cursor', '1'])

    // Opening is the assertion: it neither threw nor fell back to memory.
    const store = new SqliteStore(path)
    expect(store.schemaError).toBeNull()

    other.exec('ROLLBACK')
    other.close()

    // And it is the real file, not a replacement that forgets on quit.
    expect(await store.createRun({ chatGuid: 'g', messageGuid: 'm', prompt: 'p', cwd: '/tmp', status: 'queued' })).toBeGreaterThan(0)
    store.close()
    expect(new SqliteStore(path).recentRuns()[0]).toMatchObject({ prompt: 'p' })
  })

  it('runs twice over the same database without changing it', () => {
    const path = join(tempDir(), 'uplink.sqlite')
    new SqliteStore(path).close()
    const after = TABLES.map(table => columnsOf(path, table.name))
    new SqliteStore(path).close()
    expect(TABLES.map(table => columnsOf(path, table.name))).toEqual(after)
  })

  /**
   * The store is built at the top of the desktop agent, under launchd, so a
   * throw here is a restart loop with no menubar to explain it. A ruined file
   * costs the history, not the app.
   */
  it('keeps answering texts when the file cannot be opened', async () => {
    const path = join(tempDir(), 'uplink.sqlite')
    writeFileSync(path, 'this is not a database')

    const store = new SqliteStore(path)
    expect(store.schemaError).toContain('not a database')
    expect(store.schemaError).toContain('not saving them')

    const id = await store.createRun({ chatGuid: 'g', messageGuid: 'm', prompt: 'still works', cwd: '/tmp', status: 'queued' })
    expect(store.recentRuns()[0]).toMatchObject({ id, prompt: 'still works' })
    store.close()
  })

  it('leaves a half-applied change out of the database entirely', () => {
    const db = new Database(':memory:')
    db.run('CREATE TABLE runs (id INTEGER PRIMARY KEY)')
    // UNIQUE is one SQLite never allows in an ALTER, so this stands in for a
    // migration that fails partway: the table before it was created first.
    expect(() => migrate(db, [
      { name: 'created_first', columns: { a: 'TEXT' } },
      { name: 'runs', columns: { id: 'INTEGER PRIMARY KEY', nope: 'TEXT UNIQUE' } },
    ])).toThrow()
    expect(db.query('SELECT name FROM sqlite_master WHERE type = ?').all('table')).toEqual([{ name: 'runs' }])
    expect(schemaVersion(db)).toBe(0)
    db.close()
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
    const config = loadConfig(settingsEnv({ allowed: ['(555) 000-1111'], engine: 'claude', model: 'opus', workdir: '/tmp', openAtLogin: true, paused: false }, {}))
    expect(config).toMatchObject({ allowed: ['+15550001111'], engine: 'claude', claudeModel: 'opus', workdir: '/tmp' })
  })

  it('carries the selected engine through to config', () => {
    const settings = { allowed: [], engine: 'codex' as const, model: null, workdir: '/tmp', openAtLogin: true, paused: false }
    expect(loadConfig(settingsEnv(settings, {})).engine).toBe('codex')
    // A settings.json naming an engine this build does not have must not stop
    // the app from starting.
    const path = join(tempDir(), 'settings.json')
    writeSettings({ ...settings, engine: 'gemini' as never }, path)
    expect(readSettings(path).engine).toBe('claude')
  })

  it('cleans a token pasted across a line wrap', () => {
    const token = `sk-ant-oat01-${'a'.repeat(60)}`
    expect(cleanToken(`${token.slice(0, 40)}\n  ${token.slice(40)}\n`)).toBe(token)
    expect(tokenLooksValid(token)).toBe(true)
    expect(tokenLooksValid(token.slice(0, 30))).toBe(false)
  })
})
