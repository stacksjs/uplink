import type { ConversationRecord, RunRecord, Store } from './store'
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

/**
 * The store the downloadable app uses: one SQLite file in
 * ~/Library/Application Support/Uplink, no framework and no migration runner.
 *
 * The Stacks app keeps its model-backed store (`model-store.ts`), whose tables
 * the dashboard reads. This one exists because a downloaded Uplink.app has no
 * Stacks project around it. Column names and units match the models - cost is
 * integer cents - so the two stay describable in one sentence.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing on a Mac that already has the
 * file, so a column added to a schema string would never reach an installed
 * copy: the first text after the update would fail on the INSERT, for every
 * existing user, on every message. That is why the tables are described as
 * data below rather than as one block of SQL. The same description creates a
 * new database and tells an old one which columns it is missing.
 *
 * `TABLES` is not the only place a `runs` column is named: `RUN_COLUMNS` maps
 * it to its field and `recentRuns` reads it back. TypeScript ties
 * `RUN_COLUMNS` to `RunRecord` but cannot tie either to `TABLES`, so a test
 * does it instead. Adding a column means editing both, and the suite says so
 * rather than a customer's Mac.
 */

export interface RunRow extends RunRecord {
  id: number
}

/**
 * Stamped into `PRAGMA user_version`. Nothing branches on it today: the
 * columns themselves are reconciled. It is recorded so a database can say how
 * old it is, and so the day a change needs more than a new column - a backfill,
 * a rename - has a version to key off.
 */
const SCHEMA_VERSION = 1

export interface TableSpec {
  name: string
  /**
   * Definitions in creation order. A column added here later is also added to
   * databases that already exist, so it has to be one SQLite can ALTER in:
   * nullable or carrying a constant default, and never PRIMARY KEY or UNIQUE.
   *
   * Worth knowing before trusting a green test: SQLite only enforces the
   * NOT NULL and constant-default halves once a table has rows. An empty one
   * accepts both. So a new column can pass on a fresh database and fail on
   * every Mac that has been running, which is this file's own bug wearing a
   * different hat. `tests/unit/uplink/sqlite-store.test.ts` migrates a
   * populated database for that reason.
   */
  columns: Record<string, string>
}

export const TABLES: TableSpec[] = [
  {
    name: 'state',
    columns: {
      key: 'TEXT PRIMARY KEY',
      value: 'TEXT NOT NULL',
    },
  },
  {
    name: 'conversations',
    columns: {
      chat_guid: 'TEXT PRIMARY KEY',
      handle: 'TEXT NOT NULL',
      service: 'TEXT NOT NULL DEFAULT \'iMessage\'',
      session_id: 'TEXT',
      cwd: 'TEXT',
      last_active_at: 'INTEGER',
      more_text: 'TEXT',
    },
  },
  {
    name: 'runs',
    columns: {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      chat_guid: 'TEXT NOT NULL',
      message_guid: 'TEXT NOT NULL',
      prompt: 'TEXT NOT NULL',
      cwd: 'TEXT',
      status: 'TEXT NOT NULL DEFAULT \'queued\'',
      reply: 'TEXT',
      error: 'TEXT',
      session_id: 'TEXT',
      cost_cents: 'INTEGER',
      duration_ms: 'INTEGER',
      last_activity: 'TEXT',
      started_at: 'INTEGER',
      finished_at: 'INTEGER',
    },
  },
]

export const RUN_COLUMNS: Record<keyof RunRecord, string> = {
  chatGuid: 'chat_guid',
  messageGuid: 'message_guid',
  prompt: 'prompt',
  cwd: 'cwd',
  status: 'status',
  reply: 'reply',
  error: 'error',
  sessionId: 'session_id',
  costCents: 'cost_cents',
  durationMs: 'duration_ms',
  lastActivity: 'last_activity',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
}

/**
 * Bring a database up to the shape `TABLES` describes: create the tables it
 * does not have, and add to the ones it does any column it is missing.
 *
 * Forward only, and idempotent, so it runs on every start. The work is decided
 * by reading first, and a database that is already current returns before the
 * transaction opens. That matters because opening one takes a write lock, and
 * during an update two Uplinks hold the same file for a moment: a start that
 * wrote on every launch would lose that race, and the caller answers a lost
 * race by abandoning the file. Almost every launch is the no-work case.
 *
 * When there is work it is one transaction, which in SQLite covers the
 * `ALTER TABLE`s and the version stamp together: a database is either fully
 * updated or untouched, never left halfway by a Mac that went to sleep.
 */
export function migrate(db: Database, tables: TableSpec[] = TABLES): void {
  if (isCurrent(db, tables))
    return

  db.transaction(() => {
    for (const table of tables) {
      const present = columnsOf(db, table.name)
      const columns = Object.entries(table.columns)

      if (present.size === 0) {
        db.run(`CREATE TABLE ${table.name} (${columns.map(([name, definition]) => `${name} ${definition}`).join(', ')})`)
        continue
      }
      for (const [name, definition] of columns) {
        if (!present.has(name))
          db.run(`ALTER TABLE ${table.name} ADD COLUMN ${name} ${definition}`)
      }
    }
    // Interpolated, not bound: PRAGMA takes no parameter.
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  })()
}

