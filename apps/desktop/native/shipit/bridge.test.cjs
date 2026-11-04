const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const test = require('node:test')
const { observeSpawn } = require('../observations.cjs')
const policy = require('../toolchain.json')

assert.equal(process.platform, 'darwin')
assert.equal(process.versions.node, policy.node)
const library = process.env.SCHOLARSEED_TERMINAL_LIBRARY
const leaseLibrary = process.env.SCHOLARSEED_LEASE_LIBRARY
assert.ok(library && path.isAbsolute(library), 'select the compiled terminal observation addon')
assert.ok(leaseLibrary && path.isAbsolute(leaseLibrary), 'select the canonical lease addon')
const api = require(library)
const lease = require(leaseLibrary)
const CHILD_TIMEOUT = 20_000

function acquire(api, config, observations = 0) {
  const errno = require('node:os').constants.errno
  const attempts = 5
  for (let attempt = 1; ; attempt++) {
    let holder
    try {
      holder = api.open(config)
      if (!observations) return holder
      const snapshots = []
      for (let observed = 0; observed < observations; observed++)
        snapshots.push(JSON.parse(holder.observe()))
      return { holder, snapshots }
    } catch (error) {
      if (holder) holder.close()
      if (
        attempt === attempts ||
        error.code !== 'ERR_TERMINAL_OBSERVATION' ||
        ![errno.EAGAIN, errno.ESTALE].includes(error.systemCode)
      )
        throw error
    }
  }
}

function plist(value) {
  const escape = (text) =>
    String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const encode = (item) => {
    if (typeof item === 'boolean') return item ? '<true/>' : '<false/>'
    if (typeof item === 'number') return `<integer>${item}</integer>`
    if (typeof item === 'string') return `<string>${escape(item)}</string>`
    return `<dict>${Object.entries(item)
      .map(([key, entry]) => `<key>${escape(key)}</key>${encode(entry)}`)
      .join('')}</dict>`
  }
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0">${encode(value)}</plist>`
}

function fixture(context, { publication = false, retainOnFailure = false } = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'terminal-bridge-'))
  let completed = !retainOnFailure
  const directory = (name) => {
    const result = path.join(base, name)
    fs.mkdirSync(result, { recursive: true, mode: 0o700 })
    return result
  }
  const identity = (filename) => {
    const info = fs.statSync(filename)
    return { dev: info.dev, ino: info.ino, uid: info.uid }
  }
  const capture = (filename, contents = true) => ({
    path: filename,
    parent: identity(path.dirname(filename)),
    item: identity(filename),
    ...(contents ? { contents: identity(path.join(filename, 'Contents')) } : {}),
  })
  const bundle = (name) => {
    directory(path.join(name, 'Contents'))
    return path.join(base, name)
  }
  const cleanup = directory('cleanup'),
    preparation = directory('preparation')
  for (const owner of [cleanup, preparation])
    fs.writeFileSync(path.join(owner, 'lock'), '', { mode: 0o600 })
  const source = bundle('update/source.app'),
    target = bundle('target.app')
  const candidateDirectory = directory('shipit-candidate.fixture')
  const candidate = bundle('shipit-candidate.fixture/source.app')
  const binding = {
    schema: 1,
    requestId: 'a'.repeat(64),
    candidate: 'candidate',
    sha512: 'b'.repeat(128),
    size: 100,
  }
  const journal = path.join(preparation, 'journal.plist')
  const record = {
    source: capture(source),
    target: capture(target),
    directory: capture(candidateDirectory, false),
    candidate: capture(candidate),
    state: 'ready',
    attempts: 1,
    binding,
    failure: { code: 60, target: capture(target) },
  }
  if (publication) {
    record.terminalVersion = '1'
    record.failure.publication = {
      schema: '1',
      source: record.source,
      target: record.target,
      failureTarget: record.failure.target,
      binding,
      code: 60,
      candidate: record.candidate,
      directory: record.directory,
    }
  }
  fs.writeFileSync(
    journal,
    plist({
      schema: '1',
      record,
    }),
    { mode: 0o600 }
  )
  const ack = path.join(path.dirname(source), '.scholarseed-prepare.plist')
  fs.writeFileSync(
    ack,
    plist({
      schema: 1,
      source: capture(source, false),
      target: capture(target, false),
      binding,
      ready: false,
      code: 60,
    }),
    { mode: 0o600 }
  )
  const state = path.join(base, 'state.json')
  fs.writeFileSync(
    state,
    JSON.stringify({
      binding,
      updateBundleURL: pathToFileURL(source).href,
      targetBundleURL: pathToFileURL(target).href,
      bundleIdentifier: 'com.fixture.desktop',
      useUpdateBundleName: true,
      installationAuthorized: false,
      launchAfterInstallation: true,
    }),
    { mode: 0o600 }
  )
  const roots = ['home', 'data', 'workspace'].map(directory)
  const identities = roots.map((root) => {
    const pin = lease.pin(root, false)
    try {
      return lease.identity(pin)
    } finally {
      lease.release(pin)
    }
  })
  const config = {
    schema: 1,
    cleanup,
    preparation,
    source,
    target,
    state,
    binding,
    selection: { schema: 1, paths: roots, identities },
  }
  context.after(() => {
    if (completed) fs.rmSync(base, { recursive: true, force: true })
    else process.stderr.write(`fixture evidence retained: ${base}\n`)
  })
  return { config, journal, ack, state, candidateDirectory, complete: () => { completed = true } }
}

