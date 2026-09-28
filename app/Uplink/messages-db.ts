import { Database } from 'bun:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isAddressable, normalizeHandle } from './handles'
import { decodeAttributedBody } from './typedstream'

/**
 * Read-only access to the Messages app's database.
 *
 * `~/Library/Messages/chat.db` is protected by macOS privacy controls (TCC):
 * the process reading it needs Full Disk Access, or every open fails with
 * "authorization denied". Grant it to Uplink.app (or, in development, to the
 * terminal running `buddy uplink:watch`). Nothing here ever writes to it.
 */

export const DEFAULT_MESSAGES_DB = join(homedir(), 'Library', 'Messages', 'chat.db')

/** Seconds between the Unix epoch and Apple's (2001-01-01T00:00:00Z). */
const APPLE_EPOCH_OFFSET_S = 978_307_200

/** `chat.style` for a one-to-one conversation; 43 is a group. */
export const CHAT_STYLE_DIRECT = 45

export interface IncomingMessage {
  rowid: number
  guid: string
  text: string | null
  isFromMe: boolean
  /** Unix milliseconds. */
  sentAt: number
  service: string
  /** The other party's handle, normalized. Null for some messages you sent. */
  sender: string | null
  chatGuid: string
  /** Phone number or email for a direct chat, `chat123...` for a group. */
  chatIdentifier: string
  chatStyle: number
  /** Non-zero for tapbacks, stickers and other reactions. */
  associatedType: number
  /** Non-zero for group renames, member changes and other system items. */
  itemType: number
  hasAttachments: boolean
}

interface MessageRow {
  rowid: number
  guid: string
  text: string | null
  attributedBody: Uint8Array | null
  is_from_me: number
  date: number
  service: string | null
  associated_message_type: number | null
  item_type: number | null
  cache_has_attachments: number | null
  sender: string | null
  chat_guid: string
  chat_identifier: string
  style: number | null
}

export function appleDateToUnixMs(date: number): number {
  // Since High Sierra the column holds nanoseconds; before that, seconds.
  const seconds = date > 1e12 ? date / 1e9 : date
  return Math.round((seconds + APPLE_EPOCH_OFFSET_S) * 1000)
}

export class MessagesAccessError extends Error {
  constructor(public readonly path: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    const hint = /authorization denied|not permitted|unable to open/i.test(detail)
      ? 'Grant Full Disk Access to the app running Uplink (System Settings > Privacy & Security > Full Disk Access).'
      : 'Is Messages set up and signed in on this Mac?'
    super(`Cannot read ${path}: ${detail}. ${hint}`)
    this.name = 'MessagesAccessError'
  }
}

export class MessagesDb {
  private db: Database

  constructor(public readonly path: string = DEFAULT_MESSAGES_DB) {
    try {
      this.db = new Database(path, { readonly: true })
      // Opening is lazy; touching a table is what actually hits TCC.
      this.db.query('SELECT 1 FROM message LIMIT 1').all()
    }
    catch (error) {
      throw new MessagesAccessError(path, error)
    }
  }

  close(): void {
    this.db.close()
  }

  latestRowId(): number {
    const row = this.db.query('SELECT MAX(ROWID) AS id FROM message').get() as { id: number | null }
    return row.id ?? 0
  }

  /** Messages with ROWID greater than `afterRowId`, oldest first. */
  since(afterRowId: number, limit = 200): IncomingMessage[] {
    const rows = this.db.query(`
      SELECT
        m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.is_from_me, m.date, m.service,
        m.associated_message_type, m.item_type, m.cache_has_attachments,
        h.id AS sender,
        c.guid AS chat_guid, c.chat_identifier, c.style
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.ROWID > ?
      ORDER BY m.ROWID ASC
      LIMIT ?
    `).all(afterRowId, limit) as MessageRow[]

    return rows.map(row => ({
      rowid: row.rowid,
      guid: row.guid,
      text: row.text?.trim() ? row.text : decodeAttributedBody(row.attributedBody),
      isFromMe: row.is_from_me === 1,
      sentAt: appleDateToUnixMs(row.date),
      service: row.service ?? 'iMessage',
      sender: row.sender ? normalizeHandle(row.sender) : null,
      chatGuid: row.chat_guid,
      chatIdentifier: normalizeHandle(row.chat_identifier),
      chatStyle: row.style ?? CHAT_STYLE_DIRECT,
      associatedType: row.associated_message_type ?? 0,
      itemType: row.item_type ?? 0,
      hasAttachments: (row.cache_has_attachments ?? 0) === 1,
    }))
  }

  /**
   * The phone numbers and emails this Mac's Messages account sends and
   * receives as. A direct chat whose identifier is one of these is a
   * conversation with yourself - the "text myself" setup.
   */
  ownHandles(): string[] {
    const rows = this.db.query(`
      SELECT DISTINCT destination_caller_id AS handle FROM message
      WHERE destination_caller_id IS NOT NULL AND destination_caller_id != ''
      UNION
      SELECT DISTINCT account AS handle FROM message
      WHERE account IS NOT NULL AND account != ''
    `).all() as Array<{ handle: string }>

    const handles = new Set<string>()
    for (const { handle } of rows) {
      // `account` is prefixed with its kind: `e:me@icloud.com`, `p:+15551234567`.
      const normalized = normalizeHandle(handle.replace(/^[a-z]:/i, ''))
      if (isAddressable(normalized))
        handles.add(normalized)
    }
    return [...handles]
  }
}
