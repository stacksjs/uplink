#!/usr/bin/env bun
import process from 'node:process'
import { infoPlist } from '../../app/Uplink/service'
import pkg from '../../package.json'
import release from '../../resources/data/release.json'

/**
 * The version lives in package.json. Everything else derives it, and this says
 * so out loud in CI.
 *
 * It used to live in four places. Two of them drifted: the homepage advertised
 * 0.1.0 while the tree built 0.1.1, and the bundle `uplink:install` writes
 * reported 0.1.0 whatever it was built from. Nothing failed, because nothing
 * compared them (#29).
 *
 * `release.json` is written and committed by `buddy uplink:release`, so if this
 * fails the usual cause is a version bumped without a release. The homepage is
 * advertising the previous build until one happens, which is worth knowing.
 */

const problems: string[] = []

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0)
      return difference
  }
  return 0
}

// A package.json ahead of release.json is a version that has been bumped and
// not yet shipped as a DMG: the Mac App Store build is stamped from the same
// version and goes out first. That is worth saying, and not worth a red build.
// Behind, or any other disagreement, still fails: the homepage would be
// advertising something that does not exist.
const pending = release.version !== pkg.version && compareVersions(pkg.version, release.version) > 0
if (pending) {
  console.warn(`::warning::package.json is ${pkg.version} and the homepage still advertises ${release.version}. Run \`buddy uplink:release\` to publish the DMG.`)
}
else if (release.version !== pkg.version) {
  problems.push(
    `resources/data/release.json says ${release.version}, package.json says ${pkg.version}.`,
    '  The homepage download button reads release.json, so it is advertising a different build.',
    '  `buddy uplink:release` writes and commits that file: run a release, or put the version back.',
  )
}

if (!infoPlist().includes(`<string>${pkg.version}</string>`)) {
  problems.push(
    `The Info.plist in app/Uplink/service.ts does not carry ${pkg.version}.`,
    '  It should interpolate pkg.version rather than naming a version of its own.',
  )
}

if (problems.length > 0) {
  console.error('The app version is not consistent:\n')
  console.error(problems.join('\n'))
  process.exit(1)
}

console.log(pending
  ? `Version ${pkg.version} is ahead of release.json (${release.version}) and agrees with the Info.plist.`
  : `Version ${pkg.version} agrees across package.json, release.json and the Info.plist.`)