function verifiedHeaders(build) {
  const archive = process.env.SCHOLARSEED_TERMINAL_HEADERS_ARCHIVE
  assert.ok(archive && path.isAbsolute(archive), 'select the reviewed local Node headers archive')
  const descriptor = fs.openSync(
    archive,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  )
  let headerBytes
  try {
    const info = fs.fstatSync(descriptor)
    assert.equal(info.isFile(), true)
    assert.equal(info.size, policy.headers.bytes)
    const bounded = Buffer.alloc(policy.headers.bytes + 1)
    let count = 0
    while (count < bounded.length) {
      const read = fs.readSync(descriptor, bounded, count, bounded.length - count, null)
      if (!read) break
      count += read
    }
    assert.equal(count, policy.headers.bytes)
    headerBytes = bounded.subarray(0, count)
    assert.equal(createHash('sha256').update(headerBytes).digest('hex'), policy.headers.sha256)
  } finally {
    fs.closeSync(descriptor)
  }
  const copy = path.join(build, 'headers.tar.gz')
  fs.writeFileSync(copy, headerBytes, { flag: 'wx', mode: 0o600 })
  const member = `node-v${policy.node}/include/node`
  const extracted = spawnSync('/usr/bin/tar', ['-xzf', copy, '-C', build, member], {
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT,
  })
  assert.ifError(extracted.error)
  assert.equal(extracted.status, 0, extracted.stderr)
  return path.join(build, member)
}

