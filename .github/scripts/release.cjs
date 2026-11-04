const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { sha256, validateResult } = require('./package.cjs')

async function prepare(assetsDirectory, reportsDirectory, { commit, channel }) {
  const reports = [...fs.globSync('*/result.json', { cwd: reportsDirectory })]
    .map(filename => JSON.parse(fs.readFileSync(path.join(reportsDirectory, filename), 'utf8')))
  assert.deepEqual(reports.map(report => report.release?.arch).sort(), ['arm64', 'x86_64'], 'Both macOS architectures are required')
  const { version, build_number: buildNumber } = reports[0].release
  assert.match(version, /^\d+\.\d+\.\d+$/, 'Expected a stable application version')
  assert.match(buildNumber, /^\d{12}$/, 'Expected a build timestamp')
  const assets = []
  for (const report of reports) {
    const dmg = validateResult(report, { commit, channel, arch: report.release.arch === 'x86_64' ? 'x64' : 'arm64' })
    assert.equal(report.release.version, version, 'Versions differ between architectures')
    assert.equal(report.release.build_number, buildNumber, 'Build numbers differ between architectures')
    const basename = path.basename(dmg.path)
    assert.match(basename, /^[A-Za-z0-9._-]+\.dmg$/, 'Unexpected installer filename')
    const filename = path.resolve(assetsDirectory, basename)
    assert.equal(fs.statSync(filename).size, dmg.size, 'Downloaded DMG size changed')
    assert.equal(await sha256(filename), dmg.sha256, 'Downloaded DMG digest changed')
    assert.equal(fs.readFileSync(`${filename}.sha256`, 'utf8'), `${dmg.sha256}  ${basename}\n`, 'Checksum file differs from build evidence')
    assets.push(filename, `${filename}.sha256`)
  }
  assert.equal(new Set(assets).size, 4, 'Installer filenames must differ between architectures')
  return {
    tag: channel === 'preview' ? `v${version}-preview.${buildNumber}` : `v${version}`,
    title: `ScholarSeed ${version}${channel === 'preview' ? ` Preview ${buildNumber}` : ''}`,
    prerelease: channel === 'preview',
    assets,
  }
}

async function publish(assetsDirectory, reportsDirectory, env = process.env) {
  const release = await prepare(assetsDirectory, reportsDirectory, { commit: env.GITHUB_SHA, channel: env.PACKAGE_CHANNEL })
  const gh = args => execFileSync('gh', args, { encoding: 'utf8', env })
  const refs = JSON.parse(gh(['api', `repos/${env.GITHUB_REPOSITORY}/git/matching-refs/tags/${release.tag}`]))
  assert.ok(!refs.some(ref => ref.ref === `refs/tags/${release.tag}`), `Tag ${release.tag} already exists; published versions must not be overwritten`)
  const notes = path.join(env.RUNNER_TEMP, 'release-notes.md')
  fs.writeFileSync(notes, [
    'The macOS installers are signed with Developer ID and notarized by Apple. DMG mounting and application launch checks have passed.',
    '',
    '- For Apple Silicon (M-series), download the `arm64` installer.',
    '- For Intel Macs, download the `x86_64` installer.',
    '- Download the matching `.dmg.sha256` file and run `shasum -a 256 -c <filename>.dmg.sha256` from the same directory.',
    '',
    `Source commit: ${env.GITHUB_SHA}`,
    `Build and verification reports: https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    '',
  ].join('\n'))
  const url = gh(['release', 'create', release.tag, ...release.assets,
    '--repo', env.GITHUB_REPOSITORY, '--target', env.GITHUB_SHA,
    '--title', release.title, '--notes-file', notes,
    ...(release.prerelease ? ['--prerelease', '--latest=false'] : []),
  ]).trim()
  console.log(url)
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `Download installers: [${release.title}](${url})\n`)
}

module.exports = { prepare, publish }
if (require.main === module) {
  publish(...process.argv.slice(2)).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
