# Permissions

Uplink asks macOS for two things. Both are granted to a specific app rather than to Uplink in
general, which is the part that surprises people.

## Full Disk Access, to read Messages

Messages keeps your texts in a SQLite database at `~/Library/Messages/chat.db`, which macOS
protects. Reading it needs Full Disk Access.

**The grant is keyed to a bundle id and the exact binary inside it.** That has two consequences:

- The downloaded app (`com.stacksjs.uplink`) and the from-source build
  (`com.stacksjs.uplink.source`) are different subjects. Granting one does not grant the other,
  which is deliberate: they are separate installs.
- Rebuilding the from-source bundle replaces the binary, which voids the grant. `uplink:install
  --rebuild` will tell you to grant it again.

Uplink only ever reads that database. It never writes to it.

## Control of Messages, to reply

Replies are sent through AppleScript, so macOS asks once whether Uplink may control Messages. This
is the Automation permission, and it is asked the first time a reply is actually sent rather than
at setup, which is why a first install can look finished and then fail on the first text.

Uplink now asks for it during setup for that reason. If you denied it, it is in System Settings
under Privacy & Security, Automation, and Uplink needs the Messages row ticked.

## What happens if one is missing

Neither failure is silent any more.

- Without Full Disk Access, the menubar says it is waiting for it and the service keeps running
  rather than restart-looping.
- Without Automation, a run completes and the reply cannot be delivered, so the run is recorded as
  failed and the menubar shows why. It is not recorded as done.

`./buddy uplink:doctor` checks both from a clone. The menubar's setup list checks both in the app.

## What Uplink does not ask for

No Accessibility, no Screen Recording, no Location, no contacts. The two above are the whole list.