function child(config, script, flags = []) {
  const result = spawnSync(
    process.execPath,
    [
      ...flags,
      '-e',
      `const acquire=${acquire.toString()};${script}`,
      library,
      JSON.stringify(config),
    ],
    { encoding: 'utf8', timeout: CHILD_TIMEOUT }
  )
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('terminal addon validates configuration without creating locks', (context) => {
  const { config } = fixture(context)
  assert.deepEqual(Object.getOwnPropertyNames(api), ['open'])
  for (const argument of [
    undefined,
    null,
    {},
    '',
    '{}',
    JSON.stringify({ ...config, schema: true }),
    JSON.stringify({ ...config, extra: true }),
    JSON.stringify({ ...config, source: 'relative' }),
    JSON.stringify({ ...config, source: `${config.source}\0suffix` }),
    JSON.stringify({
      ...config,
      selection: { ...config.selection, identities: ['wrong', 'wrong', 'wrong'] },
    }),
  ]) {
    assert.throws(() => api.open(argument), { code: 'ERR_TERMINAL_ARGUMENT' })
  }
  fs.unlinkSync(path.join(config.cleanup, 'lock'))
  assert.throws(() => api.open(JSON.stringify(config)), { code: 'ERR_TERMINAL_OPEN' })
  assert.equal(fs.existsSync(path.join(config.cleanup, 'lock')), false)
})

test('opaque holder retains both locks, repeats observations and only explicit close releases', (context) => {
  const evidence = fixture(context)
  const before = [evidence.journal, evidence.ack, evidence.state].map((filename) =>
    fs.readFileSync(filename)
  )
  const { holder, snapshots } = acquire(api, JSON.stringify(evidence.config), 2)
  try {
    assert.deepEqual(Object.getOwnPropertyNames(holder), ['observe', 'close'])
    assert.throws(() => api.open(JSON.stringify(evidence.config)), { code: 'ERR_TERMINAL_BUSY' })
    assert.throws(() => holder.close.call({}), { code: 'ERR_TERMINAL_HANDLE' })
    for (const output of snapshots) {
      assert.equal(output.schema, 1)
      assert.equal(output.mode, 'inspect')
      assert.equal(output.proof.code, 60)
      assert.deepEqual(output.proof.binding, evidence.config.binding)
      for (const key of ['authority', 'granted', 'apply'])
        assert.equal(Object.hasOwn(output.proof, key), false)
    }
    assert.equal(
      child(
        evidence.config,
        `try{require(process.argv[1]).open(process.argv[2]);process.exitCode=1}catch(error){console.log(JSON.stringify(error.code))}`
      ),
      'ERR_TERMINAL_OPEN'
    )
    fs.appendFileSync(evidence.state, '\n')
    assert.throws(() => holder.observe(), { code: 'ERR_TERMINAL_OBSERVATION' })
    fs.writeFileSync(evidence.state, before[2])
    assert.throws(() => holder.observe(), { code: 'ERR_TERMINAL_OBSERVATION' })
  } finally {
    holder.close()
  }
  assert.equal(holder.close(), undefined)
  assert.throws(() => holder.observe(), { code: 'ERR_TERMINAL_CLOSED' })
  const replacement = acquire(api, JSON.stringify(evidence.config))
  try {
    assert.equal(holder.close(), undefined)
    assert.equal(
      child(
        evidence.config,
        `try{require(process.argv[1]).open(process.argv[2]);process.exitCode=1}catch(error){console.log(JSON.stringify(error.code))}`
      ),
      'ERR_TERMINAL_OPEN'
    )
  } finally {
    replacement.close()
  }
  assert.equal(
    child(
      evidence.config,
      `const handle=acquire(require(process.argv[1]),process.argv[2]);handle.close();console.log(JSON.stringify('released'))`
    ),
    'released'
  )
  for (const [index, filename] of [evidence.journal, evidence.ack, evidence.state].entries()) {
    assert.deepEqual(fs.readFileSync(filename), before[index])
  }
})

test('GC and worker teardown cannot silently release native observation locks', (context) => {
  const { config } = fixture(context)
  assert.equal(
    child(
      config,
      `
    (async()=>{const api=require(process.argv[1]);let handle=acquire(api,process.argv[2]);const weak=new WeakRef(handle);handle=null;
    for(let index=0;index<20;index++){await new Promise(resolve=>setImmediate(resolve));global.gc()}
    if(weak.deref())throw new Error('fixture did not collect wrapper');
    try{api.open(process.argv[2]);process.exitCode=1}catch(error){console.log(JSON.stringify(error.code))}})().catch(error=>{console.error(error);process.exitCode=1})
  `,
      ['--expose-gc']
    ),
    'ERR_TERMINAL_BUSY'
  )
  assert.equal(
    child(
      config,
      `
    const {Worker}=require('node:worker_threads');const api=require(process.argv[1]);
    const worker=new Worker('const{workerData}=require("node:worker_threads");('+acquire.toString()+')(require(workerData.library),workerData.config)',
      {eval:true,workerData:{library:process.argv[1],config:process.argv[2]}});
    worker.on('error',error=>{console.error(error);process.exitCode=1});worker.on('exit',code=>{
      if(code){process.exitCode=1;return}try{api.open(process.argv[2]);process.exitCode=1}catch(error){console.log(JSON.stringify(error.code))}})
  `
    ),
    'ERR_TERMINAL_BUSY'
  )
})

test('checked native close failure retains remaining locks and refuses reopening until exit', (context) => {
  const evidence = fixture(context, { retainOnFailure: true })
  const { config } = evidence
  const build = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'terminal-close-fixture-'))
  let completed = false
  context.after(() => {
    if (completed) fs.rmSync(build, { recursive: true, force: true })
    else process.stderr.write(`fixture evidence retained: ${build}\n`)
  })
  const source = path.join(build, 'fault.m'),
    executable = path.join(build, 'fault')
  fs.writeFileSync(
    source,
    `
    #import "cleanup.h"
    #import "preparation.h"
    #include <assert.h>
    #include <errno.h>
    #include <fcntl.h>
    #include <limits.h>
    #include <string.h>
    #include <sys/file.h>
    #include <unistd.h>
    #undef close
    extern int close(int);
    static int FailureDescriptor = -1;
    static unsigned Failures;
    int SSFixtureClose(int descriptor) {
      if (descriptor == FailureDescriptor) { Failures++; errno = EIO; return -1; }
      return close(descriptor);
    }
    int main(int argc, const char **argv) {
      @autoreleasepool {
        assert(argc == 4);
        NSString *cleanup = @(argv[1]), *preparation = @(argv[2]);
        BOOL prep = [@(argv[3]) hasPrefix:@"preparation"];
        assert(SSCleanupOpenExistingDirectory(cleanup, NULL));
        assert(SSPreparationOpenExistingDirectory(preparation, NULL));
        if (!prep) assert(SSPreparationCloseChecked(NULL));
        const char *selected = prep ? argv[2] : argv[1];
        NSString *selectedPath = @(selected);
        if ([@(argv[3]) hasSuffix:@"lock"]) selectedPath = [selectedPath stringByAppendingPathComponent:@"lock"];
        for (int descriptor = 0; descriptor < 1024; descriptor++) {
          char path[PATH_MAX];
          if (fcntl(descriptor, F_GETPATH, path) == 0 && strcmp(path, selectedPath.fileSystemRepresentation) == 0) { FailureDescriptor = descriptor; break; }
        }
        assert(FailureDescriptor >= 0);
        NSError *error = nil;
        assert(!(prep ? SSPreparationCloseChecked(&error) : SSCleanupCloseChecked(&error)) && error.code == EIO && Failures == 1);
        assert(!(prep ? SSPreparationCloseChecked(NULL) : SSCleanupCloseChecked(NULL)) && Failures == 1);
        assert(!(prep ? SSPreparationOpenExistingDirectory(preparation, NULL) : SSCleanupOpenExistingDirectory(cleanup, NULL)) && Failures == 1);
        NSString *lockPath = [@(selected) stringByAppendingPathComponent:@"lock"];
        int lock = open(lockPath.fileSystemRepresentation, O_RDONLY | O_CLOEXEC);
        assert(lock >= 0 && flock(lock, LOCK_EX | LOCK_NB) != 0);
        assert(close(lock) == 0);
      }
      return 0;
    }
  `
  )
  const compiled = spawnSync(
    '/usr/bin/xcrun',
    [
      'clang',
      '-fobjc-arc',
      '-fblocks',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-Dclose=SSFixtureClose',
      '-I',
      __dirname,
      '-framework',
      'Foundation',
      ...['cleanup.m', 'preparation.m', 'readiness.m'].map((name) => path.join(__dirname, name)),
      source,
      '-o',
      executable,
    ],
    { encoding: 'utf8', timeout: CHILD_TIMEOUT }
  )
  assert.equal(compiled.status, 0, compiled.stderr)
  for (const owner of [
    'preparation-directory',
    'preparation-lock',
    'cleanup-directory',
    'cleanup-lock',
  ]) {
    const checked = observeSpawn(
      executable,
      [config.cleanup, config.preparation, owner],
      { encoding: 'utf8', timeout: CHILD_TIMEOUT },
      path.join(build, `${owner}.json`)
    )
    const diagnostic = JSON.stringify({ pid: checked.pid, signal: checked.signal, error: checked.error?.code, errno: checked.error?.errno, stdout: checked.stdout, stderr: checked.stderr, observation: checked.observation })
    assert.equal(checked.status, 0, diagnostic)
    assert.deepEqual(checked.observation.evidence.errors, [], diagnostic)
    const holder = acquire(api, JSON.stringify(config))
    holder.close()
  }
  completed = true
  evidence.complete()
})

