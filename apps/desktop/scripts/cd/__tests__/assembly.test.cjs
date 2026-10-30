const sourceDirectory = require('node:path').dirname(__dirname)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const cache = require('../../shared/component-cache.cjs')
const { derivePythonContentId, sha256FileSync } = require('../../../runtime/components.cjs')
const REPO = path.resolve(sourceDirectory, '../../../..')

test('Python cache ignores bundle orchestration but binds every actual recipe source and tool', t => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-recipe-')))
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}))
  for (const [file] of cache.recipe(REPO, {}).files) {
    const output = path.join(repo, file)
    fs.mkdirSync(path.dirname(output), {recursive: true})
    fs.copyFileSync(path.join(REPO, file), output)
  }
  const identity = (overrides = {}, tools = {uv: 'locked'}) => derivePythonContentId({
    target: 'win32-x86_64', pythonArchiveSha256: '1'.repeat(64), requirementsSha256: '2'.repeat(64),
    lockSha256: '3'.repeat(64), binaryPackages: ['cryptography'], bytecodeSha256: '4'.repeat(64),
    skillWheels: [{name: 'skill', sha256: '5'.repeat(64)}], recipe: cache.recipe(repo, tools), ...overrides})
  const original = identity()
  fs.writeFileSync(path.join(repo, 'apps/desktop/scripts/cd/bundle.cjs'), '// unrelated Office/installer orchestration\n')
  assert.equal(identity(), original)
  for (const [file] of cache.recipe(repo, {}).files) {
    const filename = path.join(repo, file), bytes = fs.readFileSync(filename)
    fs.appendFileSync(filename, '\n# changed recipe\n')
    assert.notEqual(identity(), original, file)
    fs.writeFileSync(filename, bytes)
  }
  assert.notEqual(identity({}, {uv: 'new'}), original)
  for (const field of ['target', 'pythonArchiveSha256', 'requirementsSha256', 'lockSha256'])
    assert.notEqual(identity({[field]: '6'.repeat(64)}), original, field)
  assert.notEqual(identity({skillWheels: [{name: 'skill', sha256: '7'.repeat(64)}]}), original)
})

test('Windows Python finalization preserves locked tools, normalization, bytecode and record order', () => {
  const filename = path.join(sourceDirectory, 'assembly.cjs'), module = {exports: {}}
  const commands = [], realRequire = createRequire(filename)
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {module, __dirname: sourceDirectory, require: name =>
    name === 'node:child_process' ? {
      spawnSync: (file, args, options) => { commands.push({file, args: [...args], options}); return {status: 0} },
      execFileSync: (file, args) => { commands.push({file, args: [...args]}); return JSON.stringify({sources: 7}) }
    } : realRequire(name)}, {filename})
  const assembly = module.exports
  assembly.synchronize('uv', 'python', 'requirements.txt', 'wheels', {})
  assert.ok(commands[0].args.includes('--require-hashes'))
  assert.ok(commands[0].args.includes('--no-sources'))
  assert.ok(commands[0].args.includes('--no-build'))
  assert.ok(!commands[0].args.includes('--only-binary')) // uv 0.12.11 rejects mixing it with --no-build
  commands.length = 0
  const inputs = {repo: REPO, runDirectory: 'run', backend: 'backend', python: 'python', installation: {directory: 'short-install-root'}, plan: {
    uv: 'uv', dependencyPlan: 'plan.json', bytecodeSha256: sha256FileSync(assembly.BYTECODE_COMPILER)}}
  const result = assembly.finalize(inputs, {})
  assert.equal(result.sources, 7)
  assert.deepEqual(commands.map(command => command.args[0]), ['export', 'venv', 'pip', '-I', '-I', '-I'])
  assert.ok(commands[0].args.includes('--locked'))
  assert.ok(commands[2].args.includes('--require-hashes'))
  assert.ok(commands[3].args.includes(path.join(sourceDirectory, 'normalize.py')))
  assert.ok(commands[4].args.includes(assembly.BYTECODE_COMPILER))
  assert.ok(commands[5].args.includes('--records-only'))
  assert.equal(commands[5].args.filter(arg => arg === '--forbid-prefix').length, 3)
  assert.ok(commands[5].args.includes('short-install-root'))
  commands.length = 0
  assert.equal(assembly.finalize({...inputs, cached: {evidence: {bytecode: result}}}, {}).sources, 7)
  assert.equal(commands.length, 0)
})

