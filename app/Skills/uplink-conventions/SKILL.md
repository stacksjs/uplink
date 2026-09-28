---
name: uplink-conventions
description: Use when adding or changing any Uplink subsystem - config, engines, the daemon, the menubar app. Covers where config belongs and how it actually loads, when auto-imports work and when they silently do not, and the framework-free constraint the downloadable app imposes. Read before writing code under app/Uplink/, app/Desktop/ or config/.
license: MIT
compatibility: Bun >= 1.3.0, TypeScript, macOS 13+
allowed-tools: Read Edit Write Bash Grep Glob
---

# Uplink Conventions

Uplink grew its own parallel conventions: a bespoke `UPLINK_*` environment reader outside `config/`,
and an app that lives in `app/Uplink/` rather than the framework's directories. Use the framework's
way instead.

Two of the obvious corrections fail **silently**. That is what this skill is for.

## Key Paths

- The daemon and the app: `app/Uplink/`
- The compiled menubar binary's entry: `app/Desktop/launcher.ts`
- Config directory: `config/`
- The framework's config override list: `node_modules/@stacksjs/config/dist/overrides.js`
  (source: `storage/framework/core/config/src/overrides.ts`)
- Auto-import injection: `node_modules/@stacksjs/server/dist/imports.js`

## The constraint everything else follows from

Uplink ships two ways, and only one of them has a framework.

1. **From source**, `buddy uplink:watch`, a launchd service inside the Stacks app.
2. **The downloadable Uplink.app**, compiled with `bun build --compile` from
   `app/Desktop/launcher.ts`. No `.env`, no Stacks runtime, no database. It reads `settings.json`
   plus the Keychain and calls `loadConfig(settingsEnv(settings))`.

```bash
grep -rn "@stacksjs" app/Uplink/*.ts app/Desktop/*.ts
```

One hit, and it is a comment. Keep it that way. Anything that pulls `@stacksjs/*` into a module the
compiled app imports pulls the framework into the binary.

## Config: `config/uplink.ts` is not loaded by `@stacksjs/config`

Putting a file in `config/` is right. Expecting `config.uplink` to appear is wrong.

`@stacksjs/config` does not scan the directory. It walks a hardcoded list of about 46
`[key, filename]` pairs, and `uplink` is not one of them, nor should it be: that list is the
framework's own surface.

```bash
grep -c uplink node_modules/@stacksjs/config/dist/overrides.js   # 0
```

So `config.uplink` is `undefined`, and the usual `if (config.uplink?.pollMs)` reads as "not
configured" rather than failing. Nothing throws. Nothing logs.

**Use bunfig**, which is how stx loads its own config:

```typescript
import { loadConfig } from 'bunfig'

const config = await loadConfig({
  name: 'uplink',          // finds config/uplink.ts by name
  defaultConfig,           // required; always returns at least this
  checkEnv: true,          // derives UPLINK_* from the key names
})
```

Its default config directory is `resolve(process.cwd(), 'config')`, so the name alone finds the
file, and it always returns at least the defaults.

### `checkEnv` already matches every variable Uplink documents

bunfig builds the variable name from the config key: the prefix is `name.toUpperCase()` with dashes
turned into underscores, and each key is split on capitals,
`k.replace(/([A-Z])/g, '_$1').toUpperCase()`.

| Config key | Derived variable |
|---|---|
| `pollMs` | `UPLINK_POLL_MS` |
| `maxChars` | `UPLINK_MAX_CHARS` |
| `ackAfterMs` | `UPLINK_ACK_AFTER_MS` |
| `messagesDb` | `UPLINK_MESSAGES_DB` |
| `claudeBin` | `UPLINK_CLAUDE_BIN` |
| `codexPermission` | `UPLINK_CODEX_PERMISSION` |

All seventeen of Uplink's current `UPLINK_*` names are exactly what `checkEnv` generates, so the
hand-rolled `int()` and `str()` readers in `app/Uplink/config.ts` can go without renaming anything
in `.env.example`.

Two do not fit the pattern and stay hand-handled: `UPLINK_MODEL`, the legacy alias for
`UPLINK_CLAUDE_MODEL`, and `CLAUDE_CODE_OAUTH_TOKEN`, which is not an Uplink variable at all.

### Two things that do not belong in a config file

- **Values discovered at runtime.** `findClaude()` and `findCodex()` probe the filesystem for a
  binary. A static config file cannot hold that. The config file holds an optional override,
  `claudeBin`, and the probe stays in code, used when the override is empty.
- **Anything the compiled app cannot reach.** `bunfig` is a runtime import, and it arrives through
  `better-dx`, a devDependency. Promote it to a real dependency before importing it at runtime, per
  the AGENTS.md rule that a package importing something at runtime declares it as a real dependency.

## Auto-imports: a declaration is not an injection

`resources/functions/` is the right destination for genuinely shared code, and class exports such as
`CodexEngine` work there. But a name appearing in `server-auto-imports.d.ts` only means `tsc`
accepts it.

The globals exist only after `injectGlobalAutoImports()` runs, and that happens at **server boot**,
in `buddy serve` and `production-server.ts`. Uplink's engine runs in a launchd service and in
`app/Commands/Uplink.ts`, which do not necessarily take that path. A bare `CodexEngine(...)` there
typechecks and then throws `ReferenceError` at runtime.

This is not hypothetical. It is stacksjs/stacks#2585, and AGENTS.md documents the same class of
failure for the browser manifest.

**So: keep explicit imports in service code.** That is not a compromise. The framework's own actions
and models import what they use.

### Verification that actually proves it

The first two steps pass even when it is broken, which is why all three are needed:

```bash
buddy generate                                    # 1. regenerate
grep CodexEngine storage/framework/types/server-auto-imports.d.ts   # 2. declared
```

```bash
# 3. the only one that proves injection, run inside the service process
bun -e 'console.log(typeof globalThis.CodexEngine)'
```

Step 3 printing `undefined` while step 2 passes is exactly the failure this section exists to
prevent.

### What not to move

`messages-db.ts`, `typedstream.ts` and the sqlite plumbing stay where they are. They are internals
with one caller each. Making them global costs namespace and gains nothing.

Weigh any move the same way: auto-import buys something for stx templates, routes and actions. For a
module that is only ever imported by other TypeScript, it buys nothing.

## Before you finish

- `./buddy lint` and `./buddy typecheck`.
- `./pantry/.bin/bun test tests/unit/uplink` using the pinned toolchain. The repo pins Bun 1.4.2 in
  `pantry.lock`; a different Bun can hang on the tests that spawn a subprocess and read its stdout.
- If you touched anything the compiled app imports, re-check the grep at the top of this file.
