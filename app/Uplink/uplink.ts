import type { ControlCommand } from './commands'
import type { UplinkConfig } from './config'
import type { Engine, EngineRun } from './engine'
import type { IncomingMessage } from './messages-db'
import type { ReplyTarget, Sender } from './sender'
import type { ConversationRecord, Store } from './store'
import { homedir } from 'node:os'
import { HELP_TEXT, parseControl } from './commands'
import { classify, RecentTexts } from './filter'
import { chunk, formatDuration, toPlainText, truncate } from './format'
import { detectWorkdir } from './workdir'

/**
 * The daemon: polls chat.db, turns allowed texts into agent runs, and texts
 * the results back.
 *
 * Each chat is served one run at a time - a second task waits in that chat's
 * queue - because runs in one thread resume one Claude Code session, and two
 * processes resuming the same session would each write their own history.
 * Control texts ("status", "stop", ...) never queue.
 */

export interface MessagesSource {
  latestRowId: () => number
  since: (afterRowId: number, limit?: number) => IncomingMessage[]
  ownHandles: () => string[]
}

export interface Logger {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

export interface UplinkDeps {
  config: UplinkConfig
  messages: MessagesSource
  sender: Sender
  engine: Engine
  store: Store
  systemPrompt?: string
  log?: Logger
  now?: () => number
}

interface Job {
  runId: number
  prompt: string
  cwd: string
  target: ReplyTarget
}

interface ActiveJob extends Job {
  run: EngineRun
  startedAt: number
  lastActivity: string | null
  stoppedByUser: boolean
  timers: Array<ReturnType<typeof setTimeout>>
}

interface ChatState {
  active: ActiveJob | null
  queue: Job[]
}

/** Two copies of one self-text are written within a few seconds of each other. */
const DUPLICATE_WINDOW_MS = 15_000
const SENT_MEMORY_MS = 30 * 60_000
const OWN_HANDLES_REFRESH_MS = 10 * 60_000

const consoleLogger: Logger = {
  info: m => console.log(`[uplink] ${new Date().toISOString()} ${m}`),
  warn: m => console.warn(`[uplink] ${new Date().toISOString()} WARN ${m}`),
  error: m => console.error(`[uplink] ${new Date().toISOString()} ERROR ${m}`),
}

export class Uplink {
  private readonly config: UplinkConfig
  private readonly log: Logger
  private readonly now: () => number
  private readonly sent: RecentTexts
  private readonly chats = new Map<string, ChatState>()
  private readonly lastCommand = new Map<string, number>()
  private own = new Set<string>()
  private allowed = new Set<string>()
  private ownRefreshedAt = 0
  private cursor = 0
  private startedAt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  lastPollAt: number | null = null
  lastError: string | null = null
  /** Why the last reply could not be delivered, for the heartbeat and the popover. */
  lastSendError: string | null = null
  private ticking = false
  private stopped = false

  constructor(private readonly deps: UplinkDeps) {
    this.config = deps.config
    this.log = deps.log ?? consoleLogger
    this.now = deps.now ?? Date.now
    this.sent = new RecentTexts(SENT_MEMORY_MS, this.now)
  }

  /** Handles currently allowed to command Uplink. */
  get allowedHandles(): string[] {
    return [...this.allowed]
  }

  get ownHandles(): string[] {
    return [...this.own]
  }

  /** Runs in progress across all chats, for the heartbeat. */
  get activeRuns(): Array<{ prompt: string, startedAt: number, lastActivity: string | null, queued: number }> {
    return [...this.chats.values()]
      .filter(state => state.active)
      .map(state => ({ prompt: state.active!.prompt, startedAt: state.active!.startedAt, lastActivity: state.active!.lastActivity, queued: state.queue.length }))
  }

  /** `poll: false` reads the cursor and handles but leaves polling to `tick()`. */
  async start(options: { poll?: boolean } = {}): Promise<void> {
    this.startedAt = this.now()
    this.refreshHandles(true)

    const stored = await this.deps.store.cursor()
    if (stored === null) {
      // First run ever: start from now, never from the whole message history.
      this.cursor = this.deps.messages.latestRowId()
      await this.deps.store.setCursor(this.cursor)
    }
    else {
      this.cursor = stored
    }

    if (this.allowed.size === 0)
      this.log.warn('No allowed handles: set UPLINK_ALLOWED, or sign Messages in so your own handles can be found. Ignoring every text until then.')
    else
      this.log.info(`Listening for texts from ${[...this.allowed].join(', ')}`)

    this.stopped = false
    if (options.poll !== false)
      this.schedule()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer)
      clearTimeout(this.timer)
    for (const state of this.chats.values()) {
      state.queue = []
      if (state.active) {
        state.active.stoppedByUser = true
        state.active.run.cancel()
      }
    }
  }