test('bytecode freeze and read-only inspection bind the same compiler and isolated interpreter', () => {
  const filename = path.join(sourceDirectory, 'assembly.cjs'), module = {exports: {}}
  const commands = [], realRequire = createRequire(filename)
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {module, __dirname: sourceDirectory, require: name =>
    name === 'node:child_process' ? {
      execFileSync: (file, args) => { commands.push({file, args: [...args]}); return JSON.stringify({sources: 1, inventory_sha256: 'inventory'}) }
    } : realRequire(name)}, {filename})
  const assembly = module.exports
  const inputs = {backend: 'backend', python: 'packaged-python'}
  const frozen = assembly.freezeBytecode(inputs, {})
  const inspected = assembly.inspectBytecode({...inputs, compilerSha256: frozen.compiler_sha256, check: false}, {})
  assert.deepEqual(frozen, inspected)
  assert.equal(commands[0].file, 'packaged-python')
  assert.deepEqual(commands[0].args.slice(0, 2), ['-I', '-B'])
  assert.ok(!commands[0].args.includes('--check'))
  assert.equal(commands[1].args.at(-1), '--check')
  assert.throws(() => assembly.freezeBytecode({...inputs, compilerSha256: 'wrong'}, {}), /compiler changed/)
  assert.throws(() => assembly.inspectBytecode({...inputs, compilerSha256: 'wrong'}, {}), /compiler changed/)
  assert.equal(commands.length, 2)
})

test('both bytecode operations reject a compiler changed during execution', () => {
  const filename = path.join(sourceDirectory, 'assembly.cjs'), realRequire = createRequire(filename)
  for (const operation of ['freezeBytecode', 'inspectBytecode']) {
    const module = {exports: {}}
    let changed = false
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {module, __dirname: sourceDirectory, require: name =>
      name === 'node:child_process' ? {
        execFileSync: () => { changed = true; return JSON.stringify({sources: 1}) }
      } : name === '../../runtime/components.cjs' ? {
        sha256FileSync: () => changed ? 'changed' : 'original'
      } : realRequire(name)}, {filename})
    assert.throws(() => module.exports[operation]({backend: 'backend', python: 'python', compilerSha256: 'original'}, {}), /changed during execution/)
  }
})

