import type { CodexPermission } from './codex-engine'
import type { EngineId } from './engine'

/**
 * Uplink's settings, shared by `config/uplink.ts` and the code that reads it.
 *
 * The type lives here rather than beside the loader so the config file can be
 * typed without importing the loader, which imports the config file.
 */
export interface UplinkConfig {
  /** Handles allowed to command Uplink. Empty means "my own handles only". */
  allowed: string[]
  messagesDb: string
  pollMs: number
  /** On start, ignore commands older than this, so a Mac waking up does not replay a day of texts. */
  catchUpMs: number
  replyPrefix: string
  /** Characters per text; longer replies are split. */
  maxChars: number
  /** Parts sent at once; the rest waits for "more". */
  maxParts: number
  /** Send "Working on it" once a run passes this. 0 disables. */
  ackAfterMs: number
  /** Send a progress line this often during long runs. 0 disables. */
  progressEveryMs: number
  /** A thread idle longer than this starts a fresh agent session. */
  sessionIdleMs: number
  workdir: string
  /** Which agent CLI answers a text, unless a thread says otherwise. */
  engine: EngineId
  /** Empty means "find it on this Mac", which is what a config file cannot know. */
  claudeBin: string
  claudeModel: string | null
  /** How much Claude Code may do without asking. */
  permissionMode: string
  /** Empty means "find it on this Mac". */
  codexBin: string
  codexModel: string | null
  /** How much Codex may do without asking. The two CLIs spell this differently. */
  codexPermission: CodexPermission
  timeoutMs: number
}