test('uncertain pin closure and Objective-C exceptions report release failure without dropping locks', (context) => {
  const { config } = fixture(context)
  const build = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'terminal-uncertain-fixture-')
  )
  context.after(() => fs.rmSync(build, { recursive: true, force: true }))
  const headers = verifiedHeaders(build)
  const fault = path.join(build, 'fault.m'),
    object = path.join(build, 'bridge.o')
  const addon = path.join(build, 'terminal.node'),
    marker = path.join(build, 'marker')
  fs.writeFileSync(
    fault,
    `
    #import <Foundation/Foundation.h>
    #include "directory.h"
    #include <errno.h>
    #include <stdlib.h>
    #include <unistd.h>
    uint32_t SSFixtureDirectoryClose(struct directory *directory) {
      const char *marker = getenv("SCHOLARSEED_TERMINAL_FAULT_MARKER");
      if (marker && access(marker, F_OK) == 0) {
        NSData *data = [NSData dataWithContentsOfFile:@(marker)];
        if ([data isEqual:[@"exception" dataUsingEncoding:NSUTF8StringEncoding]])
          @throw [NSException exceptionWithName:@"fixture" reason:@"fixture" userInfo:nil];
        return EBADF;
      }
      return directory_close(directory);
    }
  `
  )
  const flags = ['-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror']
  const compiled = spawnSync(
    '/usr/bin/xcrun',
    [
      'clang',
      ...flags,
      '-c',
      '-DNAPI_VERSION=8',
      '-DNODE_GYP_MODULE_NAME=terminal',
      '-Ddirectory_close=SSFixtureDirectoryClose',
      '-I',
      headers,
      path.join(__dirname, 'bridge.m'),
      '-o',
      object,
    ],
    { encoding: 'utf8', timeout: CHILD_TIMEOUT }
  )
  assert.ifError(compiled.error)
  assert.equal(compiled.status, 0, compiled.stderr)
  const linked = spawnSync(
    '/usr/bin/xcrun',
    [
      'clang',
      ...flags,
      '-bundle',
      '-undefined',
      'dynamic_lookup',
      '-I',
      path.dirname(__dirname),
      '-framework',
      'Foundation',
      object,
      fault,
      ...['cleanup.m', 'preparation.m', 'readiness.m'].map((name) => path.join(__dirname, name)),
      path.join(path.dirname(__dirname), 'directory.c'),
      '-o',
      addon,
    ],
    { encoding: 'utf8', timeout: CHILD_TIMEOUT }
  )
  assert.ifError(linked.error)
  assert.equal(linked.status, 0, linked.stderr)
  for (const mode of ['error', 'exception']) {
    const script = `const acquire=${acquire.toString()};const fs=require('node:fs');const{spawnSync}=require('node:child_process');
      const api=require(process.argv[1]);const holder=acquire(api,process.argv[2]);
      fs.writeFileSync(process.env.SCHOLARSEED_TERMINAL_FAULT_MARKER,process.argv[3],{mode:0o600});
      const evidence=[];for(let call=0;call<2;call++){try{holder.observe();throw new Error('unexpected success')}catch(error){evidence.push({code:error.code,systemCode:error.systemCode})}}
      fs.unlinkSync(process.env.SCHOLARSEED_TERMINAL_FAULT_MARKER);
      try{holder.close();throw new Error('unexpected close')}catch(error){evidence.push({code:error.code,systemCode:error.systemCode})}
      try{api.open(process.argv[2]);throw new Error('unexpected reopen')}catch(error){evidence.push({code:error.code,systemCode:error.systemCode})}
      const contender=spawnSync(process.execPath,['-e','try{require(process.argv[1]).open(process.argv[2]);process.exitCode=1}catch(error){console.log(JSON.stringify(error.code))}',process.argv[4],process.argv[2]],{encoding:'utf8',timeout:5000});
      if(contender.status!==0)throw new Error(contender.stderr);console.log(JSON.stringify({evidence,contender:JSON.parse(contender.stdout)}))`
    const result = spawnSync(
      process.execPath,
      ['-e', script, addon, JSON.stringify(config), mode, library],
      {
        encoding: 'utf8',
        timeout: CHILD_TIMEOUT,
        env: { ...process.env, SCHOLARSEED_TERMINAL_FAULT_MARKER: marker },
      }
    )
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    const systemCode = mode === 'error' ? os.constants.errno.EBADF : os.constants.errno.EIO
    assert.deepEqual(
      output.evidence,
      Array.from({ length: 4 }, () => ({ code: 'ERR_TERMINAL_RELEASE', systemCode }))
    )
    assert.equal(output.contender, 'ERR_TERMINAL_OPEN')
    const holder = acquire(api, JSON.stringify(config))
    holder.close()
  }
})

