const sourceDirectory = require('node:path').dirname(__dirname)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { execFileSync } = require('node:child_process')
const { developmentPython } = require('../../../../../scripts/shared/python.cjs')
const cache = require('../../shared/component-cache.cjs')
const { derivePythonContentId, sha256FileSync } = require('../../../runtime/components.cjs')
const REPO = path.resolve(sourceDirectory, '../../../..')

test('Python cache binds recipe sources and tools independently of build orchestration', t => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-recipe-')))
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}))
  for (const [file] of cache.recipe(REPO, {}).files) {
    const output = path.join(repo, file)
    fs.mkdirSync(path.dirname(output), {recursive: true})
    fs.copyFileSync(path.join(REPO, file), output)
  }
  const identity = (overrides = {}, tools = {uv: 'locked'}) => derivePythonContentId({
    target: 'win32-x86_64', pythonArchiveSha256: '1'.repeat(64), requirementsSha256: '2'.repeat(64),
    sourceBuilds: [], binaryPackages: ['cryptography'], bytecodeSha256: '4'.repeat(64),
    skillWheels: [{name: 'skill', sha256: '5'.repeat(64)}], recipe: cache.recipe(repo, tools), ...overrides})
  const original = identity()
  for (const file of ['apps/desktop/scripts/cd/bundle.cjs', 'apps/desktop/scripts/cd/go-cache.cjs', 'scripts/shared/permissions.cjs']) {
    fs.copyFileSync(path.join(REPO, file), path.join(repo, file))
    fs.appendFileSync(path.join(repo, file), '\n// changed build orchestration\n')
    assert.equal(identity(), original, file)
  }
  for (const [file] of cache.recipe(repo, {}).files) {
    const filename = path.join(repo, file), bytes = fs.readFileSync(filename)
    fs.appendFileSync(filename, '\n# changed recipe\n')
    assert.notEqual(identity(), original, file)
    fs.writeFileSync(filename, bytes)
  }
  assert.notEqual(identity({}, {uv: 'new'}), original)
  for (const field of ['target', 'pythonArchiveSha256', 'requirementsSha256'])
    assert.notEqual(identity({[field]: '6'.repeat(64)}), original, field)
  assert.notEqual(identity({sourceBuilds: [{name: 'fastcdc', sha256: '3'.repeat(64), buildConstraints: 'locked'}]}), original)
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

test('macOS launchers relocate and bytecode freezes after provisioning and before packaging', () => {
  const source = fs.readFileSync(path.join(sourceDirectory, 'build.cjs'), 'utf8')
  const provision = source.indexOf("await timedAsync('skills.build-provision-verify'")
  const relocate = source.indexOf("timed('python.relocate-launchers'")
  const freeze = source.indexOf("timed('python.bytecode-freeze'")
  const context = source.indexOf('verify.atomicJSON(context.file, context)', freeze)
  const builder = source.indexOf('if (args.stage !== \'backend\')', freeze)
  assert.ok(provision >= 0 && relocate > provision && freeze > relocate && context > freeze && builder > context)
})

test('macOS wheel launchers survive relocating the interpreter and refresh wheel records',
  { skip: process.platform !== 'darwin' }, () => {
    const python = process.env.TEST_PYTHON || developmentPython(REPO, process.env.VENV, { context: process.env.CI ? 'ci' : 'local' })
    execFileSync(python, ['-I', '-B', path.join(__dirname, 'launchers_test.py')])
  })