  /**
   * Stop every thread's task from the Mac: the menubar's Stop button. Each
   * thread that had one is told, because whoever texted is waiting for an
   * answer that is now not coming. Returns how many threads were stopped.
   */
  async stopAll(): Promise<number> {
    let stopped = 0
    for (const state of this.chats.values()) {
      const target = state.active?.target ?? state.queue[0]?.target
      const said = await this.stopThread(state, 'Stopped on the Mac')
      if (!said || !target)
        continue
      stopped++
      await this.reply(target, said)
    }
    return stopped
  }

  /**
   * Cancel a thread's current task and clear what is queued behind it. Returns
   * what to tell the thread, or null when there was nothing to stop.
   */
  private async stopThread(state: ChatState, verb: string): Promise<string | null> {
    const queued = state.queue.splice(0)
    for (const job of queued)
      await this.deps.store.updateRun(job.runId, { status: 'stopped', finishedAt: this.now() })
    if (!state.active)
      return queued.length > 0 ? `Cleared ${queued.length} queued.` : null
    state.active.stoppedByUser = true
    state.active.run.cancel()
    const said = `${verb}: ${truncate(state.active.prompt, 60)}${queued.length > 0 ? ` and cleared ${queued.length} queued` : ''}`
    // "Stopped: Whats the NFL score rn?" rather than "rn?."
    return /[.?!…]$/.test(said) ? said : `${said}.`
  }

  private schedule(): void {
    if (this.stopped)
      return
    this.timer = setTimeout(async () => {
      await this.tick()
      this.schedule()
    }, this.config.pollMs)
  }

