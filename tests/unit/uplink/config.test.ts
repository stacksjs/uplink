import { describe, expect, it } from 'bun:test'
import process from 'node:process'
import { loadConfig } from '../../../app/Uplink/config'
import defaults from '../../../config/uplink'

describe('loadConfig', () => {
  it('reads its defaults from config/uplink.ts', () => {
    const config = loadConfig({})
    expect(config.pollMs).toBe(defaults.pollMs)
    expect(config.maxChars).toBe(defaults.maxChars)
    expect(config.replyPrefix).toBe(defaults.replyPrefix)
    expect(config.engine).toBe(defaults.engine)
  })

  /**
   * The whole reason this loader does not call bunfig's `loadConfig`. That
   * applies the environment to `defaultConfig` and then merges the config file
   * over the result, so every key present in config/uplink.ts would ignore its
   * UPLINK_* variable, silently, and .env is how Uplink is configured.
   */
  it('lets the environment override a key the config file already sets', () => {
    const config = loadConfig({
      UPLINK_POLL_MS: '55',
      UPLINK_MAX_CHARS: '400',
      UPLINK_REPLY_PREFIX: 'sat ',
      UPLINK_ENGINE: 'codex',
    })
    expect(config.pollMs).toBe(55)
    expect(config.maxChars).toBe(400)
    expect(config.replyPrefix).toBe('sat ')
    expect(config.engine).toBe('codex')

    // And the file still wins over nothing at all.
    expect(loadConfig({}).pollMs).toBe(defaults.pollMs)
  })

  it('derives the variable name from the key, for every documented one', () => {
    // These are the names .env.example documents. If bunfig's derivation ever
    // stops matching them, an existing .env goes quietly ignored.
    const config = loadConfig({
      UPLINK_CATCH_UP_MS: '1000',
      UPLINK_MAX_PARTS: '5',
      UPLINK_ACK_AFTER_MS: '1',
      UPLINK_PROGRESS_EVERY_MS: '2',
      UPLINK_SESSION_IDLE_MS: '3',
      UPLINK_TIMEOUT_MS: '4',
      UPLINK_WORKDIR: '/tmp/work',
      UPLINK_MESSAGES_DB: '/tmp/chat.db',
      UPLINK_PERMISSION_MODE: 'acceptEdits',
      UPLINK_CODEX_PERMISSION: 'read-only',
      UPLINK_CLAUDE_MODEL: 'sonnet',
      UPLINK_CODEX_MODEL: 'gpt-5-codex',
    })
    expect(config).toMatchObject({
      catchUpMs: 1000,
      maxParts: 5,
      ackAfterMs: 1,
      progressEveryMs: 2,
      sessionIdleMs: 3,
      timeoutMs: 4,
      workdir: '/tmp/work',
      messagesDb: '/tmp/chat.db',
      permissionMode: 'acceptEdits',
      codexPermission: 'read-only',
      claudeModel: 'sonnet',
      codexModel: 'gpt-5-codex',
    })
  })

  it('normalizes a handle list however it was written', () => {
    expect(loadConfig({ UPLINK_ALLOWED: '(555) 000-1111, me@example.com' }).allowed)
      .toEqual(['+15550001111', 'me@example.com'])
    expect(loadConfig({}).allowed).toEqual([])
  })

  it('keeps UPLINK_MODEL working, which predates the second engine', () => {
    expect(loadConfig({ UPLINK_MODEL: 'opus' }).claudeModel).toBe('opus')
    // The explicit name wins when both are set.
    expect(loadConfig({ UPLINK_MODEL: 'opus', UPLINK_CLAUDE_MODEL: 'sonnet' }).claudeModel).toBe('sonnet')
  })

  it('falls back rather than throwing on a value it does not recognize', () => {
    expect(loadConfig({ UPLINK_ENGINE: 'gemini' }).engine).toBe('claude')
    expect(loadConfig({ UPLINK_CODEX_PERMISSION: 'whatever' }).codexPermission).toBe('bypass')
  })

  it('finds an agent binary when the config file names none', () => {
    // An empty bin means "find it on this Mac", which a config file cannot
    // know. A named one is taken as given.
    expect(loadConfig({ UPLINK_CLAUDE_BIN: '/custom/claude' }).claudeBin).toBe('/custom/claude')
    expect(loadConfig({}).claudeBin).not.toBe('')
  })

  it('leaves process.env alone when given an environment to read instead', () => {
    const before = process.env.UPLINK_POLL_MS
    loadConfig({ UPLINK_POLL_MS: '55' })
    expect(process.env.UPLINK_POLL_MS).toBe(before)
  })
})
