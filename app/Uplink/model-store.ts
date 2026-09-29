import type { ConversationRecord, RunRecord, Store } from './store'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Conversation from '../Models/Conversation'
import Run from '../Models/Run'

/**
 * The app's store: conversations and runs in the database (so the dashboard
 * can show them), the chat.db cursor in a small state file (it changes on
 * every poll that sees a message, and is no one else's business).
 */
export class ModelStore implements Store {
  constructor(private readonly cursorPath: string) {
    mkdirSync(dirname(cursorPath), { recursive: true })
  }

  async cursor(): Promise<number | null> {
    const file = Bun.file(this.cursorPath)
    if (!(await file.exists()))
      return null
    const value = Number((await file.text()).trim())
    return Number.isFinite(value) ? value : null
  }

  async setCursor(rowid: number): Promise<void> {
    await Bun.write(this.cursorPath, String(rowid))
  }

  async conversation(chatGuid: string): Promise<ConversationRecord | null> {
    const row = await Conversation.where('chat_guid', chatGuid).first() as Record<string, any> | undefined
    if (!row)
      return null
    return {
      chatGuid: row.chat_guid,
      handle: row.handle,
      service: row.service ?? 'iMessage',
      sessionId: row.session_id ?? null,
      cwd: row.cwd ?? null,
      lastActiveAt: row.last_active_at ?? null,
      moreText: row.more_text ?? null,
      engine: row.engine ?? null,
    }
  }

  async saveConversation(conversation: ConversationRecord): Promise<void> {
    const values = {
      handle: conversation.handle,
      service: conversation.service,
      sessionId: conversation.sessionId,
      cwd: conversation.cwd,
      lastActiveAt: conversation.lastActiveAt,
      moreText: conversation.moreText,
      engine: conversation.engine,
    }
    const existing = await Conversation.where('chat_guid', conversation.chatGuid).first() as { update: (v: object) => Promise<unknown> } | undefined
    if (existing)
      await existing.update(values)
    else
      await Conversation.create({ chatGuid: conversation.chatGuid, ...values })
  }

  async createRun(run: RunRecord): Promise<number> {
    const conversation = await Conversation.where('chat_guid', run.chatGuid).first() as { id: number } | undefined
    const created = await Run.create({ ...run, conversationId: conversation?.id ?? null }) as { id: number }
    return created.id
  }

  async updateRun(id: number, patch: Partial<RunRecord>): Promise<void> {
    const run = await Run.find(id) as { update: (v: object) => Promise<unknown> } | undefined
    await run?.update(patch)
  }
}