test('cold Python sync stages privately, replaces only after success and always cleans up', async t => {
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
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {module, process, __filename: filename, __dirname: sourceDirectory,
      require: name => name === 'node:child_process' ? {
        execFileSync: (executable, args) => args.includes('--version') ? 'uv 0.12.11' : JSON.stringify({
          python: '3.14.10', implementation: 'cpython', platform: 'win32', machine: 'AMD64',
          cacheTag: 'cpython-314', soabi: 'cp314-win_amd64', gilDisabled: 0}),
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
      await assert.rejects(invoke, /Python component step failed/)
      assert.ok(fs.existsSync(path.join(original, 'obsolete')))
      assert.ok(!fs.existsSync(path.join(original, 'installed')))
    } else {
      const result = await invoke()
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

test('source policy drift is rejected before installing and leaves the original tree intact', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-source-policy-')))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  const original = path.join(root, 'original')
  fs.mkdirSync(original)
  const python = path.join(original, 'python.exe')
  fs.writeFileSync(python, 'original interpreter')
  const requirements = path.join(root, 'requirements.txt')
  fs.writeFileSync(requirements, 'jieba==0.42.1 --hash=sha256:' + '0'.repeat(64))
  await assert.rejects(() => require('../assembly.cjs').stageSync('must-not-execute', python,
    requirements, root, {}, root, [{name: 'jieba', version: '0.42.1', sha256: 'a'.repeat(64)}]), /source build policy differs from runtime lock: jieba/)
  assert.equal(fs.readFileSync(python, 'utf8'), 'original interpreter')
  assert.deepEqual(fs.readdirSync(root).sort(), ['original', 'requirements.txt'])
})

test('source caches bind interpreter ABI, native target, compiler inputs and installer version', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-source-cache-')))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  const filename = path.join(sourceDirectory, 'assembly.cjs'), realRequire = createRequire(filename)
  const source = {name: 'fastcdc', version: '1.7.0', sha256: 'a'.repeat(64), buildConstraints: 'locked builder'}
  const requirements = path.join(root, 'requirements.txt')
  fs.writeFileSync(requirements, `fastcdc==1.7.0 --hash=sha256:${source.sha256}\n`)
  const interpreter = {python: '3.14.10', implementation: 'cpython', platform: 'darwin', machine: 'arm64',
    cacheTag: 'cpython-314', soabi: 'cpython-314-darwin', gilDisabled: 0}
  const caches = []
  const variants = [
    {},
    {python: '3.12.13', cacheTag: 'cpython-312', soabi: 'cpython-312-darwin'},
    {machine: 'x86_64'},
    {gilDisabled: 1, soabi: 'cpython-314t-darwin'},
    {environment: {MACOSX_DEPLOYMENT_TARGET: '14.0'}},
    {environment: {SDKROOT: '/other/sdk'}},
    {environment: {CFLAGS: '-march=native'}},
    {environment: {CXXFLAGS: '-fno-exceptions'}},
    {environment: {LDSHARED: 'clang -shared'}},
    {environment: {CL: '/DTEST_BUILD=1'}},
    {environment: {_CL_: '/DTEST_BUILD=2'}},
    {uv: 'uv 0.12.12'},
    {environment: {VCToolsVersion: '14.50'}},
    {environment: {SOURCE_DATE_EPOCH: '315532800'}},
    {environment: {UNRELATED_TOKEN: 'do-not-record'}}
  ]
  for (const [index, variant] of variants.entries()) {
    const module = {exports: {}}
    const {environment: overrides, uv, ...identity} = variant
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {module, process, __filename: filename, __dirname: sourceDirectory,
      require: name => name === 'node:child_process' ? {
        execFileSync: (executable, args) => args.includes('--version') ? uv || 'uv 0.12.11' : JSON.stringify({...interpreter, ...identity}),
        spawnSync: (executable, args) => { caches.push(args[args.indexOf('--cache-dir') + 1]); return {status: 0} }
      } : realRequire(name)}, {filename})
    const directory = path.join(root, `run-${index}`)
    fs.mkdirSync(directory)
    await module.exports.installSources('uv', 'candidate-python', requirements, directory, root,
      {SCHOLARSEED_BUILD_CACHE_ROOT: root, MACOSX_DEPLOYMENT_TARGET: '13.0', ...overrides}, [source])
  }
  assert.equal(new Set(caches.slice(0, -1)).size, variants.length - 1)
  assert.equal(caches[0], caches.at(-1))
  assert.doesNotMatch(fs.readFileSync(path.join(caches[0], 'source-policy.json'), 'utf8'), /do-not-record|UNRELATED_TOKEN/)
})

test('unverified source build tools fail before any install or cache publication', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-source-probe-')))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  const requirements = path.join(root, 'requirements.txt')
  const source = {name: 'fastcdc', version: '1.7.0', sha256: 'a'.repeat(64), buildConstraints: 'locked builder'}
  fs.writeFileSync(requirements, `fastcdc==1.7.0 --hash=sha256:${source.sha256}\n`)
  const filename = path.join(sourceDirectory, 'assembly.cjs'), realRequire = createRequire(filename)
  const interpreter = {python: '3.14.10', implementation: 'cpython', platform: 'darwin', machine: 'arm64',
    cacheTag: 'cpython-314', soabi: 'cpython-314-darwin', gilDisabled: 0}
  for (const [index, invalid] of [{python: 'unknown'}, {cacheTag: null}, {soabi: null}, {gilDisabled: 2}, {uv: 'unknown'}, {timeout: true}].entries()) {
    const module = {exports: {}}, directory = path.join(root, `run-${index}`)
    fs.mkdirSync(directory)
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {module, process, __filename: filename, __dirname: sourceDirectory,
      require: name => name === 'node:child_process' ? {
        execFileSync: (executable, args, options) => {
          assert.ok(options.timeout > 0)
          if (invalid.timeout) throw new Error('probe timed out')
          return args.includes('--version') ? invalid.uv || 'uv 0.12.11' : JSON.stringify({...interpreter, ...invalid})
        },
        spawnSync: () => assert.fail('unverified tools must not install')
      } : realRequire(name)}, {filename})
    await assert.rejects(() => module.exports.installSources('uv', 'candidate-python', requirements, directory, root,
      {SCHOLARSEED_BUILD_CACHE_ROOT: root}, [source]), /invalid source build|probe timed out/)
    assert.deepEqual(fs.readdirSync(directory), [])
    await module.exports.installSources('must-not-probe', 'must-not-probe', requirements, directory, root, {}, [])
  }
  assert.ok(!fs.existsSync(path.join(root, 'build')))
})

