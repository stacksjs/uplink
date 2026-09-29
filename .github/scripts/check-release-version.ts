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

if (release.version !== pkg.version) {
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

console.log(`Version ${pkg.version} agrees across package.json, release.json and the Info.plist.`)
