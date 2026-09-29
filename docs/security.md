# Security

Uplink lets a text message run a coding agent on your Mac with no one there to approve anything.
That is the product, and it is worth understanding before you point it at a machine that matters.

## What a text can do

A text that passes the filter becomes an agent run with approvals turned off:
`bypassPermissions` for Claude Code, `bypass` for Codex. Nobody is at the Mac to answer a prompt,
so there are no prompts.

Inside the directory your text names, that agent can read files, write files and run commands, with
your permissions. It is the same authority you have at a terminal on that Mac.

**So an iPhone with access to the allowed thread is an unlocked door.** If your phone is stolen and
unlocked, whoever holds it can text your Mac. Treat the allow list the way you would treat SSH keys.

You can narrow this. `UPLINK_CODEX_PERMISSION` takes `read-only` and `workspace-write` as well as
`bypass`, at the cost of tasks that need to write failing instead of asking.

## What cannot reach it

The filter refuses by default rather than allowing by default. A message has to pass all of these:

- **iMessage only.** SMS is rejected outright, because a forwarded SMS sender id can be spoofed
  through bulk-SMS gateways, and the other side of that door is an agent with approvals disabled.
- **Direct chats only.** A group chat never reaches it, whoever is in it.
- **An allowed handle.** Empty means this Mac's own Messages handles, so the default install
  answers only you.
- **Not a tapback, not a system item, not Uplink's own reply.**
- **Not stale.** A text older than `UPLINK_CATCH_UP_MS` is not run, so a Mac waking up cannot
  replay a day of instructions.

## What leaves your Mac

Three things, and nothing else.

**The prompt and whatever the agent reads go to the agent's vendor**, Anthropic or OpenAI, under
your own account and their privacy terms. That is what running Claude Code or Codex means, and it
is the same as running them yourself at a terminal.

**Your texts go through Apple**, as any iMessage does.

**A licence check goes to `uplink.stacksjs.com`**, at launch and every six hours. It sends the
licence key and nothing else. A licensed Mac keeps working for two weeks without reaching it, so an
off-grid Mac is not cut off. Buying a licence involves Stripe, which holds your email and payment
details; Uplink stores the key, your email and Stripe's customer and subscription ids.

Nothing else is sent anywhere. Runs, prompts, replies and their costs are recorded in a SQLite file
on the Mac and go nowhere.

## What is stored, and where

Two secrets are in the Keychain, not in a file: your Claude Code token and your licence key, both
under the service `com.stacksjs.uplink`. They are there rather than in
`~/Library/Application Support` because anything running as you can read a file there, and files
get swept into backups and dotfile repositories.

Everything else is under `~/Library/Application Support/Uplink`. See
[Configuration](./configuration.md#where-things-live).

## The dashboard is local

`resources/views/dashboard.stx` lists who may text the Mac and every prompt they sent. It answers
404 wherever the site is deployed, and the deploy checks that on every release, because a 200 there
would be a privacy failure rather than a bug.