test('reviewed source repair checks native payloads before caching or hashed installation', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-wheel-repair-')))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  const filename = path.join(sourceDirectory, 'assembly.cjs'), realRequire = createRequire(filename)
  const source = {name: 'fastcdc', version: '1.7.0', sha256: 'a'.repeat(64), buildConstraints: 'locked', repairWheel: true}
  const requirements = path.join(root, 'requirements.txt')
  fs.writeFileSync(requirements, `fastcdc==1.7.0 --hash=sha256:${source.sha256}\n`)
  for (const failed of [false, true]) {
    const commands = [], module = {exports: {}}
    let builderRecipe = 'first'
    const cacheRoot = path.join(root, failed ? 'failure' : 'success')
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {module, process, __filename: filename, __dirname: sourceDirectory,
      require: name => name === '../../runtime/components.cjs' ? {...realRequire(name), sha256FileSync: file => file.endsWith('wheels.cjs') ? builderRecipe : realRequire(name).sha256FileSync(file)}
        : name === './wheels.cjs' ? {withBuilder: async (options, operation) => operation({python: 'locked-builder', builder: ['3.14.10', '26.2.1'], environment: {PIP_NO_INDEX: '1'}})}
        : name === 'node:child_process' ? {
          execFileSync: (executable, args) => args.includes('--version') ? 'uv 0.12.11' : JSON.stringify({python: '3.14.10', implementation: 'cpython', platform: 'darwin', machine: 'arm64', cacheTag: 'cpython-314', soabi: 'cpython-314-darwin', gilDisabled: 0}),
          spawnSync: (executable, args, options) => {
            commands.push({executable, args, options})
            if (args.includes('--wheel-dir')) {
              const output = args[args.indexOf('--wheel-dir') + 1]
              fs.mkdirSync(output, {recursive: true})
              const repaired = args.some(value => value.includes('delocate.cmd'))
              if (repaired && failed) return {status: 2}
              fs.writeFileSync(path.join(output, `fastcdc-1.7.0-cp314-cp314-macosx_${repaired ? '13' : '27'}_0_arm64.whl`), 'validated wheel')
            }
            return {status: 0}
          }
        } : realRequire(name)}, {filename})
    const directory = path.join(root, failed ? 'failed-inputs' : 'inputs')
    fs.mkdirSync(directory)
    const invoke = () => module.exports.installSources('uv', 'candidate', requirements, directory, root,
      {SCHOLARSEED_BUILD_CACHE_ROOT: cacheRoot}, [source])
    if (failed) {
      await assert.rejects(invoke, /Python component step failed/)
      assert.ok(!commands.some(command => command.args.includes('--no-index')))
      assert.deepEqual(fs.readdirSync(path.join(cacheRoot, 'build', 'source-wheels')), [])
    } else {
      await invoke()
      assert.ok(commands.some(command => command.args.some(value => value.includes('delocate.cmd'))))
      assert.ok(commands.some(command => command.args.includes('--no-build-isolation') && command.args.includes('--require-hashes')))
      const install = commands.at(-1)
      assert.ok(install.args.includes('--no-index') && install.args.includes('--require-hashes'))
      const locked = fs.readFileSync(install.args[install.args.indexOf('--requirement') + 1], 'utf8')
      assert.match(locked, /fastcdc==1\.7\.0 --hash=sha256:/)
      assert.ok(install.args.includes('--find-links'))
      const repeated = path.join(root, 'repeated-inputs')
      fs.mkdirSync(repeated)
      await module.exports.installSources('uv', 'candidate', requirements, repeated, root,
        {SCHOLARSEED_BUILD_CACHE_ROOT: cacheRoot}, [source])
      assert.equal(commands.filter(command => command.args.includes('--no-build-isolation')).length, 1)
      builderRecipe = 'changed'
      const changed = path.join(root, 'changed-builder-inputs')
      fs.mkdirSync(changed)
      await module.exports.installSources('uv', 'candidate', requirements, changed, root,
        {SCHOLARSEED_BUILD_CACHE_ROOT: cacheRoot}, [source])
      assert.equal(commands.filter(command => command.args.includes('--no-build-isolation')).length, 2)
    }
  }
})