test('packaged verification imports only the read-only bytecode operation', () => {
  const source = fs.readFileSync(path.join(sourceDirectory, 'verify.cjs'), 'utf8')
  assert.match(source, /const \{ inspectBytecode \} = require\('\.\/assembly\.cjs'\)/)
  assert.match(source, /const observedBytecode = inspectBytecode\(/)
  assert.doesNotMatch(source, /freezeBytecode/)
})

test('macOS bytecode freezes after skill provisioning and before context and packaging', () => {
  const source = fs.readFileSync(path.join(sourceDirectory, 'build.cjs'), 'utf8')
  const provision = source.indexOf("await timedAsync('skills.build-provision-verify'")
  const freeze = source.indexOf("timed('python.bytecode-freeze'")
  const context = source.indexOf('verify.atomicJSON(context.file, context)', freeze)
  const builder = source.indexOf('if (args.stage !== \'backend\')', freeze)
  assert.ok(provision >= 0 && freeze > provision && context > freeze && builder > context)
})


test('cold Python sync stages privately, replaces only after success and always cleans up', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-sync-')))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  for (const fail of [false, true]) {
    const original = path.join(root, fail ? 'failure' : 'success', 'python')
    fs.mkdirSync(original, {recursive: true})
    fs.writeFileSync(path.join(original, 'python.exe'), 'interpreter')
    fs.writeFileSync(path.join(original, 'obsolete'), 'old')
    const filename = path.join(sourceDirectory, 'assembly.cjs'), realRequire = createRequire(filename)
    const module = {exports: {}}, calls = []
    let staged
    const policy = ['first', 'second'].map((name, index) => ({name, version: '1.0', sha256: 'a'.repeat(64), buildConstraints: `fixture-builder==${index + 1}.0 --hash=sha256:${String(index + 1).repeat(64)}\n`}))
    const requirements = path.join(root, `${fail}-locked.txt`)
    fs.writeFileSync(requirements, policy.map(source => `${source.name}==${source.version} \\\n    --hash=sha256:${source.sha256}`).join('\n'))
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {module, process, __dirname: sourceDirectory,
      require: name => name === 'node:child_process' ? {
        spawnSync: (file, args, options) => {
          calls.push({file, args, options, constraints: args.includes('--build-constraints')
            ? fs.readFileSync(args[args.indexOf('--build-constraints') + 1], 'utf8') : null})
          staged = path.dirname(args[args.indexOf('--python') + 1])
          assert.notEqual(staged, original)
          assert.equal(fs.readFileSync(path.join(staged, 'python.exe'), 'utf8'), 'interpreter')
          fs.rmSync(path.join(staged, 'obsolete'), {force: true})
          fs.writeFileSync(path.join(staged, 'installed'), 'verified wheel bytes')
          return {status: fail ? 2 : 0}
        }
      } : realRequire(name)}, {filename})
    const invoke = () => module.exports.stageSync('uv', path.join(original, 'python.exe'),
      requirements, 'wheel-root', {UV_LINK_MODE: 'copy', SCHOLARSEED_BUILD_CACHE_ROOT: root}, root, policy)
    if (fail) {
      assert.throws(invoke, /Python component step failed/)
      assert.ok(fs.existsSync(path.join(original, 'obsolete')))
      assert.ok(!fs.existsSync(path.join(original, 'installed')))
    } else {
      const result = invoke()
      assert.equal(calls.length, policy.length + 1)
      assert.ok(calls.at(-1).args.includes('--no-build'))
      assert.deepEqual(calls.slice(0, -1).map(call => call.constraints), policy.map(source => source.buildConstraints))
      assert.notEqual(calls[0].args[calls[0].args.indexOf('--cache-dir') + 1], calls[1].args[calls[1].args.indexOf('--cache-dir') + 1])
      assert.equal(result.directory, path.dirname(staged))
      assert.equal(fs.readFileSync(path.join(original, 'installed'), 'utf8'), 'verified wheel bytes')
      assert.ok(!fs.existsSync(path.join(original, 'obsolete')))
    }
    assert.ok(!fs.existsSync(path.dirname(staged)))
    assert.equal(calls[0].options.env.UV_LINK_MODE, 'copy')
    assert.ok(calls[0].args.includes('--require-hashes'))
    assert.ok(calls[0].args.includes('--no-sources'))
  }
})

test('source policy drift is rejected before installing and leaves the original tree intact', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-source-policy-')))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  const original = path.join(root, 'original')
  fs.mkdirSync(original)
  const python = path.join(original, 'python.exe')
  fs.writeFileSync(python, 'original interpreter')
  const requirements = path.join(root, 'requirements.txt')
  fs.writeFileSync(requirements, 'jieba==0.42.1 --hash=sha256:' + '0'.repeat(64))
  assert.throws(() => require('../assembly.cjs').stageSync('must-not-execute', python,
    requirements, root, {}, root, [{name: 'jieba', version: '0.42.1', sha256: 'a'.repeat(64)}]), /source build policy differs from runtime lock: jieba/)
  assert.equal(fs.readFileSync(python, 'utf8'), 'original interpreter')
  assert.deepEqual(fs.readdirSync(root).sort(), ['original', 'requirements.txt'])
})
