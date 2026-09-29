/**
 * What Uplink persists: where it is in chat.db, each thread's agent session,
 * and a record of every run. The daemon talks to this interface; the app uses
 * the model-backed store in `model-store.ts`, tests use `MemoryStore`.
 */

import type { EngineId } from './engine'

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped'

export interface ConversationRecord {
  chatGuid: string
  handle: string
  service: string
  sessionId: string | null
  cwd: string | null
  lastActiveAt: number | null
  /** The unsent tail of the last long reply, released by "more". */
  moreText: string | null
  /**
   * The engine this thread was switched to, or null to follow the
   * installation's setting. Null rather than a default so a thread that never
   * asked still tracks the menubar's picker.
   */
  engine: EngineId | null
}

export interface RunRecord {
  chatGuid: string
  messageGuid: string
  prompt: string
  cwd: string
  status: RunStatus
  reply?: string | null
  error?: string | null
  sessionId?: string | null
  costCents?: number | null
  durationMs?: number | null
  lastActivity?: string | null
  startedAt?: number | null
  finishedAt?: number | null
  /** Which agent answered, recorded per run because a thread can switch. */
  engine?: EngineId | null
}

export interface Store {
  cursor: () => Promise<number | null>
  setCursor: (rowid: number) => Promise<void>
  conversation: (chatGuid: string) => Promise<ConversationRecord | null>
  saveConversation: (conversation: ConversationRecord) => Promise<void>
  createRun: (run: RunRecord) => Promise<number>
  updateRun: (id: number, patch: Partial<RunRecord>) => Promise<void>
}

export class MemoryStore implements Store {
  cursorValue: number | null = null
  conversations = new Map<string, ConversationRecord>()
  runs = new Map<number, RunRecord>()
  private nextId = 1

  async cursor(): Promise<number | null> {
    return this.cursorValue
  }

  async setCursor(rowid: number): Promise<void> {
    this.cursorValue = rowid
  }

  async conversation(chatGuid: string): Promise<ConversationRecord | null> {
    const found = this.conversations.get(chatGuid)
    return found ? { ...found } : null
  }

  async saveConversation(conversation: ConversationRecord): Promise<void> {
    this.conversations.set(conversation.chatGuid, { ...conversation })
  }

  async createRun(run: RunRecord): Promise<number> {
    const id = this.nextId++
    this.runs.set(id, { ...run })
    return id
  }

  async updateRun(id: number, patch: Partial<RunRecord>): Promise<void> {
    const run = this.runs.get(id)
    if (run)
      this.runs.set(id, { ...run, ...patch })
  }
}
