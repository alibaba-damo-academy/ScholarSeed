// storage.test.ts — proposal 112 home 单根解析口的契约测试。
//
// 用与 tray.test.ts 同款的 runInNewContext + 注入 fake electron 模式：storage.ts 在 import 时
// 不冻结 home（每次调用现解析），故可在同一模块实例上改 process.env / 指针文件来验证优先级。
// 只创建隔离的临时 userData/documents/home 父目录，不碰真实 ~/.scholarseed。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import * as nodePath from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const storageSource = readFileSync(new URL('./storage.ts', import.meta.url), 'utf8')

interface Fixture {
  mod: Record<string, unknown>
  userData: string
  documents: string
  setEnv: (home: string | undefined) => void
  setPlatform: (platform: NodeJS.Platform) => void
  setExecPath: (execPath: string) => void
  setPacked: (packed: boolean) => void
  setHomedir: (dir: string) => void
  cleanup: () => void
}

function fixture(): Fixture {
  const userData = mkdtempSync(join(tmpdir(), 'ss-userdata-'))
  const documents = mkdtempSync(join(tmpdir(), 'ss-documents-'))
  const env: Record<string, string | undefined> = {}
  let packed = false
  let homeDir = homedir()
  const processStub = { env, platform: 'darwin' as NodeJS.Platform, execPath: '/Applications/ScholarSeed.app/Contents/MacOS/ScholarSeed' }
  const exports: Record<string, unknown> = {}
  runInNewContext(
    ts.transpileModule(storageSource, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      exports,
      require: (name: string) => {
        if (name === 'electron') return { app: { getPath: (key: string) => (key === 'userData' ? userData : documents), get isPackaged() { return packed } } }
        if (name === 'fs') return { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync }
        if (name === 'os') return { homedir: () => homeDir }
        if (name === 'path') return nodePath
        throw new Error(`unexpected import: ${name}`)
      },
      process: processStub
    }
  )
  return {
    mod: exports,
    userData,
    documents,
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
    }
  }
}

test('resolveDataHome 优先级：显式 env > userData 指针 > 默认 ~/.scholarseed', () => {
  const fx = fixture()
  try {
    const resolveDataHome = fx.mod.resolveDataHome as () => string
    const writeStorageConfig = fx.mod.writeStorageConfig as (home: string) => void
    const defaultHome = join(homedir(), '.scholarseed')

    // 无 env 无指针 → 默认
    fx.setEnv(undefined)
    assert.equal(resolveDataHome(), defaultHome)

    // 指针存在 → 指针
    writeStorageConfig(join(fx.userData, '..', 'pointer-home'))
    assert.equal(resolveDataHome(), join(fx.userData, '..', 'pointer-home'))

    // env 存在 → env 最高（覆盖指针）
    fx.setEnv('/explicit/env/home')
    assert.equal(resolveDataHome(), '/explicit/env/home')
  } finally {
    fx.cleanup()
  }
})

test('readStorageConfig：缺失/损坏/schema 不符一律 null，合法回值', () => {
  const fx = fixture()
  try {
    const readStorageConfig = fx.mod.readStorageConfig as () => { schemaVersion: number; dataHome: string } | null
    assert.equal(readStorageConfig(), null, '缺失指针 → null')
    const configPath = join(fx.userData, 'storage-config.json')
    writeFileSync(configPath, '{ not json', 'utf8')
    assert.equal(readStorageConfig(), null, '损坏 JSON → null')
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 999, dataHome: '/x' }), 'utf8')
    assert.equal(readStorageConfig(), null, 'schema 版本不符 → null')
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, dataHome: '/good/home' }), 'utf8')
    const good = readStorageConfig()
    assert.equal(good?.schemaVersion, 1)
    assert.equal(good?.dataHome, '/good/home')
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
    const isValidAbsoluteRoot = fx.mod.isValidAbsoluteRoot as (value: string, platform: NodeJS.Platform) => boolean
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
  try {
    const validateDataParent = fx.mod.validateDataParent as (p: string, plat: NodeJS.Platform) => { ok: boolean; reason?: string; home?: string }
    const commitDataHome = fx.mod.commitDataHome as (p: string, plat: NodeJS.Platform) => { ok: boolean; reason?: string; home?: string; restartRequired?: boolean }
    const readStorageConfig = fx.mod.readStorageConfig as () => { dataHome: string } | null

    // 相对路径 → invalid_shape（darwin 认前导 /）
    const invalid = validateDataParent('relative/dir', 'darwin')
    assert.equal(invalid.ok, false)
    assert.equal(invalid.reason, 'invalid_shape')

    // 真实可写临时父目录 → ok + home = P/.scholarseed
    const parent = mkdtempSync(join(tmpdir(), 'ss-parent-'))
    try {
      const validated = validateDataParent(parent, 'darwin')
      assert.equal(validated.ok, true)
      assert.equal(validated.home, join(parent, '.scholarseed'))
      // 探测目录已清理，无残留
      assert.equal(existsSync(join(parent, '.scholarseed-write-probe')), false)

      const committed = commitDataHome(parent, 'darwin')
      assert.equal(committed.ok, true)
      assert.equal(committed.restartRequired, true)
      assert.equal(existsSync(join(parent, '.scholarseed')), true, 'commit 建出 home')
      assert.equal(readStorageConfig()?.dataHome, join(parent, '.scholarseed'), 'commit 写指针')
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  } finally {
    fx.cleanup()
  }
})

test('isFirstLaunchEligible：打包 ∧ 无 env ∧ 无指针 ∧ 默认 home 空（proposal 112 §6.C）', () => {
  const fx = fixture()
  const parent = mkdtempSync(join(tmpdir(), 'ss-home-parent-'))
  try {
    const isFirstLaunchEligible = fx.mod.isFirstLaunchEligible as () => boolean
    const writeStorageConfig = fx.mod.writeStorageConfig as (home: string) => void
    fx.setHomedir(parent)
    fx.setPacked(true)
    fx.setEnv(undefined)
    // 四条件全成立 → 引导
    assert.equal(isFirstLaunchEligible(), true)
    // 默认 home 已有用户数据 → 绝不引导（orphan 文献/会话）
    mkdirSync(join(parent, '.scholarseed', 'service'), { recursive: true })
    assert.equal(isFirstLaunchEligible(), false)
    rmSync(join(parent, '.scholarseed'), { recursive: true, force: true })
    // 显式 env（dev/CI/便携）→ 不引导
    fx.setEnv(join(parent, 'elsewhere'))
    assert.equal(isFirstLaunchEligible(), false)
    fx.setEnv(undefined)
    // 指针已存在（已消费过入口）→ 不引导
    writeStorageConfig(join(parent, '.scholarseed'))
    assert.equal(isFirstLaunchEligible(), false)
    rmSync(join(fx.userData, 'storage-config.json'), { force: true })
    // 非打包（dev）→ 不引导
    fx.setPacked(false)
    assert.equal(isFirstLaunchEligible(), false)
  } finally {
    rmSync(parent, { recursive: true, force: true })
    fx.cleanup()
  }
})
