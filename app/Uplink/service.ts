import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

/**
 * Installs Uplink as a login item that stays running: an `Uplink.app` bundle
 * (so Full Disk Access can be granted to it by name) and a launchd agent that
 * starts it at login and restarts it if it dies.
 */

export const LABEL = 'com.stacksjs.uplink'

export interface ServicePaths {
  appDir: string
  bundle: string
  executable: string
  plist: string
  log: string
}

export function servicePaths(appDir: string): ServicePaths {
  const bundle = join(appDir, 'storage', 'uplink', 'Uplink.app')
  return {
    appDir,
    bundle,
    executable: join(bundle, 'Contents', 'MacOS', 'Uplink'),
    plist: join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`),
    log: join(appDir, 'storage', 'logs', 'uplink.log'),
  }
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function infoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${LABEL}</string>
  <key>CFBundleName</key><string>Uplink</string>
  <key>CFBundleDisplayName</key><string>Uplink</string>
  <key>CFBundleExecutable</key><string>Uplink</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>LSBackgroundOnly</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>Uplink sends your replies through Messages.</string>
</dict>
</plist>
`
}

export function launchAgentPlist(paths: ServicePaths): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(paths.executable)}</string></array>
  <key>WorkingDirectory</key><string>${xml(paths.appDir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(paths.log)}</string>
  <key>StandardErrorPath</key><string>${xml(paths.log)}</string>
</dict>
</plist>
`
}

async function run(cmd: string[], options: { allowFailure?: boolean } = {}): Promise<{ code: number, output: string }> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const output = `${stdout}${stderr}`.trim()
  if (code !== 0 && !options.allowFailure)
    throw new Error(`${cmd.join(' ')} failed (${code}): ${output}`)
  return { code, output }
}

/** Compiles the launcher into a signed `Uplink.app`. */
export async function buildBundle(paths: ServicePaths): Promise<void> {
  rmSync(paths.bundle, { recursive: true, force: true })
  mkdirSync(join(paths.bundle, 'Contents', 'MacOS'), { recursive: true })
  await Bun.write(join(paths.bundle, 'Contents', 'Info.plist'), infoPlist())

  await run([
    process.execPath,
    'build',
    '--compile',
    join(paths.appDir, 'app', 'Uplink', 'launcher.ts'),
    '--outfile',
    paths.executable,
    '--define',
    `UPLINK_APP_DIR=${JSON.stringify(paths.appDir)}`,
    // A compiled binary reads bunfig.toml and .env from its cwd by default,
    // and launchd starts this one in the app directory - where bunfig's
    // preloads name packages the binary cannot resolve, so it died with
    // `preload not found "@stacksjs/env/plugin.js"` before running a line.
    // The watcher it spawns loads both itself, the normal way.
    '--no-compile-autoload-bunfig',
    '--no-compile-autoload-dotenv',
  ])

  // Ad-hoc signing gives the bundle a stable identity for TCC. Rebuilding
  // changes its hash, which is why install only rebuilds when asked.
  await run(['codesign', '--force', '--sign', '-', '--identifier', LABEL, paths.bundle])
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`
}

export async function install(paths: ServicePaths, options: { rebuild?: boolean } = {}): Promise<void> {
  if (options.rebuild || !existsSync(paths.executable))
    await buildBundle(paths)

  mkdirSync(join(paths.appDir, 'storage', 'logs'), { recursive: true })
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  await Bun.write(paths.plist, launchAgentPlist(paths))

  await run(['launchctl', 'bootout', `${domain()}/${LABEL}`], { allowFailure: true })
  await run(['launchctl', 'bootstrap', domain(), paths.plist])
}

export async function uninstall(paths: ServicePaths): Promise<void> {
  await run(['launchctl', 'bootout', `${domain()}/${LABEL}`], { allowFailure: true })
  rmSync(paths.plist, { force: true })
}

export async function restart(): Promise<void> {
  await run(['launchctl', 'kickstart', '-k', `${domain()}/${LABEL}`])
}

export async function serviceState(): Promise<{ loaded: boolean, pid: number | null, lastExit: string | null }> {
  const { code, output } = await run(['launchctl', 'print', `${domain()}/${LABEL}`], { allowFailure: true })
  if (code !== 0)
    return { loaded: false, pid: null, lastExit: null }
  const pid = output.match(/\bpid = (\d+)/)?.[1]
  const lastExit = output.match(/last exit code = ([^\n]+)/)?.[1]?.trim() ?? null
  return { loaded: true, pid: pid ? Number(pid) : null, lastExit }
}