  /** One poll of chat.db. Public so tests can drive it without timers. */
  async tick(): Promise<void> {
    if (this.ticking)
      return
    this.ticking = true
    try {
      this.refreshHandles(false)
      const messages = this.deps.messages.since(this.cursor)
      for (const message of messages) {
        await this.consider(message)
        this.cursor = message.rowid
        await this.deps.store.setCursor(this.cursor)
      }
      this.lastPollAt = this.now()
      this.lastError = null
    }
    catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.log.error(`Poll failed: ${this.lastError}`)
    }
    finally {
      this.ticking = false
    }
  }

  private refreshHandles(force: boolean): void {
    // Until some handle is allowed, look every poll: on a Mac whose Messages
    // history is empty, the first text is what reveals the account's handles.
    if (!force && this.allowed.size > 0 && this.now() - this.ownRefreshedAt < OWN_HANDLES_REFRESH_MS)
      return
    this.ownRefreshedAt = this.now()
    try {
      this.own = new Set(this.deps.messages.ownHandles())
    }
    catch (error) {
      this.log.warn(`Could not read own handles: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.allowed = new Set(this.config.allowed.length > 0 ? this.config.allowed : this.own)
  }

  private async consider(message: IncomingMessage): Promise<void> {
    const verdict = classify(message, {
      allowed: this.allowed,
      own: this.own,
      replyPrefix: this.config.replyPrefix,
      wasSentByUplink: (chat, text) => this.sent.has(chat, text),
    })
    if (!verdict.accept) {
      // Only chats someone may command are worth a line: a first test that
      // does nothing is then explained in the log. Other chats stay private.
      if (this.allowed.has(message.chatIdentifier) && verdict.reason !== 'uplink reply')
        this.log.info(`Ignored a message in ${message.chatIdentifier} (${message.isFromMe ? 'from me' : `from ${message.sender ?? 'unknown'}`}): ${verdict.reason}`)
      return
    }

    if (this.now() - message.sentAt > this.config.catchUpMs) {
      this.log.info(`Skipping stale text from ${formatDuration(this.now() - message.sentAt)} ago: ${truncate(verdict.text, 60)}`)
      return
    }

    // All my self-chats count as one: a self-text can be filed under my number
    // and my email at once, and must still run once.
    const thread = this.own.has(message.chatIdentifier) ? 'self' : message.chatGuid
    const key = `${thread}\u0000${verdict.text}`
    const previous = this.lastCommand.get(key)
    this.lastCommand.set(key, message.sentAt)
    if (previous !== undefined && Math.abs(message.sentAt - previous) < DUPLICATE_WINDOW_MS)
      return

    const target: ReplyTarget = {
      chatGuid: message.chatGuid,
      handle: message.chatIdentifier,
      service: message.service,
    }

    this.log.info(`Text from ${message.chatIdentifier}: ${truncate(verdict.text, 120)}`)

    const control = parseControl(verdict.text)
    if (control)
      await this.control(control, target)
    else
      await this.enqueue(verdict.text, message, target)
  }

  private chat(chatGuid: string): ChatState {
    let state = this.chats.get(chatGuid)
    if (!state) {
      state = { active: null, queue: [] }
      this.chats.set(chatGuid, state)
    }
    return state
  }

  private async conversation(target: ReplyTarget): Promise<ConversationRecord> {
    return await this.deps.store.conversation(target.chatGuid) ?? {
      chatGuid: target.chatGuid,
      handle: target.handle,
      service: target.service,
      sessionId: null,
      cwd: null,
      lastActiveAt: null,
      moreText: null,
      engine: null,
    }
  }

  private async enqueue(prompt: string, message: IncomingMessage, target: ReplyTarget): Promise<void> {
    const conversation = await this.conversation(target)
    const cwd = detectWorkdir(prompt, this.threadIsFresh(conversation) && conversation.cwd ? conversation.cwd : this.config.workdir)

    const runId = await this.deps.store.createRun({
      chatGuid: target.chatGuid,
      messageGuid: message.guid,
      prompt,
      cwd,
      status: 'queued',
    })

    const state = this.chat(target.chatGuid)
    const job: Job = { runId, prompt, cwd, target }
    if (state.active) {
      state.queue.push(job)
      await this.reply(target, `Queued behind the current task (${state.queue.length} waiting). Text "status" or "stop".`)
      return
    }

    await this.begin(state, job)
  }

  private threadIsFresh(conversation: ConversationRecord): boolean {
    return conversation.lastActiveAt !== null && this.now() - conversation.lastActiveAt < this.config.sessionIdleMs
  }

  private async begin(state: ChatState, job: Job): Promise<void> {
    const conversation = await this.conversation(job.target)
    const resume = conversation.sessionId && conversation.cwd === job.cwd && this.threadIsFresh(conversation)
      ? conversation.sessionId
      : null

    await this.deps.store.updateRun(job.runId, { status: 'running', startedAt: this.now() })

    const run = this.deps.engine.run({
      prompt: job.prompt,
      cwd: job.cwd,
      sessionId: resume,
      onEvent: (event) => {
        if (event.kind === 'tool' && state.active) {
          state.active.lastActivity = event.summary
          void this.deps.store.updateRun(job.runId, { lastActivity: event.summary })
        }
      },
    })

    const active: ActiveJob = { ...job, run, startedAt: this.now(), lastActivity: null, stoppedByUser: false, timers: [] }
    state.active = active

    if (this.config.ackAfterMs > 0) {
      active.timers.push(setTimeout(() => {
        if (state.active !== active)
          return
        const where = job.cwd === homedir() || job.cwd === this.config.workdir ? '' : ` in ${tildify(job.cwd)}`
        void this.reply(job.target, `Working on it${where}. Text "status" for progress or "stop" to cancel.`)
      }, this.config.ackAfterMs))
    }

    if (this.config.progressEveryMs > 0) {
      const tickProgress = (): void => {
        if (state.active !== active)
          return
        const latest = active.lastActivity ? ` Latest: ${active.lastActivity}` : ''
        void this.reply(job.target, `Still working (${formatDuration(this.now() - active.startedAt)}).${latest}`)
        active.timers.push(setTimeout(tickProgress, this.config.progressEveryMs))
      }
      active.timers.push(setTimeout(tickProgress, this.config.progressEveryMs))
    }

    void run.done.then(result => this.finish(state, active, result))
  }

  private async finish(state: ChatState, active: ActiveJob, result: Awaited<EngineRun['done']>): Promise<void> {
    for (const timer of active.timers)
      clearTimeout(timer)
    if (state.active === active)
      state.active = null

    const status = active.stoppedByUser ? 'stopped' : result.ok ? 'done' : 'failed'
    await this.deps.store.updateRun(active.runId, {
      status,
      reply: result.ok ? result.text : null,
      error: result.ok ? null : result.text,
      sessionId: result.sessionId,
      costCents: result.costCents,
      durationMs: result.durationMs,
      finishedAt: this.now(),
    })

    const conversation = await this.conversation(active.target)
    await this.deps.store.saveConversation({
      ...conversation,
      sessionId: result.sessionId ?? conversation.sessionId,
      cwd: active.cwd,
      lastActiveAt: this.now(),
    })

    if (!active.stoppedByUser) {
      // Naming the wrong CLI, or a .env the downloadable app does not have,
      // sends someone at the Mac to fix something that is not broken. The
      // engine carries its own remedy.
      const engine = this.deps.engine
      const text = result.authFailure
        ? `I cannot reach ${engine.label}: it is not signed in on this Mac. Someone there needs to ${engine.authFailureHint}.`
        : result.ok ? result.text : `That failed: ${result.text}`

      // A run whose answer never left the Mac is not done, whatever the agent
      // did. Recording it as done is how a first install reports itself healthy
      // while the phone hears nothing.
      if (!await this.reply(active.target, text, { keepRest: true })) {
        await this.deps.store.updateRun(active.runId, {
          status: 'failed',
          error: `The answer could not be delivered through Messages: ${this.lastSendError ?? 'unknown error'}`,
        })
      }
    }

    const next = state.queue.shift()
    if (next && !this.stopped)
      await this.begin(state, next)
  }

  /**
   * Answers a control word. `reply` reports whether it delivered, which
   * `finish` acts on for a real answer; a control reply is said and forgotten,
   * so the result is deliberately dropped here.
   */
  private async control(command: ControlCommand, target: ReplyTarget): Promise<void> {
    const state = this.chat(target.chatGuid)

    switch (command) {
      case 'help':
        await this.reply(target, HELP_TEXT)
        return

      case 'ping':
        await this.reply(target, `pong (up ${formatDuration(this.now() - this.startedAt)})`)
        return

      case 'status': {
        if (!state.active) {
          await this.reply(target, 'Idle. Text me a question or a task.')
          return
        }
        const active = state.active
        const lines = [
          `Working ${formatDuration(this.now() - active.startedAt)} on: ${truncate(active.prompt, 80)}`,
          active.lastActivity ? `Latest: ${active.lastActivity}` : 'Thinking.',
        ]
        if (state.queue.length > 0)
          lines.push(`${state.queue.length} queued.`)
        await this.reply(target, lines.join('\n'))
        return
      }

      case 'stop':
        await this.reply(target, await this.stopThread(state, 'Stopped') ?? 'Nothing running.')
        return

      case 'new': {
        const conversation = await this.conversation(target)
        await this.deps.store.saveConversation({ ...conversation, sessionId: null, cwd: null, moreText: null })
        await this.reply(target, 'Fresh start. Your next text begins a new conversation.')
        return
      }

      case 'more': {
        const conversation = await this.conversation(target)
        if (!conversation.moreText) {
          await this.reply(target, 'Nothing more to send.')
          return
        }
        await this.reply(target, conversation.moreText, { keepRest: true })
      }
    }
  }

  /**
   * Sends `text`, split into parts. With `keepRest`, anything beyond
   * `maxParts` is saved for "more" - over satellite, a wall of texts is slow
   * and easy to lose track of. Short status replies never touch the stored
   * conversation, so one sent mid-run cannot race the run's own save.
   */
  async reply(target: ReplyTarget, text: string, options: { keepRest?: boolean } = {}): Promise<boolean> {
    const parts = chunk(toPlainText(text), this.config.maxChars - this.config.replyPrefix.length)
    const now = parts.slice(0, this.config.maxParts)
    const later = parts.slice(this.config.maxParts)

    if (options.keepRest) {
      if (later.length > 0)
        now[now.length - 1] += `\n(${later.length} more, text "more")`
      const conversation = await this.conversation(target)
      await this.deps.store.saveConversation({ ...conversation, moreText: later.length > 0 ? later.join('\n\n') : null })
    }

    for (const part of now) {
      const body = `${this.config.replyPrefix}${part}`
      this.sent.add(target.chatGuid, body)
      try {
        await this.deps.sender.send(target, body)
      }
      catch (error) {
        this.lastSendError = error instanceof Error ? error.message : String(error)
        this.log.error(`Reply to ${target.handle} failed: ${this.lastSendError}`)
        return false
      }
    }
    this.lastSendError = null
    return true
  }
}

function tildify(path: string): string {
  const home = homedir()
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path
}