function preparationFaultAddon(context) {
  const build = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'terminal-preparation-fault-'))
  context.after(() => fs.rmSync(build, { recursive: true, force: true }))
  const headers = verifiedHeaders(build)
  const injection = path.join(build, 'injection.h')
  const fault = path.join(build, 'fault.m')
  const preparation = path.join(build, 'preparation.o')
  const bridge = path.join(build, 'bridge.o')
  const napiInjection = path.join(build, 'napi.h')
  const addon = path.join(build, 'terminal.node')
  const marker = path.join(build, 'marker')
  fs.writeFileSync(injection, `#include <unistd.h>\nint SSFixturePreparationClose(int, const char *);\n#define close(fd) SSFixturePreparationClose((fd), __func__)\n`)
  fs.writeFileSync(napiInjection, `
    #include <node_api.h>
    #include "directory.h"
    napi_status SSFixtureCreateString(napi_env, const char *, size_t, napi_value *);
    napi_status SSFixtureCreateError(napi_env, napi_value, napi_value, napi_value *);
    napi_status SSFixtureCreateInteger(napi_env, int32_t, napi_value *);
    napi_status SSFixtureDefine(napi_env, napi_value, size_t, const napi_property_descriptor *);
    napi_status SSFixtureThrow(napi_env, napi_value);
    napi_status SSFixtureThrowError(napi_env, const char *, const char *);
    napi_status SSFixturePending(napi_env, bool *);
    uint32_t SSFixturePinClose(struct directory *);
    #define napi_create_string_utf8 SSFixtureCreateString
    #define napi_create_error SSFixtureCreateError
    #define napi_create_int32 SSFixtureCreateInteger
    #define napi_define_properties SSFixtureDefine
    #define napi_throw SSFixtureThrow
    #define napi_throw_error SSFixtureThrowError
    #define napi_is_exception_pending SSFixturePending
    #define directory_close SSFixturePinClose
  `)
  fs.writeFileSync(fault, `
    #import <Foundation/Foundation.h>
    #include <sys/stat.h>
    #include <errno.h>
    #include <stdlib.h>
    #include <string.h>
    #include <stdio.h>
    #include <unistd.h>
    #include <node_api.h>
    #include "directory.h"
    #include "preparation.h"
    static BOOL fired;
    static NSString *napiMode;
    int SSFixturePreparationClose(int descriptor, const char *function) {
      int saved = errno;
      const char *marker = getenv("SCHOLARSEED_TERMINAL_PREPARATION_FAULT");
      if (!fired && marker && !strcmp(function, "PublishedCandidateMatches")) {
        NSData *data = [NSData dataWithContentsOfFile:@(marker)];
        NSDictionary *expected = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
        struct stat info;
        if (expected && fstat(descriptor, &info) == 0 && [expected[@"dev"] isEqual:@(info.st_dev)] &&
          [expected[@"ino"] isEqual:@(info.st_ino)] && [expected[@"uid"] isEqual:@(info.st_uid)]) {
          fired = YES; napiMode = expected[@"napi"]; errno = EBADF; return -1;
        }
      }
      errno = saved;
      return close(descriptor);
    }
    static BOOL Mode(NSString *mode) { return SSPreparationUncertaintyCode() != 0 && [napiMode isEqual:mode]; }
    uint32_t SSFixturePinClose(struct directory *directory) {
      if (SSPreparationUncertaintyCode()) { fputs("fixture-pin-release-after-uncertainty", stderr); _exit(86); }
      return directory_close(directory);
    }
    napi_status SSFixtureCreateString(napi_env env, const char *text, size_t size, napi_value *result) {
      return Mode(@"create-string") ? napi_generic_failure : napi_create_string_utf8(env, text, size, result);
    }
    napi_status SSFixtureCreateError(napi_env env, napi_value code, napi_value message, napi_value *result) {
      if (Mode(@"pending")) { napi_throw_error(env, "FIXTURE_PENDING", "fixture"); return napi_pending_exception; }
      if (Mode(@"create-error") || Mode(@"throw-error") || Mode(@"pending-check")) return napi_generic_failure;
      return napi_create_error(env, code, message, result);
    }
    napi_status SSFixtureCreateInteger(napi_env env, int32_t value, napi_value *result) {
      return Mode(@"create-integer") ? napi_generic_failure : napi_create_int32(env, value, result);
    }
    napi_status SSFixtureDefine(napi_env env, napi_value object, size_t count, const napi_property_descriptor *properties) {
      return Mode(@"define") ? napi_generic_failure : napi_define_properties(env, object, count, properties);
    }
    napi_status SSFixtureThrow(napi_env env, napi_value error) {
      return Mode(@"throw") ? napi_generic_failure : napi_throw(env, error);
    }
    napi_status SSFixtureThrowError(napi_env env, const char *code, const char *message) {
      return Mode(@"throw-error") ? napi_generic_failure : napi_throw_error(env, code, message);
    }
    napi_status SSFixturePending(napi_env env, bool *pending) {
      return Mode(@"pending-check") ? napi_generic_failure : napi_is_exception_pending(env, pending);
    }
  `)
  const flags = ['-O0', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror']
  const compiled = spawnSync('/usr/bin/xcrun', ['clang', ...flags, '-include', injection, '-c', path.join(__dirname, 'preparation.m'), '-o', preparation], { encoding: 'utf8', timeout: CHILD_TIMEOUT })
  assert.ifError(compiled.error)
  assert.equal(compiled.status, 0, compiled.stderr)
  const bridgeCompiled = spawnSync('/usr/bin/xcrun', ['clang', ...flags, '-include', napiInjection, '-DNAPI_VERSION=8', '-DNODE_GYP_MODULE_NAME=terminal', '-I', headers, '-I', path.dirname(__dirname), '-c', path.join(__dirname, 'bridge.m'), '-o', bridge], { encoding: 'utf8', timeout: CHILD_TIMEOUT })
  assert.ifError(bridgeCompiled.error)
  assert.equal(bridgeCompiled.status, 0, bridgeCompiled.stderr)
  const linked = spawnSync('/usr/bin/xcrun', ['clang', ...flags, '-bundle', '-undefined', 'dynamic_lookup', '-DNAPI_VERSION=8', '-DNODE_GYP_MODULE_NAME=terminal', '-I', headers,
    '-I', path.dirname(__dirname), '-I', __dirname, '-framework', 'Foundation', bridge, preparation, fault, ...['cleanup.m', 'readiness.m'].map((name) => path.join(__dirname, name)),
    path.join(path.dirname(__dirname), 'directory.c'), '-o', addon], { encoding: 'utf8', timeout: CHILD_TIMEOUT })
  assert.ifError(linked.error)
  assert.equal(linked.status, 0, linked.stderr)
  return { addon, marker, build }
}

