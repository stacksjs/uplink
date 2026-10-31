import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { defineCommand } from '@stacksjs/cli'
import { craftBinary } from '../Desktop/craft'

// `buddy uplink:mas` - the sandboxed build for the Mac App Store and TestFlight.
// `buddy uplink:release` ships the Developer ID DMG; this is its sibling, and
// the two share a bundle id but not a sandbox, a signature or a container.
//
// The layout differs too. Under the sandbox a plain child process cannot become
// a GUI app, so Craft's public-API host (`craft-app-store`) is the bundle's main
// executable and the Uplink process is its sandbox-inheriting backend,
// `craft-backend`, started with `--serve --managed` (see app/Desktop/launcher.ts).

const BUNDLE_ID = 'com.stacksjs.uplink'

interface MasOptions {
  build: string
  local: boolean
  validate: boolean
  upload: boolean
}

export default defineCommand((cli) => {
  cli
    .command('uplink:mas', 'Build the sandboxed Mac App Store package, and optionally validate and upload it to TestFlight')
    .option('--build <number>', 'CFBundleVersion: the build number App Store Connect counts (must rise with every upload)', { default: '1' })
    .option('--local', 'Sign ad hoc and stop at an .app you can open on this Mac, to try the sandbox without a profile or a certificate', { default: false })
    .option('--validate', 'Run Apple\'s validation on the package (APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_ISSUER_ID)', { default: false })
    .option('--upload', 'Validate, then upload to App Store Connect, which makes it a TestFlight build once processed', { default: false })
    .action(async (options: MasOptions) => {
      const appDir = process.cwd()
      const version = (await Bun.file(`${appDir}/package.json`).json()).version as string
      const build = options.build
      if (!/^\d+$/.test(build))
        throw new Error(`--build must be a whole number, got "${build}".`)

      const step = (args: string[], env: Record<string, string> = {}): string => {
        console.log(`> ${args.join(' ')}`)
        const result = Bun.spawnSync(args, { cwd: appDir, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
        process.stdout.write(result.stdout)
        process.stderr.write(result.stderr)
        if (result.exitCode !== 0)
          process.exit(result.exitCode ?? 1)
        return result.stdout.toString()
      }

      const identity = process.env.UPLINK_MAS_APP_IDENTITY ?? 'Apple Distribution: Chris Breuer (3JJRNQW6B7)'
      const installer = process.env.UPLINK_MAS_INSTALLER_IDENTITY ?? '3rd Party Mac Developer Installer: Chris Breuer (3JJRNQW6B7)'
      const teamId = process.env.UPLINK_TEAM_ID ?? identity.match(/\(([A-Z0-9]{10})\)\s*$/)?.[1]
      if (!teamId)
        throw new Error('Cannot tell the Apple team from the signing identity. Set UPLINK_TEAM_ID.')

      const profile = options.local ? null : findProfile(`${teamId}.${BUNDLE_ID}`)
      if (!options.local && !profile) {
        console.error([
          `No Mac App Store provisioning profile for ${teamId}.${BUNDLE_ID} in ~/Library/MobileDevice/Provisioning Profiles.`,
          'Create one (App Store Connect, or the API) for the bundle id and your Apple Distribution certificate,',
          'or set UPLINK_MAS_PROFILE to its path. `--local` builds without one.',
        ].join('\n'))
        process.exit(1)
      }

      const out = `${appDir}/storage/framework/mas`
      rmSync(out, { recursive: true, force: true })
      mkdirSync(out, { recursive: true })

      // The framework assembles the bundle (launcher, icon, Info.plist) and this
      // takes its unsigned result, so what ships here is what ships as the DMG,
      // rearranged for the store.
      const craft = craftBinary(appDir)
      step(['./buddy', 'build:desktop'], { CRAFT_BIN: craft })
      step(['./buddy', 'build:dmg'], { DESKTOP_APP_NAME: 'Uplink', DESKTOP_BUNDLE_ID: BUNDLE_ID, DESKTOP_APP_VERSION: version })

      const app = `${out}/Uplink.app`
      const mount = mkdtempSync(join(tmpdir(), 'uplink-mas-'))
      const dmg = `${appDir}/storage/framework/desktop-dmg/Uplink-${version}.dmg`
      step(['hdiutil', 'attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg])
      try {
        step(['ditto', `${mount}/Uplink.app`, app])
      }
      finally {
        Bun.spawnSync(['hdiutil', 'detach', '-force', mount])
        rmSync(mount, { recursive: true, force: true })
      }
      step(['xattr', '-cr', app])

      const macos = `${app}/Contents/MacOS`
      // The Uplink process becomes the backend. The DMG's Craft runtime is the
      // direct-distribution one and does not run under the sandbox, so it goes.
      renameSync(`${macos}/Uplink`, `${macos}/craft-backend`)
      for (const name of readdirSync(macos).filter(name => name !== 'craft-backend'))
        rmSync(`${macos}/${name}`, { force: true })
      writeFileSync(`${app}/Contents/Resources/craft.json`, `${JSON.stringify({
        title: 'Uplink',
        appName: 'Uplink',
        width: 340,
        height: 420,
        // Not `trayPopover`: it hangs the page on a transparent material, which
        // Craft's public-API runtime (the only one the store accepts) does not
        // have. A status item with an ordinary window is what it can do.
        systemTray: true,
        hideDockIcon: true,
        keepRunning: true,
        resizable: false,
        backend: { executable: 'craft-backend' },
      }, null, 2)}\n`)

      // What the store wants of Info.plist beyond what the DMG needed.
      const plist = `${app}/Contents/Info.plist`
      const set = (key: string, type: string, value: string): void => {
        const edit = Bun.spawnSync(['/usr/libexec/PlistBuddy', '-c', `Set :${key} ${value}`, plist], { stderr: 'pipe' })
        if (edit.exitCode !== 0)
          step(['/usr/libexec/PlistBuddy', '-c', `Add :${key} ${type} ${value}`, plist])
      }
      set('CFBundleShortVersionString', 'string', version)
      set('CFBundleVersion', 'string', build)
      set('LSApplicationCategoryType', 'string', 'public.app-category.developer-tools')
      // The app makes HTTPS requests and nothing else cryptographic, which is
      // the exemption; without the key every upload stops to ask.
      set('ITSAppUsesNonExemptEncryption', 'bool', 'false')
      set('NSHumanReadableCopyright', 'string', '2026 Chris Breuer')
      copyFileSync(`${appDir}/app/Desktop/PrivacyInfo.xcprivacy`, `${app}/Contents/Resources/PrivacyInfo.xcprivacy`)

      const main = renderEntitlements(`${appDir}/app/Desktop/Entitlements.mas.plist`, teamId, options.local, out)
      const child = `${appDir}/app/Desktop/Entitlements.mas-child.plist`

      if (options.local) {
        // Craft's public-API host stands in as the main executable, and everything
        // is signed ad hoc so it can be opened here without a profile.
        const host = join(craft, '..', 'craft-app-store')
        if (!existsSync(host))
          throw new Error(`No craft-app-store beside ${craft}. Install craft-native.org 0.0.350 or later (deps.yml).`)
        copyFileSync(host, `${macos}/Uplink`)
        chmodSync(`${macos}/Uplink`, 0o755)
        step(['codesign', '--force', '--sign', '-', '--entitlements', child, `${macos}/craft-backend`])
        step(['codesign', '--force', '--sign', '-', '--entitlements', main, `${macos}/Uplink`])
        step(['codesign', '--force', '--sign', '-', '--entitlements', main, app])
        step(['codesign', '--verify', '--deep', '--strict', '--verbose=2', app])
        console.log(`Uplink ${version} (${build}): ${app}, signed ad hoc, sandboxed. Open it with: open ${app}`)
        process.exit(0)
      }

      // Craft does the store packaging: the host replaces the main executable,
      // everything nested is signed to inherit, the profile is embedded and
      // `productbuild` makes the package App Store Connect accepts.
      copyFileSync(`${macos}/craft-backend`, `${macos}/Uplink`)
      const { packageApp } = await import('craft-native')
      const results = await packageApp({
        name: 'Uplink',
        version,
        bundleId: BUNDLE_ID,
        binaryPath: `${macos}/craft-backend`,
        outDir: out,
        platforms: ['macos'],
        macos: {
          appBundlePath: app,
          nativeRuntimePath: craft,
          appStore: true,
          signIdentity: identity,
          installerIdentity: installer,
          provisioningProfile: profile!,
          buildNumber: build,
          category: 'public.app-category.developer-tools',
          minimumSystemVersion: '13.0',
          menuBarOnly: true,
          entitlements: main,
          helperEntitlements: child,
          privacyManifest: `${appDir}/app/Desktop/PrivacyInfo.xcprivacy`,
          urlSchemes: ['uplink'],
        },
      })
      for (const result of results) {
        if (!result.success)
          throw new Error(`${result.format}: ${result.error}`)
        console.log(`${result.format}: ${result.outputPath}`)
      }

      const pkg = results.map(result => result.outputPath).find((path): path is string => Boolean(path?.endsWith('.pkg')))
      if (!pkg)
        throw new Error('Craft produced no .pkg to upload.')
      step(['pkgutil', '--check-signature', pkg])

      if (options.validate || options.upload) {
        const keyId = process.env.APP_STORE_CONNECT_KEY_ID
        const issuer = process.env.APP_STORE_CONNECT_ISSUER_ID
        if (!keyId || !issuer) {
          console.error('Validation and upload need APP_STORE_CONNECT_KEY_ID and APP_STORE_CONNECT_ISSUER_ID, with the key at ~/.appstoreconnect/private_keys/AuthKey_<id>.p8.')
          process.exit(1)
        }
        const altool = (verb: '--validate-app' | '--upload-app'): void =>
          void step(['xcrun', 'altool', verb, '--type', 'osx', '--file', pkg, '--apiKey', keyId, '--apiIssuer', issuer])
        altool('--validate-app')
        if (options.upload) {
          altool('--upload-app')
          console.log(`Uploaded Uplink ${version} (${build}). It appears in TestFlight once App Store Connect has processed it.`)
        }
      }
      process.exit(0)
    })
})

/** The entitlements with this team's id filled in, written next to the build. */
function renderEntitlements(template: string, teamId: string, local: boolean, out: string): string {
  let xml = readFileSync(template, 'utf8').replaceAll('TEAM_ID', teamId)
  if (local) {
    // Only a provisioning profile can vouch for these, and an ad hoc build has
    // none: macOS would kill it at launch for claiming them.
    xml = xml.replace(/\s*<key>com\.apple\.(application-identifier|developer\.team-identifier)<\/key>\s*<string>[^<]*<\/string>/g, '')
  }
  const path = `${out}/Entitlements.rendered.plist`
  writeFileSync(path, xml)
  return path
}

/**
 * A Mac App Store profile for this application identifier: UPLINK_MAS_PROFILE,
 * else the newest unexpired one Xcode and the developer portal have left in
 * the usual folder.
 */
function findProfile(applicationIdentifier: string): string | null {
  const given = process.env.UPLINK_MAS_PROFILE
  if (given)
    return existsSync(given) ? given : null

  const dir = join(homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles')
  if (!existsSync(dir))
    return null

  const matches = readdirSync(dir)
    .filter(name => name.endsWith('.provisionprofile'))
    .map(name => join(dir, name))
    .filter((path) => {
      const decoded = Bun.spawnSync(['security', 'cms', '-D', '-i', path], { stderr: 'ignore' })
      if (decoded.exitCode !== 0)
        return false
      const read = (key: string): string => {
        const value = Bun.spawnSync(['plutil', '-extract', key, 'raw', '-o', '-', '-'], { stdin: decoded.stdout, stderr: 'ignore' })
        return value.exitCode === 0 ? value.stdout.toString().trim() : ''
      }
      // A store profile has no device list and names its application.
      return read('Entitlements.com\\.apple\\.application-identifier') === applicationIdentifier
        && read('ProvisionedDevices') === ''
        && new Date(read('ExpirationDate')).getTime() > Date.now()
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

  return matches[0] ?? null
}
