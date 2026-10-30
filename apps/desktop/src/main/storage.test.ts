// storage.test.ts — proposal 112 home 单根解析口的契约测试。
//
// 用与 tray.test.ts 同款的 runInNewContext + 注入 fake electron 模式：storage.ts 在 import 时
// 不冻结 home，selectStorage/publishStorage 在入口选择并发布；每个 fixture 对应独立进程的模块状态。
// 只创建隔离的临时 userData/documents/home 父目录，不碰真实 ~/.scholarseed。
import assert from 'node:assert/strict'
import {
  existsSync,
  linkSync,
  lstatSync,
  symlinkSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import * as nodePath from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as journal from './journal.ts'
import * as storageRecord from './storage-record.ts'
import type { StorageSelection, StorageNative } from './storage.ts'

const storageSource = readFileSync(new URL('./storage.ts', import.meta.url), 'utf8')

interface Fixture {
  mod: Record<string, unknown>
  native: StorageNative
  start: (namespace: string) => unknown
  select: (namespace: string) => Readonly<StorageSelection>
  publish: (selection: Readonly<StorageSelection>) => Readonly<StorageSelection>
  userData: string
  documents: string
  env: Record<string, string | undefined>
  setEnv: (home: string | undefined) => void
  setUserData: (path: string) => void
  pointerReads: () => number
  setPlatform: (platform: NodeJS.Platform) => void
  setExecPath: (execPath: string) => void
  setPacked: (packed: boolean) => void
  setHomedir: (dir: string) => void
  cleanup: () => void
}

function fixture(
  probeCreated?: (path: string) => void,
  readFailure?: NodeJS.ErrnoException,
  afterPointerWrite?: () => void
): Fixture {
  const userData = mkdtempSync(join(tmpdir(), 'ss-userdata-'))
  const documents = mkdtempSync(join(tmpdir(), 'ss-documents-'))
  const env: Record<string, string | undefined> = {}
  let selectedUserData = userData
  let pointerReadCount = 0
  let packed = false
  let homeDir = homedir()
  const processStub = {
    env,
    platform: process.platform as NodeJS.Platform,
    execPath: '/Applications/ScholarSeed.app/Contents/MacOS/ScholarSeed',
  }
  // Contract filesystem double; native object binding is verified by native/ and product startup.
  const native: StorageNative = {
    pin: (directory) => {
      try {
        if (!lstatSync(directory).isDirectory()) throw new Error('not a directory')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw Object.assign(new Error('missing directory'), { code: 'ERR_LEASE_MISSING' })
        throw error
      }
      return directory
    },
    readAt: (directory, name, limit) => {
      const filename = join(directory as string, name)
      let info
      try {
        info = lstatSync(filename)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
      if (!info.isFile()) throw new Error('not a regular pointer')
      pointerReadCount++
      if (readFailure) throw readFailure
      const content = readFileSync(filename)
      if (content.length > limit) throw new Error('pointer exceeds size limit')
      return content
    },
    release: () => {},
  }
  const exports: Record<string, unknown> = {}
  runInNewContext(
    ts.transpileModule(storageSource, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports,
      TextDecoder,
      require: (name: string) => {
        if (name === 'node:buffer') return { Buffer }
        if (name === 'electron')
          return {
            app: {
              getName: () => 'ScholarSeed',
              getAppPath: () => join(userData, 'repo', 'apps', 'desktop'),
              getPath: (key: string) => (key === 'userData' ? selectedUserData : documents),
              get isPackaged() {
                return packed
              },
            },
          }
        if (name === './storage-record.ts') return storageRecord
        if (name === './writer') return { desktopDirectoryWriter: () => ({ close() {} }) }
        if (name === './journal.ts')
          return {
            ...journal,
            writeJson: (path: string, value: unknown) => {
              journal.writeJson(path, value)
              afterPointerWrite?.()
            },
          }
        if (name === 'fs')
          return {
            existsSync,
            lstatSync,
            mkdirSync,
            readdirSync,
            realpathSync,
            readFileSync: (filename: string, encoding: BufferEncoding) => {
              if (nodePath.basename(filename) === 'storage-config.json') {
                pointerReadCount++
                if (readFailure) throw readFailure
              }
              return readFileSync(filename, encoding)
            },
            rmSync,
            rmdirSync,
            writeFileSync,
            mkdtempSync: (prefix: string) => {
              const path = mkdtempSync(prefix)
              probeCreated?.(path)
              return path
            },
          }
        if (name === 'os') return { homedir: () => homeDir, userInfo }
        if (name === 'path') return nodePath
        throw new Error(`unexpected import: ${name}`)
      },
      process: processStub,
    }
  )
  const commit = exports.commitDataHome as (
    parent: string,
    platform: NodeJS.Platform,
    native: StorageNative
  ) => unknown
  exports.commitDataHome = (parent: string, platform: NodeJS.Platform) =>
    commit(parent, platform, native)
  const read = exports.readStorageConfig as (native: StorageNative) => unknown
  exports.readStorageConfig = () => read(native)
  return {
    env,
    mod: exports,
    native,
    select: (namespace) =>
      (
        exports.selectStorage as (
          namespace: string,
          native: StorageNative
        ) => Readonly<StorageSelection>
      )(namespace, native),
    publish: exports.publishStorage as Fixture['publish'],
    start: (namespace) => {
      const selected = (
        exports.selectStorage as (namespace: string, native: StorageNative) => unknown
      )(namespace, native)
      return (exports.publishStorage as (candidate: unknown) => unknown)(selected)
    },
    userData,
    documents,
    setUserData: (value) => {
      selectedUserData = value
    },
    pointerReads: () => pointerReadCount,
    setEnv: (home) => {
      if (home === undefined) delete env.SCHOLARSEED_HOME
      else env.SCHOLARSEED_HOME = home
    },
    setPlatform: (platform) => {
      processStub.platform = platform
    },
    setExecPath: (execPath) => {
      processStub.execPath = execPath
    },
    setPacked: (value) => {
      packed = value
    },
    setHomedir: (dir) => {
      homeDir = dir
    },
    cleanup: () => {
      rmSync(userData, { recursive: true, force: true })
      rmSync(documents, { recursive: true, force: true })
    },
  }
}

for (const source of ['default', 'pointer', 'env'] as const) {
  test(`storage startup selects home once: ${source}`, () => {
    const fx = fixture()
    try {
      const pointerHome = join(fx.userData, 'pointer-home')
      const explicitHome = join(fx.documents, 'env-home')
      if (source !== 'default') (fx.mod.writeStorageConfig as (home: string) => void)(pointerHome)
      if (source === 'env') fx.setEnv(explicitHome)
      const startup = (fx.start as (namespace: string) => { home: string; configured: boolean })(
        'local'
      )
      assert.equal(
        startup.home,
        source === 'env'
          ? explicitHome
          : source === 'pointer'
            ? pointerHome
            : join(homedir(), '.scholarseed')
      )
      assert.equal((fx.mod.desktopHome as () => string)(), startup.home)
      assert.equal(startup.configured, source !== 'default')
    } finally {
      fx.cleanup()
    }
  })
}

for (const kind of ['environment', 'pointer', 'default'] as const) {
  test(`storage retains the original ${kind} observation after publication`, () => {
    const fx = fixture()
    try {
      const home = join(fx.documents, 'selected')
      const raw = Buffer.from(JSON.stringify({ schemaVersion: 1, dataHome: home }) + '\n')
      if (kind === 'pointer') writeFileSync(join(fx.userData, 'storage-config.json'), raw)
      if (kind === 'environment') fx.setEnv(` ${home} `)
      const selected = fx.select('local')
      assert.equal(selected.source.kind, kind)
      assert.equal(Object.isFrozen(selected.source), true)
      if (selected.source.kind === 'pointer')
        assert.equal(selected.source.bytes, raw.toString('base64'))
      if (selected.source.kind === 'environment') assert.equal(selected.source.value, home)
      const reads = fx.pointerReads()
      fx.publish(selected)
      fx.setEnv(join(fx.documents, 'changed-env'))
      writeFileSync(join(fx.userData, 'storage-config.json'), '{"changed":true}')
      const current = (fx.mod.desktopStorage as () => Readonly<StorageSelection>)()
      assert.equal(current, selected)
      assert.equal(current.source, selected.source)
      assert.equal(current.source.kind, kind)
      assert.equal(fx.pointerReads(), reads)
      assert.equal(reads, kind === 'pointer' ? 1 : 0)
    } finally {
      fx.cleanup()
    }
  })
}

test('storage copies its pointer observation before releasing the native reader', () => {
  const fx = fixture()
  try {
    const home = join(fx.documents, 'selected')
    const raw = Buffer.from(JSON.stringify({ schemaVersion: 1, dataHome: home }))
    const expected = raw.toString('base64')
    fx.native.readAt = () => raw
    fx.native.release = () => {
      raw.fill(0)
    }
    const selected = fx.select('local')
    assert.equal(selected.home, home)
    assert.equal(selected.source.kind, 'pointer')
    if (selected.source.kind === 'pointer') assert.equal(selected.source.bytes, expected)
  } finally {
    fx.cleanup()
  }
})

test('only a missing storage pointer permits the default home', () => {
  const fx = fixture()
  try {
    const read = fx.mod.readStorageConfig as () => { dataHome: string } | null
    assert.equal(read(), null)
    const pointer = join(fx.userData, 'storage-config.json')
    const valid = join(fx.documents, 'selected')
    for (const content of [
      '{ not json',
      'null',
      '[]',
      JSON.stringify({ schemaVersion: 999, dataHome: valid }),
      JSON.stringify({ schemaVersion: 1, dataHome: 'relative/home' }),
      JSON.stringify({ schemaVersion: 1, dataHome: valid + '\0bad' }),
    ]) {
      writeFileSync(pointer, content)
      assert.throws(
        () => (fx.start as (namespace: string) => unknown)('local'),
        (error: { code?: string; path?: string }) =>
          error.code === 'ERR_STORAGE_CONFIG' && error.path === pointer
      )
      assert.throws(() => (fx.mod.desktopStorage as () => unknown)(), /must be initialized/)
      assert.equal(fx.env.SCHOLARSEED_HOME, undefined)
      assert.equal(readFileSync(pointer, 'utf8'), content)
    }
    writeFileSync(pointer, JSON.stringify({ schemaVersion: 1, dataHome: valid }))
    assert.equal(read()?.dataHome, valid)
    assert.equal((fx.start as (namespace: string) => { home: string })('local').home, valid)
  } finally {
    fx.cleanup()
  }
})

for (const kind of ['directory', 'dangling-link'] as const) {
  test(`existing ${kind} pointer is not treated as missing`, () => {
    const fx = fixture()
    try {
      const pointer = join(fx.userData, 'storage-config.json')
      if (kind === 'directory') mkdirSync(pointer)
      else
        symlinkSync(
          join(fx.documents, 'absent'),
          pointer,
          process.platform === 'win32' ? 'junction' : 'dir'
        )
      assert.throws(
        () => (fx.mod.readStorageConfig as () => unknown)(),
        (error: { code?: string }) => error.code === 'ERR_STORAGE_CONFIG'
      )
    } finally {
      fx.cleanup()
    }
  })
}

test('explicit home does not read an unselected corrupt pointer', () => {
  const fx = fixture()
  try {
    writeFileSync(join(fx.userData, 'storage-config.json'), 'corrupt')
    const home = join(fx.documents, 'explicit')
    fx.setEnv(home)
    const selected = (
      fx.start as (namespace: string) => {
        home: string
        firstLaunchEligible: boolean
      }
    )('local')
    assert.equal(selected.home, home)
    assert.equal(selected.firstLaunchEligible, false)
    assert.equal(fx.pointerReads(), 0)
  } finally {
    fx.cleanup()
  }
})

test('deriveWorkspaceDefault：默认 home → Documents/ScholarSeed；自定义 home → 同父 Projects', () => {
  const fx = fixture()
  try {
    const deriveWorkspaceDefault = fx.mod.deriveWorkspaceDefault as (home: string) => string
    const defaultHome = join(homedir(), '.scholarseed')
    // 默认 home：沿用 Documents/ScholarSeed（不退化成 ~/Projects）
    assert.equal(deriveWorkspaceDefault(defaultHome), join(fx.documents, 'ScholarSeed'))
    // 自定义 home：与 home 同父目录的 Projects
    assert.equal(deriveWorkspaceDefault('/data/disk/.scholarseed'), join('/data/disk', 'Projects'))
  } finally {
    fx.cleanup()
  }
})

test('isValidAbsoluteRoot：Windows 认盘符/UNC，POSIX 认前导 /，相对路径一律拒', () => {
  const fx = fixture()
  try {
    const isValidAbsoluteRoot = fx.mod.isValidAbsoluteRoot as (
      value: string,
      platform: NodeJS.Platform
    ) => boolean
    assert.equal(isValidAbsoluteRoot('D:\\ss', 'win32'), true)
    assert.equal(isValidAbsoluteRoot('D:/ss', 'win32'), true)
    assert.equal(isValidAbsoluteRoot('\\\\nas\\ss', 'win32'), true)
    assert.equal(isValidAbsoluteRoot('relative\\ss', 'win32'), false)
    assert.equal(isValidAbsoluteRoot('/Volumes/ss', 'win32'), false)
    assert.equal(isValidAbsoluteRoot('/data/ss', 'darwin'), true)
    assert.equal(isValidAbsoluteRoot('relative/ss', 'darwin'), false)
    assert.equal(isValidAbsoluteRoot('', 'darwin'), false)
  } finally {
    fx.cleanup()
  }
})

test('validateDataParent / commitDataHome：形状非法拒、可写通过并写指针 + 建 home', () => {
  const fx = fixture()
  fx.setHomedir(fx.documents)
  fx.setPacked(true)
  fx.start('local')
  try {
    const validateDataParent = fx.mod.validateDataParent as (
      p: string,
      plat: NodeJS.Platform
    ) => { ok: boolean; reason?: string; home?: string }
    const commitDataHome = fx.mod.commitDataHome as (
      p: string,
      plat: NodeJS.Platform
    ) => { ok: boolean; reason?: string; home?: string; restartRequired?: boolean }
    const readStorageConfig = fx.mod.readStorageConfig as () => { dataHome: string } | null

    // 相对路径 → invalid_shape（darwin 认前导 /）
    const invalid = validateDataParent('relative/dir', 'darwin')
    assert.equal(invalid.ok, false)
    assert.equal(invalid.reason, 'invalid_shape')

    // 真实可写临时父目录 → ok + home = P/.scholarseed
    const parent = mkdtempSync(join(tmpdir(), 'ss-parent-'))
    try {
      const validated = validateDataParent(parent, process.platform)
      assert.equal(validated.ok, true)
      assert.equal(validated.home, join(parent, '.scholarseed'))
      // 探测目录已清理，无残留
      assert.equal(existsSync(join(parent, '.scholarseed-write-probe')), false)

      const committed = commitDataHome(parent, process.platform)
      if (process.platform === 'win32') {
        assert.equal(committed.ok, false)
        assert.equal(committed.reason, 'unsupported')
        assert.equal(existsSync(join(parent, '.scholarseed')), false)
        assert.equal(readStorageConfig(), null)
      } else {
        assert.equal(committed.ok, true)
        assert.equal(committed.restartRequired, true)
        assert.equal(existsSync(join(parent, '.scholarseed')), true, 'commit 建出 home')
        assert.equal(readStorageConfig()?.dataHome, join(parent, '.scholarseed'), 'commit 写指针')
      }
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  } finally {
    fx.cleanup()
  }
})

for (const state of ['missing', 'empty', 'populated', 'file'] as const) {
  test(`legacy home participates in first-launch eligibility: ${state}`, () => {
    const fx = fixture()
    try {
      fx.setPacked(true)
      fx.setPlatform('darwin')
      fx.setHomedir(fx.documents)
      const legacy = join(fx.userData, '.veda')
      if (state === 'empty' || state === 'populated') mkdirSync(legacy)
      if (state === 'populated') writeFileSync(join(legacy, 'existing-data'), 'retained')
      if (state === 'file') writeFileSync(legacy, 'not a directory')
      const selected = fx.select('local')
      const eligible = state === 'missing' || state === 'empty'
      assert.equal(selected.firstLaunchEligible, eligible)
      assert.equal(existsSync(selected.home), false, 'selection must not create home')
      fx.publish(selected)
      if (!eligible) {
        // Migration may later move the old root; the startup decision stays frozen.
        rmSync(legacy, { recursive: true })
        const commit = fx.mod.commitDataHome as (parent: string) => { ok: boolean; reason?: string }
        const result = commit(fx.documents)
        assert.equal(result.ok, false)
        assert.equal(result.reason, 'unsupported')
        assert.equal(existsSync(join(fx.userData, 'storage-config.json')), false)
        assert.equal(existsSync(selected.home), false)
      }
    } finally {
      fx.cleanup()
    }
  })
}

test('startup eligibility survives home injection and subsequent runtime writes', () => {
  const fx = fixture()
  const parent = mkdtempSync(join(tmpdir(), 'ss-startup-home-'))
  try {
    fx.setHomedir(parent)
    fx.setPacked(true)
    const startStorage = fx.start as (namespace: string) => Readonly<{
      home: string
      firstLaunchEligible: boolean
    }>
    const startup = startStorage('local')
    mkdirSync(join(parent, '.scholarseed', 'logs'), { recursive: true })
    assert.equal(startup.firstLaunchEligible, true)
    assert.equal(startup.home, join(parent, '.scholarseed'))
    assert.equal(Object.isFrozen(startup), true)
  } finally {
    rmSync(parent, { recursive: true, force: true })
    fx.cleanup()
  }
})

for (const scenario of [
  'explicit env',
  'pointer',
  'existing data',
  'empty home',
  'development',
] as const) {
  test(`startup eligibility and selected home: ${scenario}`, () => {
    const fx = fixture()
    const parent = mkdtempSync(join(tmpdir(), 'ss-startup-matrix-'))
    try {
      fx.setHomedir(parent)
      fx.setPacked(scenario !== 'development')
      const home = join(parent, '.scholarseed')
      const configuredHome = join(parent, 'configured')
      if (scenario === 'explicit env') fx.setEnv(configuredHome)
      if (scenario === 'pointer')
        (fx.mod.writeStorageConfig as (home: string) => void)(configuredHome)
      if (scenario === 'existing data') mkdirSync(join(home, 'service'), { recursive: true })
      if (scenario === 'empty home') mkdirSync(home)
      const startup = (
        fx.start as (namespace: string) => Readonly<{ home: string; firstLaunchEligible: boolean }>
      )('local')
      assert.equal(startup.firstLaunchEligible, scenario === 'empty home')
      assert.equal(
        startup.home,
        ['explicit env', 'pointer'].includes(scenario) ? configuredHome : home
      )
      assert.equal((fx.mod.desktopHome as () => string)(), startup.home)
    } finally {
      rmSync(parent, { recursive: true, force: true })
      fx.cleanup()
    }
  })
}

test('data home choice follows platform policy without switching the running home', () => {
  const fx = fixture()
  const parent = mkdtempSync(join(tmpdir(), 'ss-startup-choice-'))
  try {
    fx.setHomedir(parent)
    fx.setPacked(true)
    const startup = (
      fx.start as (namespace: string) => Readonly<{ home: string; firstLaunchEligible: boolean }>
    )('local')
    const pointer = fx.mod.readStorageConfig as () => unknown
    assert.equal(startup.firstLaunchEligible && !pointer(), true)
    const result = (fx.mod.commitDataHome as (parent: string, platform: string) => { ok: boolean })(
      fx.documents,
      process.platform
    )
    assert.equal(result.ok, process.platform !== 'win32')
    assert.equal(startup.firstLaunchEligible && !pointer(), process.platform === 'win32')
    assert.equal((fx.mod.desktopHome as () => string)(), startup.home)
  } finally {
    rmSync(parent, { recursive: true, force: true })
    fx.cleanup()
  }
})

for (const kind of ['directory', 'file'] as const) {
  test(`data parent validation preserves an existing probe-named ${kind}`, () => {
    const fx = fixture()
    try {
      const occupied = join(fx.documents, '.scholarseed-write-probe')
      const content = kind === 'directory' ? join(occupied, 'user-content.txt') : occupied
      if (kind === 'directory') mkdirSync(occupied)
      writeFileSync(content, 'user-owned bytes')
      const before = readdirSync(fx.documents)
      const result = (
        fx.mod.validateDataParent as (path: string, platform: NodeJS.Platform) => { ok: boolean }
      )(fx.documents, process.platform)
      assert.equal(existsSync(content), true, 'existing user content was deleted')
      assert.equal(readFileSync(content, 'utf8'), 'user-owned bytes')
      assert.equal(result.ok, true)
      assert.deepEqual(readdirSync(fx.documents), before, 'own probe must leave no residue')
    } finally {
      fx.cleanup()
    }
  })
}

test('failed probe creation preserves the selected path and creates no sibling residue', () => {
  const fx = fixture()
  try {
    const parent = join(fx.documents, 'not-a-directory')
    writeFileSync(parent, 'existing file')
    const before = readdirSync(fx.documents)
    const result = (
      fx.mod.validateDataParent as (
        path: string,
        platform: NodeJS.Platform
      ) => { ok: boolean; reason?: string }
    )(parent, process.platform)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not_writable')
    assert.equal(readFileSync(parent, 'utf8'), 'existing file')
    assert.deepEqual(readdirSync(fx.documents), before)
  } finally {
    fx.cleanup()
  }
})

test('unexpected content in an owned probe is preserved rather than recursively removed', () => {
  let content = ''
  const fx = fixture((path) => {
    content = join(path, 'concurrent-content.txt')
    writeFileSync(content, 'must survive')
  })
  try {
    const result = (
      fx.mod.validateDataParent as (
        path: string,
        platform: NodeJS.Platform
      ) => { ok: boolean; reason?: string }
    )(fx.documents, process.platform)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not_writable')
    assert.equal(readFileSync(content, 'utf8'), 'must survive')
  } finally {
    fx.cleanup()
  }
})

test('running home does not follow later environment or pointer changes', () => {
  const fx = fixture()
  try {
    const selected = join(fx.userData, 'selected-home')
    fx.setEnv(selected)
    const startup = (fx.start as (namespace: string) => { home: string })('local')
    fx.setEnv(join(fx.documents, 'later-home'))
    ;(fx.mod.writeStorageConfig as (home: string) => void)(join(fx.documents, 'next-home'))
    assert.equal((fx.mod.desktopHome as () => string)(), startup.home)
    fx.setEnv(undefined)
    assert.equal((fx.mod.desktopHome as () => string)(), selected)
  } finally {
    fx.cleanup()
  }
})

test('storage rejects access before initialization and cannot be reinitialized', () => {
  const fx = fixture()
  try {
    const home = fx.mod.desktopHome as () => string
    const initialize = fx.start as (namespace: string) => {
      home: string
      userData: string
    }
    assert.throws(home, /must be initialized/)
    fx.setEnv(join(fx.documents, 'current'))
    const selected = initialize('local')
    assert.equal(fx.pointerReads(), 0)
    assert.equal(selected.userData, fx.userData)
    fx.setEnv(join(fx.documents, 'later'))
    assert.throws(() => initialize('local'), /already initialized/)
    assert.equal(home(), selected.home)
    assert.equal(fx.pointerReads(), 0, 'runtime reads cannot reopen the selection pointer')
  } finally {
    fx.cleanup()
  }
})

test('next-start pointer remains in the initialized userData directory', () => {
  const fx = fixture()
  try {
    const initialize = fx.start as (namespace: string) => { home: string }
    const selected = initialize('local')
    fx.setUserData(fx.documents)
    const next = join(fx.documents, 'next-home')
    ;(fx.mod.writeStorageConfig as (home: string) => void)(next)
    const currentPointer = JSON.parse(
      readFileSync(join(fx.userData, 'storage-config.json'), 'utf8')
    )
    assert.equal(currentPointer.dataHome, next)
    assert.equal(existsSync(join(fx.documents, 'storage-config.json')), false)
    assert.equal((fx.mod.desktopHome as () => string)(), selected.home)
  } finally {
    fx.cleanup()
  }
})

test('default Chromium profile retains existing lane data without moving or copying it', () => {
  const fx = fixture()
  try {
    const defaultProfile = join(fx.documents, 'ScholarSeed')
    const existingSession = join(fx.documents, 'scholarseed-desktop-session-local')
    mkdirSync(defaultProfile)
    mkdirSync(existingSession)
    writeFileSync(join(existingSession, 'retained'), 'existing data')
    fx.setUserData(defaultProfile)
    assert.equal(fx.select('local').sessionData, existingSession)
    assert.equal(readFileSync(join(existingSession, 'retained'), 'utf8'), 'existing data')
    assert.deepEqual(readdirSync(defaultProfile), [])
  } finally {
    fx.cleanup()
  }
})

test('custom profiles and credential lanes remain independent of Home and working directory', () => {
  const fx = fixture()
  try {
    const first = fx.select('local')
    fx.setEnv(join(fx.documents, 'other-home'))
    fx.env.SCHOLARSEED_REPO = join(fx.documents, 'other-repo')
    assert.equal(fx.select('local').sessionData, first.sessionData)
    assert.notEqual(fx.select('distribution').sessionData, first.sessionData)
    fx.setUserData(join(fx.documents, 'restored profile'))
    const restored = fx.select('local')
    assert.equal(
      restored.sessionData,
      join(fx.documents, 'restored profile', 'scholarseed-desktop-session-local')
    )
    assert.notEqual(restored.sessionData, first.sessionData)
    assert.equal(existsSync(restored.sessionData), false)
    assert.equal(existsSync(first.sessionData), false)
    fx.setUserData(fx.userData)
    assert.equal(fx.select('local').sessionData, first.sessionData)
  } finally {
    fx.cleanup()
  }
})

test('default profile classification retains the original session directory for aliases', () => {
  const fx = fixture()
  try {
    const defaultProfile = join(fx.documents, 'ScholarSeed')
    const alias = join(fx.documents, 'profile-alias')
    mkdirSync(defaultProfile)
    symlinkSync(defaultProfile, alias, process.platform === 'win32' ? 'junction' : 'dir')
    fx.setEnv(join(fx.userData, 'home'))
    for (const selected of [defaultProfile + nodePath.sep, alias]) {
      fx.setUserData(selected)
      assert.equal(
        fx.select('local').sessionData,
        join(fx.documents, 'scholarseed-desktop-session-local')
      )
    }
  } finally {
    fx.cleanup()
  }
})

test('profile classification does not bypass pointer-directory alias admission', () => {
  const fx = fixture()
  try {
    const defaultProfile = join(fx.documents, 'ScholarSeed')
    const alias = join(fx.documents, 'profile-alias')
    mkdirSync(defaultProfile)
    symlinkSync(defaultProfile, alias, process.platform === 'win32' ? 'junction' : 'dir')
    fx.setUserData(alias)
    assert.throws(() => fx.select('local'), { code: 'ERR_STORAGE_CONFIG' })
  } finally {
    fx.cleanup()
  }
})

for (const packaged of [false, true]) {
  for (const explicit of [false, true]) {
    test(`startup directories remain fixed: packaged=${packaged}, explicit=${explicit}`, () => {
      const fx = fixture()
      try {
        fx.setPacked(packaged)
        fx.setEnv(join(fx.userData, 'home'))
        fx.env.SCHOLARSEED_REPO = join(fx.userData, 'repo')
        if (explicit) fx.env.SCHOLARSEED_DEFAULT_WORKSPACE = join(fx.documents, 'chosen')
        const selected = (
          fx.start as (namespace: string) => {
            sessionData: string
            workspace: string
            createWorkspace: boolean
            legacyHome: string | null
          }
        )('local')
        assert.equal(selected.sessionData, join(fx.userData, 'scholarseed-desktop-session-local'))
        assert.equal(
          selected.workspace,
          explicit
            ? join(fx.documents, 'chosen')
            : packaged
              ? join(fx.userData, 'Projects')
              : join(fx.userData, 'repo', 'tmp', 'desktop-workspace')
        )
        assert.equal(selected.createWorkspace, !explicit)
        assert.equal(selected.legacyHome, packaged ? join(fx.userData, '.veda') : null)
        assert.equal(existsSync(selected.workspace), false, 'selection must not create workspace')
        fx.env.SCHOLARSEED_DEFAULT_WORKSPACE = join(fx.documents, 'later')
        fx.env.SCHOLARSEED_REPO = join(fx.documents, 'later-repo')
        fx.setUserData(join(fx.documents, 'later-profile'))
        assert.equal((fx.mod.desktopStorage as () => unknown)(), selected)
        assert.equal(Object.isFrozen(selected), true)
      } finally {
        fx.cleanup()
      }
    })
  }
}

test('pointer publication replaces the file without truncating an existing reader inode', () => {
  const fx = fixture()
  try {
    const write = fx.mod.writeStorageConfig as (home: string) => void
    const old = join(fx.userData, 'old-home')
    const next = join(fx.userData, 'new-home')
    write(old)
    const pointer = join(fx.userData, 'storage-config.json')
    const retained = join(fx.userData, 'retained.json')
    linkSync(pointer, retained)
    write(next)
    assert.equal(JSON.parse(readFileSync(pointer, 'utf8')).dataHome, next)
    assert.equal(JSON.parse(readFileSync(retained, 'utf8')).dataHome, old)
    assert.deepEqual(readdirSync(fx.userData).sort(), ['retained.json', 'storage-config.json'])
  } finally {
    fx.cleanup()
  }
})

for (const code of ['EACCES', 'EIO', 'ENOENT']) {
  test(`a known existing pointer whose read fails with ${code} does not default`, () => {
    const failure = Object.assign(new Error(code), { code })
    const fx = fixture(undefined, failure)
    try {
      const pointer = join(fx.userData, 'storage-config.json')
      writeFileSync(pointer, JSON.stringify({ schemaVersion: 1, dataHome: fx.documents }))
      assert.throws(
        () => (fx.start as (namespace: string) => unknown)('local'),
        (error: { code?: string; cause?: unknown }) =>
          error.code === 'ERR_STORAGE_CONFIG' && error.cause === failure
      )
      assert.equal(fx.env.SCHOLARSEED_HOME, undefined)
    } finally {
      fx.cleanup()
    }
  })
}

test('incomplete UNC and Windows device namespaces cannot select a storage root', () => {
  const fx = fixture()
  try {
    const valid = fx.mod.isValidAbsoluteRoot as (value: string, platform: string) => boolean
    for (const value of [
      '\\\\',
      '\\\\server',
      '\\\\server\\',
      '\\\\?\\C:\\home',
      '\\\\.\\C:\\home',
    ]) {
      assert.equal(valid(value, 'win32'), false, value)
    }
    assert.equal(valid(String.raw`\\server\share`, 'win32'), true)
    assert.equal(valid(String.raw`\\server\share\home`, 'win32'), true)
  } finally {
    fx.cleanup()
  }
})

test('selection stays immutable and unpublished until the startup owner publishes it', () => {
  const fx = fixture()
  try {
    fx.setHomedir(fx.documents)
    fx.setPacked(true)
    const selected = fx.select('local')
    assert.equal(Object.isFrozen(selected), true)
    assert.equal(fx.env.SCHOLARSEED_HOME, undefined)
    assert.throws(() => (fx.mod.desktopHome as () => string)(), /must be initialized/)
    assert.throws(() => (fx.mod.desktopStorage as () => unknown)(), /must be initialized/)
    assert.deepEqual(readdirSync(fx.userData), [])
    assert.deepEqual(readdirSync(fx.documents), [])
    assert.equal(selected.firstLaunchEligible, true)
    // Preparing structure must not retroactively change the selected first-run eligibility.
    mkdirSync(selected.home)
    writeFileSync(join(selected.home, 'prepared'), 'owned preparation')
    assert.equal(fx.publish(selected), selected)
    assert.equal(fx.env.SCHOLARSEED_HOME, selected.home)
    assert.equal((fx.mod.desktopStorage as () => unknown)(), selected)
    assert.equal(selected.firstLaunchEligible, true)
    assert.throws(() => fx.publish(selected), /already initialized/)
    assert.throws(() => fx.select('other'), /already initialized/)
  } finally {
    fx.cleanup()
  }
})

test('reselection invalidates the old object and rejects copies of the current selection', () => {
  const fx = fixture()
  try {
    fx.setEnv(join(fx.documents, 'first'))
    const first = fx.select('local')
    fx.setEnv(join(fx.documents, 'second'))
    const second = fx.select('local')
    assert.throws(() => fx.publish(first), /no longer current/)
    assert.throws(() => fx.publish({ ...second }), /no longer current/)
    assert.throws(
      () => fx.publish({ ...second, home: join(fx.documents, 'forged') }),
      /no longer current/
    )
    assert.equal(fx.publish(second), second)
    assert.equal((fx.mod.desktopHome as () => string)(), second.home)
  } finally {
    fx.cleanup()
  }
})

test('a failed reselection invalidates the prior unpublished selection', () => {
  const fx = fixture()
  try {
    fx.setHomedir(fx.documents)
    const first = fx.select('local')
    writeFileSync(join(fx.userData, 'storage-config.json'), '{broken')
    assert.throws(() => fx.select('local'), { code: 'ERR_STORAGE_CONFIG' })
    assert.throws(() => fx.publish(first), /no longer current/)
    assert.equal(fx.env.SCHOLARSEED_HOME, undefined)
    assert.throws(() => (fx.mod.desktopStorage as () => unknown)(), /must be initialized/)
    assert.equal(readFileSync(join(fx.userData, 'storage-config.json'), 'utf8'), '{broken')
  } finally {
    fx.cleanup()
  }
})

for (const wroteBeforeThrow of [false, true]) {
  test(`failed env publication consumes selection without publishing startup: written=${wroteBeforeThrow}`, () => {
    const fx = fixture()
    try {
      fx.setHomedir(fx.documents)
      const selected = fx.select('local')
      let observed: string | undefined
      Object.defineProperty(fx.env, 'SCHOLARSEED_HOME', {
        configurable: true,
        get: () => observed,
        set(value: string) {
          if (wroteBeforeThrow) observed = value
          throw new Error('environment publication failed')
        },
      })
      assert.throws(() => fx.publish(selected), /environment publication failed/)
      assert.throws(() => fx.publish(selected), /no longer current/)
      assert.throws(() => (fx.mod.desktopHome as () => string)(), /must be initialized/)
      assert.throws(() => (fx.mod.desktopStorage as () => unknown)(), /must be initialized/)
      assert.equal(observed, wroteBeforeThrow ? selected.home : undefined)
      assert.deepEqual(readdirSync(fx.documents), [])
    } finally {
      fx.cleanup()
    }
  })
}

for (const scenario of ['read', 'read-close', 'release', 'read-and-release'] as const) {
  test(`native pointer failure never publishes a candidate: ${scenario}`, () => {
    const fx = fixture()
    const events: string[] = []
    const error = Object.assign(new Error('native read failed'), {
      code: scenario === 'read-close' ? 'ERR_LEASE_RELEASE' : 'ERR_LEASE_READ',
    })
    try {
      fx.native.pin = () => {
        events.push('pin')
        return {}
      }
      fx.native.readAt = () => {
        events.push('read')
        if (scenario !== 'release') throw error
        return Buffer.from(JSON.stringify({ schemaVersion: 1, dataHome: fx.documents }))
      }
      fx.native.release = () => {
        events.push('release')
        if (scenario === 'release' || scenario === 'read-and-release')
          throw Object.assign(new Error('release failed'), { code: 'ERR_LEASE_RELEASE' })
      }
      assert.throws(() => fx.select('local'), { code: 'ERR_STORAGE_CONFIG' })
      assert.deepEqual(
        events,
        scenario === 'read-close' ? ['pin', 'read'] : ['pin', 'read', 'release']
      )
      assert.equal(fx.env.SCHOLARSEED_HOME, undefined)
      assert.throws(() => (fx.mod.desktopStorage as () => unknown)(), /must be initialized/)
    } finally {
      fx.cleanup()
    }
  })
}

test('pointer parser rejects invalid UTF-8 and oversized bytes, and freezes valid observations', () => {
  const fx = fixture()
  try {
    const parse = fx.mod.parseStorageConfig as (
      bytes: Buffer | null,
      path: string
    ) => { dataHome: string } | null
    const filename = join(fx.userData, 'storage-config.json')
    assert.equal(parse(null, filename), null)
    assert.throws(() => parse(Buffer.from([0xc0, 0xaf]), filename), { code: 'ERR_STORAGE_CONFIG' })
    assert.throws(() => parse(Buffer.alloc(65537, 32), filename), { code: 'ERR_STORAGE_CONFIG' })
    const value = parse(
      Buffer.from(JSON.stringify({ schemaVersion: 1, dataHome: fx.documents })),
      filename
    )
    assert.equal(value?.dataHome, fx.documents)
    assert.ok(Object.isFrozen(value))
  } finally {
    fx.cleanup()
  }
})

for (const reason of [
  'unpublished',
  'development',
  'configured',
  'existing data',
  'pointer appeared',
]) {
  test(`data home commit refuses ${reason} without creating a target`, () => {
    const fx = fixture()
    const root = mkdtempSync(join(tmpdir(), 'ss-choice-gate-'))
    try {
      fx.setHomedir(root)
      fx.setPacked(reason !== 'development')
      if (reason === 'configured') fx.setEnv(join(root, 'configured'))
      if (reason === 'existing data') {
        mkdirSync(join(root, '.scholarseed'))
        writeFileSync(join(root, '.scholarseed', 'sentinel'), 'preserve')
      }
      if (reason !== 'unpublished') fx.start('local')
      if (reason === 'pointer appeared')
        writeFileSync(
          join(fx.userData, 'storage-config.json'),
          JSON.stringify({ schemaVersion: 1, dataHome: root })
        )
      const before = readdirSync(fx.documents)
      const result = (
        fx.mod.commitDataHome as (
          parent: string,
          platform: NodeJS.Platform,
          native: StorageNative
        ) => { ok: boolean; reason?: string }
      )(fx.documents, 'darwin', fx.native)
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'unsupported')
      assert.deepEqual(readdirSync(fx.documents), before)
    } finally {
      fx.cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test(
  'pointer publication failure consumes the in-process choice even if its file disappears',
  { skip: process.platform === 'win32' },
  () => {
    const fx = fixture(undefined, undefined, () => {
      throw new Error('injected after publish')
    })
    const root = mkdtempSync(join(tmpdir(), 'ss-choice-failed-'))
    try {
      fx.setHomedir(root)
      fx.setPacked(true)
      fx.start('local')
      const commit = fx.mod.commitDataHome as (
        parent: string,
        platform: NodeJS.Platform,
        native: StorageNative
      ) => { ok: boolean; reason?: string }
      assert.throws(
        () => commit(fx.documents, process.platform, fx.native),
        /injected after publish/
      )
      rmSync(join(fx.userData, 'storage-config.json'))
      assert.equal(commit(root, process.platform, fx.native).reason, 'unsupported')
      assert.equal(existsSync(join(root, '.scholarseed')), false)
    } finally {
      fx.cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'successful choice is single-use while invalid input preserves the opportunity',
  { skip: process.platform === 'win32' },
  () => {
    const fx = fixture()
    const root = mkdtempSync(join(tmpdir(), 'ss-choice-once-'))
    try {
      fx.setHomedir(root)
      fx.setPacked(true)
      fx.start('local')
      const commit = fx.mod.commitDataHome as (
        parent: string,
        platform: NodeJS.Platform
      ) => { ok: boolean; reason?: string }
      const available = fx.mod.canCommitDataHome as (native: StorageNative) => boolean
      assert.equal(commit('relative', process.platform).reason, 'invalid_shape')
      assert.equal(available(fx.native), true)
      assert.equal(commit(fx.documents, process.platform).ok, true)
      rmSync(join(fx.userData, 'storage-config.json'))
      assert.equal(available(fx.native), false)
      assert.equal(commit(root, process.platform).reason, 'unsupported')
      assert.equal(existsSync(join(root, '.scholarseed')), false)
    } finally {
      fx.cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test('coordination root remains bound to the OS account across product home choices', () => {
  const fx = fixture()
  try {
    const select = fx.mod.coordinationRoot as () => string
    const expected = join(userInfo().homedir, '.scholarseed-coordination')
    assert.equal(select(), expected)
    fx.setHomedir(join(fx.documents, 'different-environment-home'))
    fx.setEnv(join(fx.documents, 'different-product-home'))
    fx.setUserData(join(fx.documents, 'different-profile'))
    assert.equal(select(), expected)
    assert.deepEqual(readdirSync(fx.documents), [])
  } finally {
    fx.cleanup()
  }
})

for (const platform of ['darwin', 'win32'] as const) {
  for (const variable of ['SCHOLARSEED_HOME', 'SCHOLARSEED_DEFAULT_WORKSPACE']) {
    for (const value of ['relative/data', 'C:relative', '\\root-relative', 'bad\0root']) {
      test(`invalid explicit root is rejected before publication: ${platform}/${variable}/${JSON.stringify(value)}`, () => {
        const fx = fixture()
        try {
          fx.setPlatform(platform)
          const valid = platform === 'win32' ? 'C:\\data\\home' : '/data/home'
          fx.setEnv(valid)
          const previous = fx.select('local')
          fx.env[variable] = value
          assert.throws(
            () => fx.select('local'),
            new RegExp(`${variable} must be an absolute supported root`)
          )
          assert.throws(() => fx.publish(previous), /no longer current/)
          assert.throws(() => (fx.mod.desktopStorage as () => unknown)(), /must be initialized/)
          assert.equal(fx.env[variable], value)
          assert.equal(fx.pointerReads(), 0)
          assert.deepEqual(readdirSync(fx.userData), [])
          assert.deepEqual(readdirSync(fx.documents), [])
        } finally {
          fx.cleanup()
        }
      })
    }
  }
  for (const value of platform === 'win32'
    ? ['D:\\data\\home', '\\\\server\\share\\home']
    : ['/data/home']) {
    test(`valid explicit roots preserve the selection: ${platform}/${value}`, () => {
      const fx = fixture()
      try {
        fx.setPlatform(platform)
        fx.setEnv(value)
        fx.env.SCHOLARSEED_DEFAULT_WORKSPACE = value
        const selected = fx.select('local')
        assert.equal(selected.home, value)
        assert.equal(selected.workspace, value)
        assert.equal(selected.createWorkspace, false)
        assert.equal(fx.publish(selected), selected)
      } finally {
        fx.cleanup()
      }
    })
  }
}
