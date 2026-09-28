import type { IncomingMessage } from './messages-db'
import { CHAT_STYLE_DIRECT } from './messages-db'

/**
 * Decides which rows in chat.db are commands for Uplink.
 *
 * This is the security boundary of the whole app: a message that passes here
 * is handed to an agent that can read and change anything on this Mac. So the
 * rule is an allowlist, never a denylist, and every check fails closed.
 *
 * A message is a command when ALL of these hold:
 *  - it is in a one-to-one chat (never a group: anyone could be added to one),
 *  - that chat is with an allowed handle,
 *  - it was sent BY that handle - or, in a chat with one of this Mac's own
 *    handles ("text myself"), sent by me, since that is the only way my
 *    phone's messages to myself show up,
 *  - it is a plain text message (no tapback, edit marker or system item),
 *  - it is not one of Uplink's own replies coming back around.
 */

export interface FilterContext {
  /** Handles allowed to command Uplink, normalized. */
  allowed: ReadonlySet<string>
  /** This Mac's own Messages handles, normalized. */
  own: ReadonlySet<string>
  /** Prefix Uplink puts on every reply. */
  replyPrefix: string
  /** True when `text` was sent by Uplink recently (loop guard). */
  wasSentByUplink: (chatGuid: string, text: string) => boolean
}

export type Verdict =
  | { accept: true, text: string }
  | { accept: false, reason: string }

export function classify(message: IncomingMessage, ctx: FilterContext): Verdict {
  if (message.chatStyle !== CHAT_STYLE_DIRECT)
    return { accept: false, reason: 'group chat' }

  if (!ctx.allowed.has(message.chatIdentifier))
    return { accept: false, reason: 'chat not allowed' }

  if (message.isFromMe) {
    // In a chat with someone else, "from me" is me (or Uplink) talking to
    // them. Only in a chat with myself is it a command.
    if (!ctx.own.has(message.chatIdentifier))
      return { accept: false, reason: 'outgoing message' }
  }
  else if (message.sender && message.sender !== message.chatIdentifier) {
    // A text to myself can arrive under my email while the chat is filed
    // under my number. Both are mine, so it is still me.
    const bothMine = ctx.own.has(message.sender) && ctx.own.has(message.chatIdentifier)
    if (!bothMine)
      return { accept: false, reason: 'sender mismatch' }
  }

  if (message.associatedType !== 0 || message.itemType !== 0)
    return { accept: false, reason: 'not a text message' }

  const text = message.text?.replace(/￼/g, '').trim()
  if (!text)
    return { accept: false, reason: 'empty' }

  if (ctx.replyPrefix && text.startsWith(ctx.replyPrefix.trim()))
    return { accept: false, reason: 'uplink reply' }

  if (ctx.wasSentByUplink(message.chatGuid, text))
    return { accept: false, reason: 'uplink reply' }

  return { accept: true, text }
}

/**
 * Remembers recent texts per chat so the same text is acted on once.
 *
 * Texting yourself can land in chat.db twice - the copy your phone sent and
 * the copy this Mac received - and Uplink's own replies land there too. Both
 * are caught by keeping a short memory of (chat, text) pairs.
 */
export class RecentTexts {
  private seen = new Map<string, number>()

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  private key(chatGuid: string, text: string): string {
    return `${chatGuid}\u0000${text.trim().replace(/\s+/g, ' ').toLowerCase()}`
  }

  add(chatGuid: string, text: string): void {
    this.prune()
    this.seen.set(this.key(chatGuid, text), this.now())
  }

  has(chatGuid: string, text: string): boolean {
    const at = this.seen.get(this.key(chatGuid, text))
    return at !== undefined && this.now() - at < this.ttlMs
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs
    for (const [key, at] of this.seen) {
      if (at < cutoff)
        this.seen.delete(key)
    }
  }
}
