# Configuration

There are two ways to configure Uplink, and which one applies depends on how you installed it.

- **The app** reads `~/Library/Application Support/Uplink/settings.json`, which the menubar writes.
  You do not normally edit it by hand.
- **From source** reads `.env`. The service picks up edits by itself, once no run is in progress.

Both end up in the same shape. `config/uplink.ts` holds the defaults, and every key can be
overridden by its `UPLINK_*` variable.

## What the menubar sets

| Setting | What it is |
| --- | --- |
| Who can text it | The handles allowed to command Uplink. Empty means this Mac's own Messages handles, the "text yourself" setup |
| Agent | Claude Code or Codex, for the whole installation. A thread can override it by texting `claude` or `codex` |
| Model | The model alias for runs. Empty means the CLI's default |
| Where runs start | The directory a run uses when a text names no path |
| Open at login | Whether the LaunchAgent starts it |
| Paused | Read nothing, answer nothing, until resumed |

A `settings.json` this build cannot read falls back per field rather than refusing to start, so a
hand edit with a typo cannot stop the app.

## Every variable

These are the `.env` names. The app builds the same environment from its settings.

### Who and where

| Variable | Default | What it does |
| --- | --- | --- |
| `UPLINK_ALLOWED` | empty | Comma separated handles allowed to command it. Empty means your own |
| `UPLINK_WORKDIR` | `~` | Where a run starts when a text names no path |

Anyone on that list can make an agent act on your Mac. List only yourself.

### Which agent

| Variable | Default | What it does |
| --- | --- | --- |
| `UPLINK_ENGINE` | `claude` | `claude` or `codex` |
| `CLAUDE_CODE_OAUTH_TOKEN` | none | From `claude setup-token`. Encrypt it with `./buddy env:set` |
| `UPLINK_CLAUDE_MODEL` | empty | Model alias. `UPLINK_MODEL` is the older name and still works |
| `UPLINK_CLAUDE_BIN` | found | Where the `claude` binary is, if it is not on PATH |
| `UPLINK_CODEX_BIN` | found | Where `codex` is. Uplink also looks inside ChatGPT.app, which bundles one |
| `UPLINK_CODEX_MODEL` | empty | Model the agent should use |
| `UPLINK_CODEX_PERMISSION` | `bypass` | How much Codex may do without asking. Also `danger-full-access`, `workspace-write`, `read-only` |

Codex keeps its own credentials under `CODEX_HOME`, so there is no token to put in `.env`.

"Found" means Uplink looks where each installer puts the binary, because launchd hands a background
service a bare PATH and `claude` from your shell is not necessarily findable.

### Replies

| Variable | Default | What it does |
| --- | --- | --- |
| `UPLINK_MAX_CHARS` | `1200` | Characters per text. Longer replies are split |
| `UPLINK_MAX_PARTS` | `3` | Parts sent at once. The rest waits for `more` |
| `UPLINK_REPLY_PREFIX` | `🛰 ` | Every reply starts with this |
| `UPLINK_ACK_AFTER_MS` | `20000` | "Working on it" once a run passes this. 0 disables |
| `UPLINK_PROGRESS_EVERY_MS` | `600000` | A progress line this often. 0 disables |

The prefix matters for more than looks: it is how Uplink tells its own replies apart from new
commands in a thread with yourself.

### Timing

| Variable | Default | What it does |
| --- | --- | --- |
| `UPLINK_POLL_MS` | `2000` | How often to look for new texts |
| `UPLINK_TIMEOUT_MS` | `5400000` | How long one run may take before it is stopped |
| `UPLINK_CATCH_UP_MS` | `1800000` | On start, skip commands older than this |
| `UPLINK_SESSION_IDLE_MS` | `21600000` | A thread idle longer than this starts a fresh agent session |

`UPLINK_CATCH_UP_MS` is why a Mac waking after a night asleep does not replay the whole night. A
text older than it is not run, and you get one reply saying so rather than silence.

## Where things live

| Path | What it is |
| --- | --- |
| `~/Library/Application Support/Uplink/settings.json` | The app's settings |
| `~/Library/Application Support/Uplink/uplink.sqlite` | Conversations and runs |
| `~/Library/Application Support/Uplink/license.json` | The last answer the licence server gave |
| `~/Library/Logs/Uplink.log` | The log, rotated at 5 MB to `Uplink.log.1` |
| `~/Library/LaunchAgents/com.stacksjs.uplink.plist` | What starts it at login |

Two things are in the Keychain rather than in a file, both under the service
`com.stacksjs.uplink`: the account `claude-oauth-token` and the account `license-key`.