test('preparation owner uncertainty reaches opaque observation before any release', (context) => {
  const { config, candidateDirectory } = fixture(context, { publication: true })
  const { addon, marker } = preparationFaultAddon(context)
  for (const selected of [candidateDirectory, path.dirname(candidateDirectory)]) {
    const info = fs.statSync(selected)
    const identity = { dev: info.dev, ino: info.ino, uid: info.uid }
    for (const stage of ['observe', 'open']) {
      const script = `const acquire=${acquire.toString()};const fs=require('node:fs');const{spawnSync}=require('node:child_process');
        const api=require(process.argv[1]);let holder;
        if(process.argv[3]==='observe')holder=acquire(api,process.argv[2]);
        fs.writeFileSync(process.env.SCHOLARSEED_TERMINAL_PREPARATION_FAULT,process.argv[4],{mode:0o600});
        const evidence=[];const invoke=call=>{try{call();throw new Error('unexpected success')}catch(error){evidence.push({code:error.code,systemCode:error.systemCode})}};
        invoke(()=>holder?holder.observe():api.open(process.argv[2]));
        fs.unlinkSync(process.env.SCHOLARSEED_TERMINAL_PREPARATION_FAULT);
        invoke(()=>holder?holder.observe():api.open(process.argv[2]));
        if(holder)invoke(()=>holder.close());
        invoke(()=>api.open(process.argv[2]));
        const contender=spawnSync(process.execPath,['-e','try{require(process.argv[1]).open(process.argv[2]);process.exitCode=1}catch(error){console.log(JSON.stringify(error.code))}',process.argv[5],process.argv[2]],{encoding:'utf8',timeout:5000});
        if(contender.status!==0)throw new Error(contender.stderr);console.log(JSON.stringify({evidence,contender:JSON.parse(contender.stdout)}))`
      const result = spawnSync(process.execPath, ['-e', script, addon, JSON.stringify(config), stage, JSON.stringify(identity), library], {
        encoding: 'utf8', timeout: CHILD_TIMEOUT, env: { ...process.env, SCHOLARSEED_TERMINAL_PREPARATION_FAULT: marker },
      })
      assert.ifError(result.error)
      assert.equal(result.status, 0, result.stderr)
      const output = JSON.parse(result.stdout)
      assert.deepEqual(output.evidence, Array.from({ length: stage === 'observe' ? 4 : 3 }, () => ({ code: 'ERR_TERMINAL_RELEASE', systemCode: os.constants.errno.EBADF })))
      assert.equal(output.contender, 'ERR_TERMINAL_OPEN')
      const holder = acquire(api, JSON.stringify(config))
      holder.close()
    }
  }
})

