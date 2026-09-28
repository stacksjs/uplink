import type { UplinkConfig } from '../app/Uplink/types'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * **Uplink Configuration**
 *
 * Text this Mac, even over satellite, and an agent answers. These are the
 * defaults; every key can be overridden by the matching `UPLINK_*` environment
 * variable, which is what `.env` sets and what the downloadable app writes from
 * its own settings.
 *
 * The variable name is derived from the key: `pollMs` is `UPLINK_POLL_MS`,
 * `maxChars` is `UPLINK_MAX_CHARS`. Nothing here needs to list them.
 */

const MINUTE = 60_000

export default {
  /**
   * Handles allowed to command Uplink, as `UPLINK_ALLOWED`, comma separated.
   * Empty means this Mac's own Messages handles, the "text myself" setup.
   *
   * Anyone listed can make an agent act on this Mac, so list only yourself.
   */
  allowed: [],

  /**
   * The Messages database. Reading it needs Full Disk Access.
   */
  messagesDb: join(homedir(), 'Library', 'Messages', 'chat.db'),

  /**
   * How often to look for new texts.
   */
  pollMs: 2000,

  /**
   * On start, ignore commands older than this, so a Mac waking up does not
   * replay a day of texts.
   */
  catchUpMs: 30 * MINUTE,

  /**
   * Every reply starts with this, so replies stand apart in a thread with
   * yourself and Uplink never mistakes its own reply for a new command.
   */
  replyPrefix: '🛰 ',

  /**
   * Characters per text. Longer replies are split, and past `maxParts` the rest
   * waits for "more", because over a thin link a wall of texts is worse than a
   * short one.
   */
  maxChars: 1200,
  maxParts: 3,

  /**
   * "Working on it" once a run passes this, then a progress line this often.
   * Either can be 0 to disable it.
   */
  ackAfterMs: 20_000,
  progressEveryMs: 10 * MINUTE,

  /**
   * A thread idle longer than this starts a fresh agent session rather than
   * resuming one whose context has gone stale.
   */
  sessionIdleMs: 6 * 60 * MINUTE,

  /**
   * Where a run starts when a text names no path.
   */
  workdir: homedir(),

  /**
   * Which agent CLI answers a text: `claude` or `codex`.
   */
  engine: 'claude',

  /**
   * Claude Code. An empty `claudeBin` means "find it on this Mac", which a
   * config file cannot know: launchd hands agents a bare PATH, so the binary is
   * looked for where each installer puts it. Set it to pin a specific one.
   *
   * `bypassPermissions` because nobody is at the Mac to approve anything.
   */
  claudeBin: '',
  claudeModel: null,
  permissionMode: 'bypassPermissions',

  /**
   * Codex. Empty `codexBin` is the same "find it" rule, and it includes the
   * copy the ChatGPT desktop app bundles, which is not on PATH.
   *
   * `bypass` is Codex's spelling of the same trade `permissionMode` makes.
   */
  codexBin: '',
  codexModel: null,
  codexPermission: 'bypass',

  /**
   * How long one run may take before it is stopped.
   */
  timeoutMs: 90 * MINUTE,
} satisfies UplinkConfig
