import type { ConversationRecord, RunRecord, Store } from './store'
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The store the downloadable app uses: one SQLite file in
 * ~/Library/Application Support/Uplink, no framework, no migrations to run.
 *
 * The Stacks app keeps its model-backed store (`model-store.ts`), whose tables
 * the dashboard reads. This one exists because a downloaded Uplink.app has no
 * Stacks project around it. Column names and units match the models - cost is
 * integer cents - so the two stay describable in one sentence.
 */

export interface RunRow extends RunRecord {
  id: number
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS conversations (
    chat_guid TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    service TEXT NOT NULL DEFAULT 'iMessage',
    session_id TEXT,
    cwd TEXT,
    last_active_at INTEGER,
    more_text TEXT
  );
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_guid TEXT NOT NULL,
    message_guid TEXT NOT NULL,
    prompt TEXT NOT NULL,
    cwd TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    reply TEXT,
    error TEXT,
    session_id TEXT,
    cost_cents INTEGER,
    duration_ms INTEGER,
    last_activity TEXT,
    started_at INTEGER,
    finished_at INTEGER
  );
`

const RUN_COLUMNS: Record<keyof RunRecord, string> = {
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

export class SqliteStore implements Store {
  private db: Database

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
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
