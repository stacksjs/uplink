# Install

Two ways, and you should run only one of them. They share the launchd label
`com.stacksjs.uplink`, and the downloaded app stops the source service when it starts.

## The app

[Download Uplink for Mac](https://github.com/stacksjs/uplink/releases/latest/download/Uplink.dmg).
It is signed with a Developer ID and notarized by Apple, so it opens like any other app.

To check what you downloaded against the digest on the release page:

```bash
shasum -a 256 ~/Downloads/Uplink.dmg
```

Drag it to Applications and open it. The menubar walks you through three things:

1. **Full Disk Access**, which it opens System Settings for. See [Permissions](./permissions.md).
2. **Signing in to the agent you chose.** Claude Code opens your browser and keeps the token in
   your Keychain; Codex signs in once with `codex login` and keeps its own credentials.
3. **Permission to control Messages**, which macOS asks for the first time it tries to reply.

Then text yourself `ping`. The answer starts with a satellite.

Uplink answers texts once it is activated. A licence is
[$1.99 a month, $19.99 a year, or $29.99 once](https://uplink.stacksjs.com/pricing). The thank-you
page has an **Activate Uplink** button that opens the app with the key filled in, and a licensed
Mac keeps answering for two weeks without reaching the licence server, so it works off-grid.

## From source

The same app, run from a clone as a launchd service. Its bundle id is
`com.stacksjs.uplink.source`, so its Full Disk Access grant is separate from the downloaded app's.

```bash
git clone https://github.com/stacksjs/uplink && cd uplink
```

```bash
bun install && ./buddy uplink:install
```

That creates `.env` and the database if they are missing, builds
`storage/uplink/Uplink.app` and starts it at login.

Then grant **Full Disk Access to Uplink (source)** in System Settings, and sign in to the agent you
want:

```bash
claude setup-token
```

```bash
./buddy env:set CLAUDE_CODE_OAUTH_TOKEN "$(pbpaste | tr -d '[:space:]')"
```

A long-lived token, because a background service cannot answer a browser prompt. For Codex instead:

```bash
codex login   # or: codex login --device-auth, over SSH
```

```bash
./buddy env:set UPLINK_ENGINE codex
```

Check it, then text yourself `ping`:

```bash
./buddy uplink:doctor
```

## Texting yourself over satellite

Test this once before relying on it. A text to your own number can be delivered to your other
devices without going through the satellite link at all, so confirm the Mac receives a self-text
sent while in satellite mode.

If it does not, use a second Apple ID: sign Messages on the Mac into it, and set the allow list to
your own phone number.
