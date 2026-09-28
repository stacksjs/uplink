import type { IncomingMessage } from '../../../app/Uplink/messages-db'
import { afterEach, describe, expect, it } from 'bun:test'
import { classify } from '../../../app/Uplink/filter'
import { normalizeHandle, parseHandleList } from '../../../app/Uplink/handles'
import { appleDateToUnixMs, MessagesAccessError, MessagesDb } from '../../../app/Uplink/messages-db'
import { decodeAttributedBody, encodeAttributedBody } from '../../../app/Uplink/typedstream'
import { FakeChatDb, FRIEND, ME, ME_EMAIL } from './fixtures'

describe('attributedBody', () => {
  it('round-trips short, long and non-ASCII text through every length encoding', () => {
    for (const text of ['hi', 'Whats the NFL score rn? 🏈', 'x'.repeat(200), 'ü'.repeat(40_000)])
      expect(decodeAttributedBody(encodeAttributedBody(text))).toBe(text)
  })

  it('decodes the byte layout Messages writes, independent of our encoder', () => {
    // Hand-assembled from the documented typedstream layout (see imessage-exporter), not captured
    // from a live chat.db: this sandbox has no Full Disk Access. Swap in a real blob once one is.
    const hex = '040b73747265616d747970656481e803840140848484124e5341747472696275746564537472696e67008484084e534f626a656374008592848484084e53537472696e67019484012b1048656c6c6f2066726f6d2073706163658684'
    const blob = new Uint8Array(hex.match(/../g)!.map(b => Number.parseInt(b, 16)))
    expect(decodeAttributedBody(blob)).toBe('Hello from space')
  })

  it('returns null for missing or unrecognizable blobs', () => {
    expect(decodeAttributedBody(null)).toBeNull()
    expect(decodeAttributedBody(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})

describe('handles', () => {
  it('normalizes phone numbers and emails to one form', () => {
    expect(normalizeHandle('(555) 000-1111')).toBe('+15550001111')
    expect(normalizeHandle('1 555 000 1111')).toBe('+15550001111')
    expect(normalizeHandle('+44 20 7946 0958')).toBe('+442079460958')
    expect(normalizeHandle(' Me@iCloud.COM ')).toBe('me@icloud.com')
    expect(parseHandleList('+15550001111, me@icloud.com;(555) 000-2222\n')).toEqual([ME, ME_EMAIL, FRIEND])
    expect(parseHandleList('+44 20 7946 0958')).toEqual(['+442079460958'])
  })
})

describe('MessagesDb', () => {
  let fake: FakeChatDb
  afterEach(() => fake?.close())

  it('reads text from attributedBody, converts Apple dates, and joins chats', () => {
    fake = new FakeChatDb()
    const at = Date.UTC(2026, 8, 27, 18, 30)
    fake.add({ chat: ME, text: 'score?', fromMe: true, at })
    fake.add({ chat: FRIEND, text: 'dinner?', plainText: true })

    const db = new MessagesDb(fake.path)
    const [mine, theirs] = db.since(0)
    expect(mine).toMatchObject({ text: 'score?', isFromMe: true, sentAt: at, chatIdentifier: ME, chatGuid: `iMessage;-;${ME}`, sender: null })
    expect(theirs).toMatchObject({ text: 'dinner?', isFromMe: false, sender: FRIEND })
    expect(db.latestRowId()).toBe(theirs.rowid)
    expect(db.since(theirs.rowid)).toEqual([])
    db.close()
  })

  it('finds the account\'s own handles, stripping the account kind prefix', () => {
    fake = new FakeChatDb()
    for (let i = 0; i < 4; i++)
      fake.add({ chat: FRIEND, text: `hey ${i}` })
    const db = new MessagesDb(fake.path)
    expect(db.ownHandles().sort()).toEqual([ME, ME_EMAIL].sort())
    db.close()
  })

  it('explains a missing Full Disk Access grant', () => {
    expect(() => new MessagesDb('/nonexistent/chat.db')).toThrow(MessagesAccessError)
    expect(appleDateToUnixMs(0)).toBe(978_307_200_000)
  })
})

describe('classify', () => {
  const base: IncomingMessage = {
    rowid: 1,
    guid: 'g',
    text: 'what are the NFL scores',
    isFromMe: false,
    sentAt: 0,
    service: 'iMessage',
    sender: FRIEND,
    chatGuid: `iMessage;-;${FRIEND}`,
    chatIdentifier: FRIEND,
    chatStyle: 45,
    associatedType: 0,
    itemType: 0,
    hasAttachments: false,
  }
  const ctx = {
    allowed: new Set([ME, FRIEND]),
    own: new Set([ME]),
    replyPrefix: '🛰 ',
    wasSentByUplink: () => false,
  }

  it('accepts a text from an allowed handle, and my own texts to myself', () => {
    expect(classify(base, ctx)).toEqual({ accept: true, text: 'what are the NFL scores' })
    expect(classify({ ...base, isFromMe: true, sender: null, chatIdentifier: ME, chatGuid: `iMessage;-;${ME}` }, ctx).accept).toBe(true)
  })

  it('accepts a self-text filed under my number but sent from my email', () => {
    const own = new Set([ME, ME_EMAIL])
    const selfCtx = { ...ctx, allowed: own, own }
    expect(classify({ ...base, chatIdentifier: ME, chatGuid: `iMessage;-;${ME}`, sender: ME_EMAIL }, selfCtx).accept).toBe(true)
    // Someone else's handle in my self-chat is still refused.
    expect(classify({ ...base, chatIdentifier: ME, chatGuid: `iMessage;-;${ME}`, sender: FRIEND }, selfCtx)).toEqual({ accept: false, reason: 'sender mismatch' })
  })

  it('refuses SMS even from an allowed handle, because sender IDs are spoofable', () => {
    // With Text Message Forwarding on, a forwarded SMS is a direct chat whose
    // identifier is the sender's number, so every other check here passes.
    expect(classify({ ...base, service: 'SMS' }, ctx)).toEqual({ accept: false, reason: 'not iMessage' })
    expect(classify({ ...base, service: 'SMS', chatIdentifier: ME, chatGuid: `SMS;-;${ME}`, isFromMe: true, sender: null }, ctx))
      .toEqual({ accept: false, reason: 'not iMessage' })
  })

  it('fails closed on everything else', () => {
    const rejected: Array<[Partial<IncomingMessage>, string]> = [
      [{ service: 'SMS' }, 'not iMessage'],
      [{ service: 'RCS' }, 'not iMessage'],
      [{ chatIdentifier: '+15559999999', sender: '+15559999999' }, 'chat not allowed'],
      [{ chatStyle: 43 }, 'group chat'],
      [{ isFromMe: true, sender: null }, 'outgoing message'],
      [{ sender: '+15559999999' }, 'sender mismatch'],
      [{ associatedType: 2000 }, 'not a text message'],
      [{ itemType: 1 }, 'not a text message'],
      [{ text: '￼' }, 'empty'],
      [{ text: null }, 'empty'],
      [{ text: '🛰 Here are the scores' }, 'uplink reply'],
    ]
    for (const [patch, reason] of rejected)
      expect(classify({ ...base, ...patch }, ctx)).toEqual({ accept: false, reason })

    expect(classify(base, { ...ctx, wasSentByUplink: () => true })).toEqual({ accept: false, reason: 'uplink reply' })
    expect(classify(base, { ...ctx, allowed: new Set() })).toEqual({ accept: false, reason: 'chat not allowed' })
  })
})