/**
 * Whether the database already has every table and column `tables` names, and
 * carries this build's version. Reads only, so it is safe to ask while another
 * process is writing.
 */
function isCurrent(db: Database, tables: TableSpec[]): boolean {
  if (schemaVersion(db) !== SCHEMA_VERSION)
    return false
  return tables.every((table) => {
    const present = columnsOf(db, table.name)
    return present.size > 0 && Object.keys(table.columns).every(name => present.has(name))
  })
}

/** Empty means the table does not exist, which is also how a new file answers. */
function columnsOf(db: Database, table: string): Set<string> {
  return new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map(column => column.name))
}

export function schemaVersion(db: Database): number {
  return (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
}

export class SqliteStore implements Store {
  private db: Database

  /**
   * Why this Uplink is running without its database, if it is.
   *
   * The store is built at the top of the desktop agent, under launchd, where
   * an uncaught throw is a restart loop and the menubar never appears to say
   * why. A corrupt file, a full disk or a migration SQLite refuses would all
   * end there. Answering texts without remembering them is worth more than an
   * app that is not running, so the file is abandoned for an in-memory
   * database and the popover explains it.
   */
  readonly schemaError: string | null = null

  constructor(path: string) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      this.db = open(path)
    }
    catch (error) {
      // Written for whoever reads it in the popover, not for whoever wrote
      // this: what is happening, and the one thing they can do about it.
      this.schemaError = [
        'Uplink is answering texts but not saving them.',
        `Its history file could not be opened (${message(error)}).`,
        `Quit and reopen Uplink to try again, or delete ${tilde(path)} to start a fresh history.`,
      ].join(' ')
      this.db = open(':memory:')
    }
  }

  close(): void {
    this.db.close()
  }

  async cursor(): Promise<number | null> {
    const row = this.db.query('SELECT value FROM state WHERE key = ?').get('cursor') as { value: string } | null
    return row ? Number(row.value) : null
  }

  async setCursor(rowid: number): Promise<void> {
    this.db.query('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('cursor', String(rowid))
  }

  async conversation(chatGuid: string): Promise<ConversationRecord | null> {
    const row = this.db.query('SELECT * FROM conversations WHERE chat_guid = ?').get(chatGuid) as Record<string, any> | null
    if (!row)
      return null
    return {
      chatGuid: row.chat_guid,
      handle: row.handle,
      service: row.service,
      sessionId: row.session_id,
      cwd: row.cwd,
      lastActiveAt: row.last_active_at,
      moreText: row.more_text,
    }
  }

  async saveConversation(c: ConversationRecord): Promise<void> {
    this.db.query(`
      INSERT INTO conversations (chat_guid, handle, service, session_id, cwd, last_active_at, more_text)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_guid) DO UPDATE SET
        handle = excluded.handle, service = excluded.service, session_id = excluded.session_id,
        cwd = excluded.cwd, last_active_at = excluded.last_active_at, more_text = excluded.more_text
    `).run(c.chatGuid, c.handle, c.service, c.sessionId, c.cwd, c.lastActiveAt, c.moreText)
  }

  async createRun(run: RunRecord): Promise<number> {
    const entries = Object.entries(run).filter(([, value]) => value !== undefined) as Array<[keyof RunRecord, unknown]>
    const columns = entries.map(([key]) => RUN_COLUMNS[key])
    const result = this.db.query(`INSERT INTO runs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...entries.map(([, value]) => value as any))
    return Number(result.lastInsertRowid)
  }

  async updateRun(id: number, patch: Partial<RunRecord>): Promise<void> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as Array<[keyof RunRecord, unknown]>
    if (entries.length === 0)
      return
    this.db.query(`UPDATE runs SET ${entries.map(([key]) => `${RUN_COLUMNS[key]} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, value]) => value as any), id)
  }

  /** Newest first, for the menubar's recent list. */
  recentRuns(limit = 20): RunRow[] {
    const rows = this.db.query('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit) as Array<Record<string, any>>
    return rows.map(row => ({
      id: row.id,
      chatGuid: row.chat_guid,
      messageGuid: row.message_guid,
      prompt: row.prompt,
      cwd: row.cwd,
      status: row.status,
      reply: row.reply,
      error: row.error,
      sessionId: row.session_id,
      costCents: row.cost_cents,
      durationMs: row.duration_ms,
      lastActivity: row.last_activity,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    }))
  }
}

function open(path: string): Database {
  const db = new Database(path, { create: true })
  try {
    // A second Uplink on the same file is the normal case during an update.
    // WAL is what lets it read while this one writes, and the timeout is what
    // stops the one real upgrade from failing because the other one had the
    // lock for a moment. Without it SQLite gives up at once and the caller
    // reads that as a broken file.
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA busy_timeout = 5000;')
    migrate(db)
    return db
  }
  catch (error) {
    db.close()
    throw error
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function tilde(path: string): string {
  const home = homedir()
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}
