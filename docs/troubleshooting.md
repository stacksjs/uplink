# Troubleshooting

## It is not answering

Work down this list. The first two cover almost everything.

### 1. Read the log

```bash
tail -n 100 ~/Library/Logs/Uplink.log
```

This is the whole support story for the downloaded app: there is no crash reporting and no
diagnostics bundle. It records every poll failure, every refused reply and every crash, with a
stack. It rotates at 5 MB, so check `~/Library/Logs/Uplink.log.1` too if the tail looks truncated.

### 2. Check the menubar

The popover lists what setup still needs, and each line says what is wrong rather than only that
something is. The common ones:

- **Read Messages** is waiting for Full Disk Access. See [Permissions](./permissions.md).
- **Sign in** means the agent CLI is installed but not signed in.
- **Install** means the CLI is not there at all, and the line gives the command.
- **Send replies** means macOS has not been asked, or was refused, for permission to control
  Messages. This one fails after a run completes, so a task can look done and the phone hear
  nothing.

From a clone, `./buddy uplink:doctor` checks the same things and says how to fix each one. That
command needs the repository, so it is not available if you downloaded the app.

### 3. Check the obvious ones

- **Is it paused?** The menubar has a pause switch.
- **Is the licence current?** An expired one stops it answering. The menubar says so.
- **Is the Mac awake?** A laptop with its lid closed sleeps unless it is on power with a display
  attached. Texts that arrive while it sleeps are not run, and you get one reply saying so.
- **Are you texting from an allowed handle?** By default that is this Mac's own Messages handles.
- **Are you texting over iMessage?** SMS is refused by design. A green bubble never reaches it.

## It answered once and then stopped

Look for a run that is still going. `status` texts back what it is working on. `stop` cancels it
and anything queued behind it.

One thread runs one task at a time, so a long task blocks the ones behind it. That is deliberate:
two runs resuming one agent session would each write their own history.

## A text got "that arrived while this Mac was asleep"

It did, and it was not run. The cutoff exists so a Mac waking up does not replay a day of
instructions that could do real work nobody wants now. Send it again to run it now.

## Texting myself does not reach the Mac

A text to your own number can be delivered to your other devices without going through the
satellite link at all. Test it once in satellite mode before relying on it.

If it does not arrive, sign Messages on the Mac into a second Apple ID and set the allow list to
your own phone number instead.

## It says it cannot resume the conversation after switching agents

That is expected. A session id belongs to the agent that made it, and the other one cannot resume
it, so texting `claude` or `codex` starts a fresh conversation. The working directory stays.

## Nothing here helped

Open an issue with the last hundred lines of the log:
<https://github.com/stacksjs/uplink/issues>. Take out anything in a prompt you would rather not
share; the log records what you texted.