test('uncertain qualification error encoding preserves release or fails the maintenance process closed', (context) => {
  const { config, candidateDirectory } = fixture(context, { publication: true })
  const { addon, marker, build } = preparationFaultAddon(context)
  const info = fs.statSync(candidateDirectory)
  for (const mode of ['create-string', 'create-error', 'create-integer', 'define', 'throw', 'pending', 'throw-error', 'pending-check']) {
    const cleanup = path.join(build, `cleanup-${mode}`)
    const fatal = ['pending', 'throw-error', 'pending-check'].includes(mode)
    const script = `const acquire=${acquire.toString()};const fs=require('node:fs');
      const api=require(process.argv[1]);const holder=acquire(api,process.argv[2]);
      fs.writeFileSync(process.env.SCHOLARSEED_TERMINAL_PREPARATION_FAULT,process.argv[3],{mode:0o600});
      try{holder.observe();fs.writeFileSync(process.argv[4],'unexpected success')}catch(error){
        if(process.argv[5]==='fatal')fs.writeFileSync(process.argv[4],'ordinary-exception-cleanup');
        console.log(JSON.stringify({code:error.code,systemCode:error.systemCode}));
      }
      if(process.argv[5]==='fatal')fs.writeFileSync(process.argv[4],'continued');`
    const result = spawnSync(process.execPath, ['-e', script, addon, JSON.stringify(config), JSON.stringify({ dev: info.dev, ino: info.ino, uid: info.uid, napi: mode }), cleanup, fatal ? 'fatal' : 'fallback'], {
      encoding: 'utf8', timeout: CHILD_TIMEOUT, env: { ...process.env, SCHOLARSEED_TERMINAL_PREPARATION_FAULT: marker },
    })
    context.diagnostic(JSON.stringify({ mode, pid: result.pid, status: result.status, signal: result.signal, error: result.error?.code, stdout: result.stdout, stderr: result.stderr, cleanupExists: fs.existsSync(cleanup) }))
    assert.ifError(result.error)
    assert.notEqual(result.status, 86, result.stderr)
    assert.equal(result.stderr.includes('fixture-pin-release-after-uncertainty'), false)
    assert.equal(fs.existsSync(cleanup), false)
    if (fatal) {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /terminal qualification release could not be reported/)
    } else {
      assert.equal(result.status, 0, result.stderr)
      assert.equal(JSON.parse(result.stdout).code, 'ERR_TERMINAL_RELEASE')
    }
    fs.rmSync(marker, { force: true })
    const holder = acquire(api, JSON.stringify(config))
    holder.close()
  }
})
