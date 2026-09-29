import type { Engine, EngineEvent, EngineId, EngineInstall, EngineProbe, EngineRequest, EngineResult, EngineRun } from '../../../app/Uplink/engine'
import type { AutomationState, ReplyTarget, Sender } from '../../../app/Uplink/sender'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeAttributedBody } from '../../../app/Uplink/typedstream'

/**
 * A chat.db with the tables and columns Uplink reads, laid out the way
 * Messages writes them. Rows are added through helpers that mirror real
 * behavior: text is stored only in `attributedBody` unless asked otherwise,
 * dates are Apple-epoch nanoseconds, and a self-chat is a direct chat whose
 * identifier is the account's own handle.
 */

const APPLE_EPOCH_MS = 978_307_200_000

export const ME = '+15550001111'
export const ME_EMAIL = 'me@icloud.com'
export const FRIEND = '+15550002222'

export interface AddMessage {
  chat: string
  text: string
  fromMe?: boolean
  at?: number
  /** Store the text in `message.text` too, as older macOS did. */
  plainText?: boolean
  associatedType?: number
  sender?: string | null
  service?: string
}

export class FakeChatDb {
  readonly path: string
  private db: Database
  private chats = new Map<string, number>()
  private handles = new Map<string, number>()
  private seq = 0

  constructor() {
    const dir = mkdtempSync(join(tmpdir(), 'uplink-chatdb-'))
    this.path = join(dir, 'chat.db')
    this.db = new Database(this.path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, service TEXT NOT NULL);
      CREATE TABLE chat (
        ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER,
        chat_identifier TEXT, service_name TEXT, display_name TEXT
      );
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, attributedBody BLOB,
        handle_id INTEGER DEFAULT 0, service TEXT, date INTEGER, is_from_me INTEGER DEFAULT 0,
        associated_message_type INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0,
        cache_has_attachments INTEGER DEFAULT 0, destination_caller_id TEXT, account TEXT
      );
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
    `)
  }

  chat(identifier: string, style = 45): number {
    const key = `${identifier}/${style}`
    const existing = this.chats.get(key)
    if (existing)
      return existing
    const guid = style === 45 ? `iMessage;-;${identifier}` : `iMessage;+;${identifier}`
    this.db.query('INSERT INTO chat (guid, style, chat_identifier, service_name) VALUES (?, ?, ?, ?)').run(guid, style, identifier, 'iMessage')
    const id = (this.db.query('SELECT last_insert_rowid() AS id').get() as { id: number }).id
    this.chats.set(key, id)
    return id
  }

  chatGuid(identifier: string): string {
    return `iMessage;-;${identifier}`
  }

  private handle(id: string): number {
    const existing = this.handles.get(id)
    if (existing)
      return existing
    this.db.query('INSERT INTO handle (id, service) VALUES (?, ?)').run(id, 'iMessage')
    const rowid = (this.db.query('SELECT last_insert_rowid() AS id').get() as { id: number }).id
    this.handles.set(id, rowid)
    return rowid
  }

  add(message: AddMessage, style = 45): number {
    const chatId = this.chat(message.chat, style)
    const at = message.at ?? Date.now()
    const fromMe = message.fromMe ?? false
    const sender = message.sender === undefined ? (fromMe ? null : message.chat) : message.sender
    this.db.query(`
      INSERT INTO message (guid, text, attributedBody, handle_id, service, date, is_from_me, associated_message_type, destination_caller_id, account)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `msg-${++this.seq}`,
      message.plainText ? message.text : null,
      encodeAttributedBody(message.text),
      sender ? this.handle(sender) : 0,
      message.service ?? 'iMessage',
      (at - APPLE_EPOCH_MS) * 1_000_000,
      fromMe ? 1 : 0,
      message.associatedType ?? 0,
      // Real chat.db rows also carry device UUIDs and empty strings here.
      this.seq % 3 === 0 ? '2BF7D20C-E817-4434-89DE-3AC8BC3F0EFE' : ME,
      this.seq % 2 === 0 ? 'e:' : `e:${ME_EMAIL}`,
    )
    const rowid = (this.db.query('SELECT last_insert_rowid() AS id').get() as { id: number }).id
    this.db.query('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(chatId, rowid)
    return rowid
  }

  close(): void {
    this.db.close()
  }
}

export class FakeSender implements Sender {
  sent: Array<{ target: ReplyTarget, text: string }> = []
  /** Set to make every send fail, the way a refused Automation grant does. */
  refuse: string | null = null
  automation: AutomationState = { ok: true, reason: 'ok', detail: 'Uplink can send through Messages' }

  /** Mirror each send into chat.db, the way Messages records it. */
  constructor(private readonly db?: FakeChatDb) {}

  async canSend(): Promise<AutomationState> {
    return this.automation
  }

  async send(target: ReplyTarget, text: string): Promise<void> {
    if (this.refuse)
      throw new Error(this.refuse)
    this.sent.push({ target, text })
    this.db?.add({ chat: target.handle, text, fromMe: true })
  }

  texts(): string[] {
    return this.sent.map(s => s.text)
  }
}

interface PendingRun {
  request: EngineRequest
  resolve: (result: EngineResult) => void
  cancelled: boolean
}

/** An engine whose runs finish when the test says so. */
export class FakeEngine implements Engine {
  runs: PendingRun[] = []
  probes = 0

  // Identity matching the real engines, so a test that asserts on a reply
  // naming the CLI is asserting the text a user would actually get. Defaults
  // to Claude, which is what a test with one engine wants.
  readonly id: EngineId
  readonly label: string
  readonly authFailureHint: string
  readonly install: EngineInstall

  constructor(id: EngineId = 'claude') {
    this.id = id
    const claude = id === 'claude'
    this.label = claude ? 'Claude Code' : 'Codex'
    this.authFailureHint = claude
      ? 'run "claude setup-token" on the Mac and give Uplink the token'
      : 'run "codex login" on the Mac (or "codex login --device-auth" over SSH)'
    this.install = claude
      ? { command: 'bun install -g @anthropic-ai/claude-code', url: 'https://docs.claude.com/en/docs/claude-code' }
      : { command: 'bun install -g @openai/codex', url: 'https://developers.openai.com/codex/cli' }
  }

  probeResult: EngineProbe = { ok: true, reason: 'ok', detail: 'Signed in' }

  async probe(): Promise<EngineProbe> {
    this.probes += 1
    return this.probeResult
  }

  run(request: EngineRequest): EngineRun {
    let resolve!: (result: EngineResult) => void
    const done = new Promise<EngineResult>((r) => { resolve = r })
    const pending: PendingRun = { request, resolve, cancelled: false }
    this.runs.push(pending)
    return {
      done,
      cancel: () => {
        pending.cancelled = true
        resolve(result('Stopped.', { ok: false }))
      },
    }
  }

  emit(index: number, event: EngineEvent): void {
    this.runs[index].request.onEvent?.(event)
  }

  finish(index: number, text: string, overrides: Partial<EngineResult> = {}): void {
    this.runs[index].resolve(result(text, overrides))
  }
}

export function result(text: string, overrides: Partial<EngineResult> = {}): EngineResult {
  return { ok: true, text, sessionId: 'session-1', costCents: 1, durationMs: 1000, turns: 1, authFailure: false, ...overrides }
}

/** Lets pending promise callbacks (run completion, replies) settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++)
    await new Promise(resolve => setTimeout(resolve, 0))
}
