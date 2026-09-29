# Uplink

Text your Mac from anywhere, even over satellite with no data, and an agent answers.

Newer iPhones can send iMessages over satellite when there is no cell or Wi-Fi signal, but nothing
that needs the internet works. Uplink turns those texts into a way to reach a coding agent: it
watches Messages on your Mac for texts from you, runs each one through Claude Code or Codex, and
texts the answer back.

## What you need

- **An Apple Silicon Mac.** The app is arm64 only, so an Intel Mac cannot run it.
- **macOS 13 or later.**
- **Claude Code on a Claude plan, or Codex on a ChatGPT plan.** No API key either way.
- **Full Disk Access for Uplink**, so it can read Messages. See [Permissions](./permissions.md).
- **Permission to control Messages**, so it can reply. Asked once.
- **A Mac that stays awake.** A laptop with its lid closed sleeps unless it is on power with a
  display attached.

## Two ways to run it

**The app.** Download it, drag it to Applications, and the menubar walks you through setup. This is
what most people want. See [Install](./install.md).

**From source.** A launchd service run out of a clone of the repository, with its own bundle id so
its Full Disk Access grant is separate from the app's. Also in [Install](./install.md).

Only run one of them. They share a launchd label, and the app stops the source service when it
starts.

## Texting it

Send yourself a message. Anything that is not one of the words below becomes a task for the agent,
running in the directory your text names, or your home directory if it names none.

| Word | What it does |
| --- | --- |
| `help` | The list, texted back |
| `status` | What it is working on, and which agent |
| `stop` | Cancel the current task and anything queued behind it |
| `new` | Start a fresh conversation |
| `more` | The rest of a long reply |
| `ping` | Check it is alive |
| `claude` / `codex` | Switch this thread to that agent |

Only a whole message counts, so "stop the dev server in ~/Code/api" is still a task.

## Where to go next

- [Install](./install.md)
- [Permissions](./permissions.md): what macOS asks for and why
- [Configuration](./configuration.md): every setting, both ways of setting them
- [Security](./security.md): what a text can do, and what leaves your Mac
- [Troubleshooting](./troubleshooting.md): it is not answering
- [Uninstall](./uninstall.md): removing it completely
