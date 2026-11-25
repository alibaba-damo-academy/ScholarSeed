const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { developmentPython } = require('../../../../scripts/shared/python.cjs')
const state = require('../shared/build-state.cjs')
const { target } = require('../shared/target.cjs')
const { createRuntimeSigningPolicy } = require('./mac-sign-policy.cjs')
const { signedRuntimeStore } = require('./mac-sign-store.cjs')

const HELPER = path.join(__dirname, 'signed_runtime.py')

async function withSignedRuntimes(options, frozen, baseIgnore, sign) {
  const root = process.env.SCHOLARSEED_MAC_SIGN_CACHE
  if (frozen.platform !== 'darwin' || frozen.lane !== 'distribution' || !frozen.signingRequired)
    return sign(baseIgnore)

  const command = process.env.SCHOLARSEED_MAC_SIGN_REGISTRY_COMMAND
  if (!root) {
    if (command !== undefined) throw new Error('macOS signing registry requires a local cache directory')
    return sign(baseIgnore)
  }
  const cacheTarget = target(frozen.platform, frozen.arch).archType
  const policy = createRuntimeSigningPolicy(options, frozen)
  // Use the build interpreter throughout. Restoring the bundled interpreter is
  // one of the cache operations, so it cannot be the verifier of that operation.
  const python = developmentPython(frozen.repo, process.env.VENV)
  const work = fs.mkdtempSync(path.join(frozen.runDirectory, 'signed-runtimes-'))
  const plan = path.join(work, 'plan.json')
  const content = (operation, ...args) => execFileSync(python, ['-I', '-S', '-B', HELPER,
    operation, options.app, plan, ...args], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024})
  try {
    const groups = JSON.parse(content('plan'))
    const recipe = state.hashFile(HELPER)
    const hits = new Set()
    const misses = []
    for (const [kind, group] of Object.entries(groups)) {
      // ShipIt and Squirrel are rebuilt from branch-specific sources. Keep the
      // updater frameworks in the regular signing pass.
      if (kind === 'frameworks') continue
      const targets = [...group.files, ...group.bundles].map(relative => path.join(options.app, relative))
      const selected = targets.some(baseIgnore) ? null : policy.forGroup(group)
      if (!selected) {
        console.log(`[sign-cache] ${kind} uses the normal signing policy`)
        continue
      }
      const store = signedRuntimeStore(root, command, kind, cacheTarget)
      const key = state.identity({schema: 2, kind, target: cacheTarget, appId: frozen.appId,
        input: group.inputSha256, policy: selected.digest, recipe})
      const restore = archive => {
        content('restore', kind, archive)
        selected.verify()
      }
      const temporary = path.join(work, key + '.download')
      const hit = store.lookup(key, temporary, restore)
      console.log(`[sign-cache] ${kind} ${hit || 'miss'} key=${key} machO=${group.files.length}`)
      if (hit) {
        for (const target of targets) hits.add(fs.realpathSync(target))
      } else {
        misses.push({kind, key, store, selected, restore, temporary})
      }
    }
    await sign(filename => baseIgnore(filename) || (hits.size > 0 && hits.has(fs.realpathSync(filename))))
    let reseal = false
    for (const {kind, key, store, selected, restore, temporary} of misses) {
      selected.verify()
      const archive = path.join(work, key + '.zip')
      content('pack', kind, archive)
      if (store.publish(key, archive, temporary, restore)) {
        console.log(`[sign-cache] ${kind} restored concurrent winner key=${key}`)
        reseal = true
      }
    }
    // Different valid timestamps can win a concurrent first publication.
    // Rebind the outer resource envelope after restoring the canonical bytes.
    if (reseal) await sign(filename => path.resolve(filename) !== path.resolve(options.app))
  } finally {
    fs.rmSync(work, {recursive: true, force: true})
  }
}

module.exports = {withSignedRuntimes}
