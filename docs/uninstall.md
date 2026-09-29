# Uninstall

One sequence per way of installing. Dragging the app to the Trash is not enough on its own: it
leaves a LaunchAgent pointing at a binary that is no longer there, which launchd keeps trying to
start.

## The app

**1. Quit it from the menubar.** That stops the watcher and releases its lock cleanly.

**2. Remove the login item.**

```bash
launchctl bootout gui/$(id -u)/com.stacksjs.uplink 2>/dev/null
rm -f ~/Library/LaunchAgents/com.stacksjs.uplink.plist
```

**3. Delete the app.**

```bash
rm -rf /Applications/Uplink.app
```

**4. Delete its data.** Conversations, runs, settings and the cached licence answer.

```bash
rm -rf ~/Library/Application\ Support/Uplink
```

**5. Delete the logs.**

```bash
rm -f ~/Library/Logs/Uplink.log ~/Library/Logs/Uplink.log.1
```

**6. Remove both Keychain items.** There are two, and only removing the first is the easy mistake.

```bash
security delete-generic-password -s com.stacksjs.uplink -a claude-oauth-token
security delete-generic-password -s com.stacksjs.uplink -a license-key
```

**7. Revoke the permissions**, in System Settings, Privacy & Security: remove Uplink from Full Disk
Access, and from Automation.

## From source

```bash
./buddy uplink:uninstall
```

That stops the service and removes it from login. Then delete the clone, and follow steps 4 to 7
above, with one difference: the from-source build's bundle id is `com.stacksjs.uplink.source`, so
that is the name to look for in System Settings.

`.env` holds your Claude Code token if you set one there rather than in the Keychain, so delete the
clone rather than leaving it around.

## Your licence

Uninstalling does not cancel a subscription. Manage it from **Manage** in the menubar before you
remove the app, or from the Stripe customer portal link in the email you got when you bought it.

A lifetime licence has nothing to cancel, and the key keeps working if you install Uplink again.
