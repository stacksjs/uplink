# Uplink

Text your Mac from anywhere, even over satellite with no data, and Claude answers.

Newer iPhones can send iMessages over satellite when there is no cell or Wi-Fi signal, but nothing
that needs the internet works. Uplink turns those texts into a way to reach Claude: it watches
Messages on this Mac for texts from you, runs each one through Claude Code (on your Claude Max
login, no API key), and texts the answer back.

- "Whats the NFL score rn?" gets a web search and a two-line answer.
- "please improve ~/Code/stacks with feature xyz" runs a full Claude Code session inside
  `~/Code/stacks`, with that repo's CLAUDE.md, hooks and settings, and texts you a summary.
- Follow-ups continue the same conversation until you text `new`.

## How it works

```
iPhone --(iMessage, maybe via satellite)--> Messages on this Mac --> ~/Library/Messages/chat.db
                                                                        |
                                                  Uplink.app polls it every 2s (Full Disk Access)
                                                                        |
                                       claude -p ... --resume <thread session>  (in the named repo)
                                                                        |
iPhone <------------------------- Messages (AppleScript) <------- the reply, as plain text
```

- **Who can command it:** only direct (never group) chats with an allowed handle. By default that is
  this Mac's own Messages handles, so you text yourself. `UPLINK_ALLOWED` sets it explicitly. A
  message is honored only if it passes `app/Uplink/filter.ts`; everything else is ignored.
- **One task at a time per thread.** A second task queues. `status`, `stop`, `new`, `more`, `ping`
  and `help` are answered immediately and never queue.
- **Built for a thin link:** plain text, short answers, long replies split into up to 3 texts with
  the rest behind `more`, a "Working on it" after 20s and a progress line every 10 minutes.
- **Replies start with 🛰**, so they stand apart in a thread with yourself, and so Uplink never
  mistakes its own reply for a new command.
- Runs are recorded in the `runs` table (cost in integer cents, at API rates; on Max nothing is
  billed per run) and shown on the dashboard.

## Setup

1. **Install the background service.** Builds `storage/uplink/Uplink.app` and starts it at login:

   ```bash
   ./buddy uplink:install
   ```

2. **Grant Full Disk Access to Uplink.app** (System Settings > Privacy & Security > Full Disk
   Access). Reading Messages needs it, and only Uplink.app gets it, not `bun` or your terminal.
   `uplink:install` opens the pane and reveals the app in Finder.

3. **Log the Claude CLI in with your Max account**, as a long-lived token for a background service:

   ```bash
   claude setup-token
   ```

   ```bash
   ./buddy env:set CLAUDE_CODE_OAUTH_TOKEN <token>
   ```

4. **Restart and check:**

   ```bash
   ./buddy uplink:restart
   ```

   ```bash
   ./buddy uplink:doctor
   ```

5. Text yourself `ping`. The first reply makes macOS ask whether Uplink may control Messages: allow it.

Keep the Mac awake and online while you are away: Uplink holds an idle-sleep assertion while it
runs, but a closed laptop lid still sleeps unless it is on power with an external display.

### Texting yourself over satellite

Test this once before relying on it. A text to your own number can be delivered to your other
devices without going through the satellite link at all, so confirm the Mac receives a
self-text sent while in satellite mode. If it does not, use a second Apple ID: sign Messages on
this Mac into it, and set `UPLINK_ALLOWED` to your own phone number.

## Commands

| Command | What it does |
|---|---|
| `./buddy uplink:install [--rebuild]` | Build Uplink.app and start it at login. `--rebuild` recompiles it, which voids its Full Disk Access grant |
| `./buddy uplink:doctor` | Check every requirement and say how to fix what is missing |
| `./buddy uplink:restart` | Restart now, e.g. after granting a permission. Editing `.env` restarts it on its own once no run is in progress |
| `./buddy uplink:uninstall` | Stop it and remove it from login |
| `./buddy uplink:ask "<prompt>"` | Run one prompt exactly as a text would, without Messages |
| `./buddy uplink:watch` | The watcher itself, in the foreground (needs Full Disk Access for your terminal) |
| `./buddy dev` | The dashboard: setup status, what it is doing, recent texts |

Configuration lives in `.env`; see the `UPLINK_*` block in `.env.example`. The service picks up edits by itself.

## Layout

- `app/Uplink/`: the daemon (`uplink.ts`), the chat.db reader (`messages-db.ts`,
  `typedstream.ts`), the command filter (`filter.ts`), the Claude Code engine (`engine.ts`),
  replies (`sender.ts`, `format.ts`), the launchd service and app bundle (`service.ts`,
  `launcher.ts`) and setup checks (`doctor.ts`).
- `app/Commands/Uplink.ts`: the `buddy uplink:*` commands.
- `app/Models/`: `Conversation` (a thread and its Claude session) and `Run` (one text, one run).
- `resources/views/index.stx`: the dashboard.
- `tests/unit/uplink/`: against a real chat.db-shaped SQLite file and a stub `claude`.

```bash
./pantry/.bin/bun test tests/unit/uplink
```
