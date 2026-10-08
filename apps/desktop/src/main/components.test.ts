import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'crypto'
import {
  cpSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  defaultBytecodeWarm,
  defaultProbe,
  ensureComponents,
  persistComponentLog,
  sweepStaleStaging,
  sweepUnreferencedComponents,
  windowsTarExecutable,
} from './components.ts'
import type { ComponentBytecodeWarm, ComponentExtractor, ComponentProbe } from './components.ts'

const TARGET = 'win32-x86_64'
const PYTHON_CONTENT_ID = 'a1'.repeat(32)
const TEXLIVE_CONTENT_ID = 'b2'.repeat(32)
const POWERSHELL_CONTENT_ID = 'e5'.repeat(32)
const PYTHON_ARCHIVE_SHA = 'c3'.repeat(32)
const TEXLIVE_ARCHIVE_SHA = 'd4'.repeat(32)

interface Fixture {
  root: string
  backendDirectory: string
  storeRoot: string
  extractCalls: string[]
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'scholarseed-components-'))
  const backendDirectory = join(root, 'backend')
  mkdirSync(join(backendDirectory, 'components'), { recursive: true })
  // “归档”是测试替身：内容任意，extractor 按名字取预置树拷贝。
  writeFileSync(
    join(backendDirectory, 'components', `python-${PYTHON_CONTENT_ID}.zip`),
    'python-archive'
  )
  writeFileSync(
    join(backendDirectory, 'components', `texlive-${TEXLIVE_CONTENT_ID}.zip`),
    'texlive-archive'
  )
  writeFileSync(
    join(backendDirectory, 'components', `powershell-${POWERSHELL_CONTENT_ID}.zip`),
    'powershell-archive'
  )
  writeFileSync(
    join(backendDirectory, 'components', 'app-components.json'),
    JSON.stringify({
      schemaVersion: 1,
      target: TARGET,
      components: [
        {
          kind: 'python',
          contentId: PYTHON_CONTENT_ID,
          archive: `python-${PYTHON_CONTENT_ID}.zip`,
          archiveSha256: sha256Of('python-archive'),
          archiveBytes: 14,
          entry: 'python/python.exe',
        },
        {
          kind: 'texlive',
          contentId: TEXLIVE_CONTENT_ID,
          archive: `texlive-${TEXLIVE_CONTENT_ID}.zip`,
          archiveSha256: sha256Of('texlive-archive'),
          archiveBytes: 14,
          entry: 'texlive/bin/windows',
          executables: ['xelatex', 'pdflatex'],
        },
        {
          kind: 'powershell',
          contentId: POWERSHELL_CONTENT_ID,
          archive: `powershell-${POWERSHELL_CONTENT_ID}.zip`,
          archiveSha256: sha256Of('powershell-archive'),
          archiveBytes: 18,
          entry: 'powershell/pwsh.exe',
          version: '7.6.6',
        },
      ],
    })
  )
  return { root, backendDirectory, storeRoot: join(root, 'runtime'), extractCalls: [] }
}

function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 替身解压器：按归档名在 staging 里造出对应组件树。 */
function fakeExtractor(
  fixture: Fixture,
  options: { failArchiveSha?: boolean } = {}
): ComponentExtractor {
  return async (archive, destination) => {
    fixture.extractCalls.push(archive)
    if (archive.includes('python')) {
      mkdirSync(join(destination, 'python'), { recursive: true })
      writeFileSync(join(destination, 'python', 'python.exe'), 'MZ')
    } else if (archive.includes('texlive')) {
      mkdirSync(join(destination, 'texlive', 'bin', 'windows'), { recursive: true })
      writeFileSync(join(destination, 'texlive', 'bin', 'windows', 'xelatex.exe'), 'MZ')
      writeFileSync(join(destination, 'texlive', 'bin', 'windows', 'pdflatex.exe'), 'MZ')
    } else {
      mkdirSync(join(destination, 'powershell'), { recursive: true })
      writeFileSync(join(destination, 'powershell', 'pwsh.exe'), 'MZ')
    }
    if (options.failArchiveSha) writeFileSync(join(destination, 'tamper.txt'), 'x')
  }
}

const passingProbe: ComponentProbe = async () => {}

function texliveEnginesMissingProbe(): ComponentProbe {
  return async (component, directory) => {
    if (component.kind !== 'texlive') return
    const entry = join(directory, ...component.entry.split('/'))
    for (const executable of component.executables ?? []) {
      if (!existsSync(join(entry, `${executable}.exe`)))
        throw new Error(`engine missing: ${executable}`)
    }
  }
}

test('首次 provision 发布三个组件并解析出入口路径', async (t) => {
  const fx = fixture()
  t.after(() => rmSync(fx.root, { recursive: true, force: true }))
  const result = await ensureComponents({
    backendDirectory: fx.backendDirectory,
    storeRoot: fx.storeRoot,
    log: () => {},
    extractor: fakeExtractor(fx),
    probe: passingProbe,
  })
  assert.equal(
    result.pythonExecutable,
    join(fx.storeRoot, 'python', `${TARGET}-${PYTHON_CONTENT_ID}`, 'python', 'python.exe')
  )
  assert.equal(
    result.texliveBinDirectory,
    join(fx.storeRoot, 'texlive', `${TARGET}-${TEXLIVE_CONTENT_ID}`, 'texlive', 'bin', 'windows')
  )
  assert.equal(
    result.powershellBinDirectory,
    join(fx.storeRoot, 'powershell', `${TARGET}-${POWERSHELL_CONTENT_ID}`, 'powershell')
  )
  assert.equal(fx.extractCalls.length, 3)
  // store 清单是命中的唯一凭据
  const manifest = JSON.parse(
    readFileSync(join(fx.storeRoot, 'manifests', `${PYTHON_CONTENT_ID}.json`), 'utf8')
  )
  assert.equal(manifest.kind, 'python')
  assert.equal(typeof manifest.publishedAt, 'number')
  // staging 已清空、锁已释放
  assert.deepEqual(
    existsSync(join(fx.storeRoot, 'staging')) ? readDirNames(join(fx.storeRoot, 'staging')) : [],
    []
  )
  assert.deepEqual(
    existsSync(join(fx.storeRoot, 'locks')) ? readDirNames(join(fx.storeRoot, 'locks')) : [],
    []
  )
})

function readDirNames(directory: string): string[] {
  return readdirSync(directory)
}

test('冷发布对 python 树预热字节码；命中路径不预热且 coldProvisioned=false', async (t) => {
  const fx = fixture()
  t.after(() => rmSync(fx.root, { recursive: true, force: true }))
  const warmCalls: Array<{ kind: string; directory: string }> = []
  const warm: ComponentBytecodeWarm = async (component, directory) => {
    warmCalls.push({ kind: component.kind, directory })
  }
  const logs: string[] = []
  const options = {
    backendDirectory: fx.backendDirectory,
    storeRoot: fx.storeRoot,
    log: (line: string) => logs.push(line),
    extractor: fakeExtractor(fx),
    probe: passingProbe,
    bytecodeWarm: warm,
  }
  const first = await ensureComponents(options)
  assert.equal(first.coldProvisioned, true)
  // 只预热 python，且作用于最终发布目录（树内 __pycache__）
  assert.deepEqual(warmCalls, [
    {
      kind: 'python',
      directory: join(fx.storeRoot, 'python', `${TARGET}-${PYTHON_CONTENT_ID}`),
    },
  ])
  assert.ok(logs.some((line) => line.includes('bytecode warm ')))
  const second = await ensureComponents(options)
  assert.equal(second.coldProvisioned, false)
  assert.equal(warmCalls.length, 1)
})

test('字节码预热失败只降级为慢启动：发布与 provision 仍成功', async (t) => {
  const fx = fixture()
  t.after(() => rmSync(fx.root, { recursive: true, force: true }))
  const logs: string[] = []
  const failing: ComponentBytecodeWarm = async (component) => {
    if (component.kind === 'python') throw new Error('compileall exploded')
  }
  const result = await ensureComponents({
    backendDirectory: fx.backendDirectory,
    storeRoot: fx.storeRoot,
    log: (line: string) => logs.push(line),
    extractor: fakeExtractor(fx),
    probe: passingProbe,
    bytecodeWarm: failing,
  })
  assert.ok(existsSync(join(fx.storeRoot, 'manifests', `${PYTHON_CONTENT_ID}.json`)))
  assert.ok(
    logs.some(
      (line) => line.includes('bytecode warm failed') && line.includes('compileall exploded')
    )
  )
  assert.equal(result.coldProvisioned, true)
})

test('默认预热对非 python 组件与缺 Lib 的树直接跳过', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'scholarseed-warm-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const warm = defaultBytecodeWarm()
  await warm(
    {
      kind: 'texlive',
      contentId: TEXLIVE_CONTENT_ID,
      archive: 'texlive.zip',
      archiveSha256: 'x',
      archiveBytes: 1,
      entry: 'texlive/bin/windows',
    },
    root
  )
  await warm(
    {
      kind: 'python',
      contentId: PYTHON_CONTENT_ID,
      archive: 'python.zip',
      archiveSha256: 'x',
      archiveBytes: 1,
      entry: 'python/python.exe',
    },
    root
  )
})

test('命中路径零展开：第二次 ensure 不再调用解压器', async (t) => {
  const fx = fixture()
  t.after(() => rmSync(fx.root, { recursive: true, force: true }))
  const extractor = fakeExtractor(fx)
  const options = {
    backendDirectory: fx.backendDirectory,
    storeRoot: fx.storeRoot,
    log: () => {},
    extractor,
    probe: passingProbe,
  }
  await ensureComponents(options)
  const callsAfterFirst = fx.extractCalls.length
  await ensureComponents(options)
  assert.equal(fx.extractCalls.length, callsAfterFirst)
})

test('跨构建重打包（archiveSha256 变、contentId 不变）必须仍命中，不重解压', async (t) => {
  // 真机 texlive be79 每个新构建重展开 7s 的根因回归闸：归档字节不承诺跨构建稳定，
  // 命中比较只认内容身份（kind/contentId/entry）+ 目录/入口存在；archiveSha256 进比较会把
  // 内容相同的组件每构建误判 miss。用第二个 backend 目录模拟「新构建」（manifest 缓存按
  // backendDirectory 键控），仅改 archiveSha256 与归档字节。
  const fx = fixture()
  t.after(() => rmSync(fx.root, { recursive: true, force: true }))
  const extractor = fakeExtractor(fx)
  await ensureComponents({
    backendDirectory: fx.backendDirectory,
    storeRoot: fx.storeRoot,
    log: () => {},
    extractor,
    probe: passingProbe,
  })
  const callsAfterFirst = fx.extractCalls.length
  const rebuild = join(fx.root, 'backend-rebuild')
  cpSync(fx.backendDirectory, rebuild, { recursive: true })
  const manifestPath = join(rebuild, 'components', 'app-components.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    components: Array<Record<string, unknown>>
  }
  for (const component of manifest.components) {
    component.archiveSha256 = sha256Of(`repacked-${String(component.kind)}`)
  }
  writeFileSync(manifestPath, JSON.stringify(manifest))
  writeFileSync(
    join(rebuild, 'components', `texlive-${TEXLIVE_CONTENT_ID}.zip`),
    'texlive-archive-repacked'
  )
  writeFileSync(
    join(rebuild, 'components', `python-${PYTHON_CONTENT_ID}.zip`),
    'python-archive-repacked'
  )
  writeFileSync(
    join(rebuild, 'components', `powershell-${POWERSHELL_CONTENT_ID}.zip`),
    'powershell-archive-repacked'
  )
  await ensureComponents({
    backendDirectory: rebuild,
    storeRoot: fx.storeRoot,
    log: () => {},
    extractor,
    probe: passingProbe,
  })
  assert.equal(fx.extractCalls.length, callsAfterFirst)
})

test('发布目录损坏（入口丢失）触发修复重展开，绝不带病命中', async (t) => {
  const fx = fixture()
  t.after(() => rmSync(fx.root, { recursive: true, force: true }))
  const extractor = fakeExtractor(fx)
  const options = {
    backendDirectory: fx.backendDirectory,
    storeRoot: fx.storeRoot,
    log: () => {},
    extractor,
    probe: passingProbe,
  }
  await ensureComponents(options)
  rmSync(join(fx.storeRoot, 'python', `${TARGET}-${PYTHON_CONTENT_ID}`, 'python', 'python.exe'))
  await ensureComponents(options)
  assert.equal(fx.extractCalls.filter((archive) => archive.includes('python')).length, 2)
  assert.ok(
    existsSync(
      join(fx.storeRoot, 'python', `${TARGET}-${PYTHON_CONTENT_ID}`, 'python', 'python.exe')
    )
  )
})

test('归档 SHA-256 与清单不符：fail-closed，不发布任何内容', async (t) => {
  const fx = fixture()
  t.after(() => rmSync(fx.root, { recursive: true, force: true }))
  writeFileSync(
    join(fx.backendDirectory, 'components', `python-${PYTHON_CONTENT_ID}.zip`),
    'tampered-archive'
  )
  await assert.rejects(
    ensureComponents({
      backendDirectory: fx.backendDirectory,
      storeRoot: fx.storeRoot,
      log: () => {},
      extractor: fakeExtractor(fx),
      probe: passingProbe,
    }),
    /SHA-256 differs/
  )
  assert.equal(existsSync(join(fx.storeRoot, 'manifests', `${PYTHON_CONTENT_ID}.json`)), false)
})

test('运行探测失败：staging 被回收，不发布', async (t) => {
  const fx = fixture()
  t.after(() => rmSync(fx.root, { recursive: true, force: true }))
  const failing: ComponentProbe = async (component) => {
    if (component.kind === 'texlive') throw new Error('probe rejected component')
  }
  await assert.rejects(
    ensureComponents({
      backendDirectory: fx.backendDirectory,
      storeRoot: fx.storeRoot,
      log: () => {},
      extractor: fakeExtractor(fx),
      probe: failing,
    }),
    /probe rejected/
  )
  assert.equal(existsSync(join(fx.storeRoot, 'texlive', `${TARGET}-${TEXLIVE_CONTENT_ID}`)), false)
})

test('引擎探测（默认探针的 texlive 分支）拒绝缺引擎的树', async (t) => {
  const fx = fixture()
  t.after(() => rmSync(fx.root, { recursive: true, force: true }))
  const extractor: ComponentExtractor = async (archive, destination) => {
    if (archive.includes('python')) {
      mkdirSync(join(destination, 'python'), { recursive: true })
      writeFileSync(join(destination, 'python', 'python.exe'), 'MZ')
    } else if (archive.includes('texlive')) {
      // 只放一个引擎，缺 pdflatex
      mkdirSync(join(destination, 'texlive', 'bin', 'windows'), { recursive: true })
      writeFileSync(join(destination, 'texlive', 'bin', 'windows', 'xelatex.exe'), 'MZ')
    } else {
      mkdirSync(join(destination, 'powershell'), { recursive: true })
      writeFileSync(join(destination, 'powershell', 'pwsh.exe'), 'MZ')
    }
  }
  await assert.rejects(
    ensureComponents({
      backendDirectory: fx.backendDirectory,
      storeRoot: fx.storeRoot,
      log: () => {},
      extractor,
      probe: texliveEnginesMissingProbe(),
    }),
    /engine missing/
  )
})

test('PowerShell 默认探针只使用 ASCII 版本输出，避免本地代码页阻断启动', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'scholarseed-powershell-probe-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const tree = join(root, 'powershell')
  mkdirSync(tree)
  const executable = join(tree, 'pwsh.exe')
  writeFileSync(executable, '#!/bin/sh\nprintf "7.6.6\\n"\n')
  chmodSync(executable, 0o755)
  await defaultProbe()(
    {
      kind: 'powershell',
      contentId: POWERSHELL_CONTENT_ID,
      archive: `powershell-${POWERSHELL_CONTENT_ID}.zip`,
      archiveSha256: sha256Of('powershell-archive'),
      archiveBytes: 18,
      entry: 'powershell/pwsh.exe',
      version: '7.6.6',
    },
    root
  )
  writeFileSync(executable, '#!/bin/sh\nprintf "7.6.5\\n"\n')
  await assert.rejects(
    defaultProbe()(
      {
        kind: 'powershell',
        contentId: POWERSHELL_CONTENT_ID,
        archive: `powershell-${POWERSHELL_CONTENT_ID}.zip`,
        archiveSha256: sha256Of('powershell-archive'),
        archiveBytes: 18,
        entry: 'powershell/pwsh.exe',
        version: '7.6.6',
      },
      root
    ),
    /PowerShell probe mismatch/
  )
})

test('陈旧 staging 被清扫；未超龄的保留', async (t) => {
  const fx = fixture()
  t.after(() => rmSync(fx.root, { recursive: true, force: true }))
  const staging = join(fx.storeRoot, 'staging')
  mkdirSync(join(staging, 'old-directory'), { recursive: true })
  const hour = 60 * 60 * 1000
  // 假时钟拨到 7 小时后：真实 mtime 的目录即「超龄」，应被清扫
  sweepStaleStaging(
    fx.storeRoot,
    () => Date.now() + 7 * hour,
    () => {}
  )
  assert.equal(existsSync(join(staging, 'old-directory')), false)
  // 真时钟下新建目录不超龄：保留
  mkdirSync(join(staging, 'kept-directory'), { recursive: true })
  sweepStaleStaging(
    fx.storeRoot,
    () => Date.now(),
    () => {}
  )
  assert.equal(existsSync(join(staging, 'kept-directory')), true)
})

test('锁被其它实例持有且组件已发布：等待路径直接命中', async (t) => {
  const fx = fixture()
  t.after(() => rmSync(fx.root, { recursive: true, force: true }))
  const extractor = fakeExtractor(fx)
  const options = {
    backendDirectory: fx.backendDirectory,
    storeRoot: fx.storeRoot,
    log: () => {},
    extractor,
    probe: passingProbe,
  }
  await ensureComponents(options)
  mkdirSync(join(fx.storeRoot, 'locks'), { recursive: true })
  writeFileSync(
    join(fx.storeRoot, 'locks', `${PYTHON_CONTENT_ID}.lock`),
    `${JSON.stringify({ pid: 999999, at: Date.now() })}\n`
  )
  const calls = fx.extractCalls.length
  await ensureComponents(options)
  assert.equal(fx.extractCalls.length, calls)
  // 别人持有的新鲜锁不得被删
  assert.ok(existsSync(join(fx.storeRoot, 'locks', `${PYTHON_CONTENT_ID}.lock`)))
})

test('锁被持有且组件未发布：等到超时失败，而不是并发解压', async (t) => {
  const fx = fixture()
  t.after(() => rmSync(fx.root, { recursive: true, force: true }))
  mkdirSync(join(fx.storeRoot, 'locks'), { recursive: true })
  let virtual = 0
  writeFileSync(
    join(fx.storeRoot, 'locks', `${PYTHON_CONTENT_ID}.lock`),
    `${JSON.stringify({ pid: 999999, at: 0 })}\n`
  )
  const now = (): number => {
    virtual += 60_000
    return virtual
  }
  await assert.rejects(
    ensureComponents({
      backendDirectory: fx.backendDirectory,
      storeRoot: fx.storeRoot,
      log: () => {},
      extractor: fakeExtractor(fx),
      probe: passingProbe,
      now,
    }),
    /timed out waiting|not usable/
  )
  assert.equal(fx.extractCalls.length, 0)
})

test('陈旧锁（超过 30 分钟）被接管，provision 正常完成', async (t) => {
  const fx = fixture()
  t.after(() => rmSync(fx.root, { recursive: true, force: true }))
  mkdirSync(join(fx.storeRoot, 'locks'), { recursive: true })
  writeFileSync(
    join(fx.storeRoot, 'locks', `${PYTHON_CONTENT_ID}.lock`),
    `${JSON.stringify({ pid: 999999, at: Date.now() - 31 * 60 * 1000 })}\n`
  )
  const result = await ensureComponents({
    backendDirectory: fx.backendDirectory,
    storeRoot: fx.storeRoot,
    log: () => {},
    extractor: fakeExtractor(fx),
    probe: passingProbe,
  })
  assert.ok(result.pythonExecutable.endsWith('python.exe'))
})

test('未引用组件被 GC；被引用与被锁住的保留', async (t) => {
  const fx = fixture()
  t.after(() => rmSync(fx.root, { recursive: true, force: true }))
  await ensureComponents({
    backendDirectory: fx.backendDirectory,
    storeRoot: fx.storeRoot,
    log: () => {},
    extractor: fakeExtractor(fx),
    probe: passingProbe,
  })
  const orphanId = 'c7'.repeat(32)
  mkdirSync(join(fx.storeRoot, 'python', `${TARGET}-${orphanId}`), { recursive: true })
  writeFileSync(join(fx.storeRoot, 'manifests', `${orphanId}.json`), '{}')
  const lockedId = 'f6'.repeat(32)
  mkdirSync(join(fx.storeRoot, 'python', `${TARGET}-${lockedId}`), { recursive: true })
  mkdirSync(join(fx.storeRoot, 'locks'), { recursive: true })
  writeFileSync(
    join(fx.storeRoot, 'locks', `${lockedId}.lock`),
    `${JSON.stringify({ pid: 999999, at: Date.now() })}\n`
  )
  sweepUnreferencedComponents(
    fx.storeRoot,
    [PYTHON_CONTENT_ID, TEXLIVE_CONTENT_ID, POWERSHELL_CONTENT_ID, lockedId],
    () => {}
  )
  assert.equal(existsSync(join(fx.storeRoot, 'python', `${TARGET}-${orphanId}`)), false)
  assert.equal(existsSync(join(fx.storeRoot, 'manifests', `${orphanId}.json`)), false)
  assert.equal(existsSync(join(fx.storeRoot, 'python', `${TARGET}-${lockedId}`)), true)
  assert.equal(existsSync(join(fx.storeRoot, 'python', `${TARGET}-${PYTHON_CONTENT_ID}`)), true)
})

test('manifest 非法（缺 kind、entry 绝对路径、schema 不符）直接拒绝', async (t) => {
  const fx = fixture()
  t.after(() => rmSync(fx.root, { recursive: true, force: true }))
  writeFileSync(
    join(fx.backendDirectory, 'components', 'app-components.json'),
    '{"schemaVersion":2}'
  )
  await assert.rejects(
    ensureComponents({
      backendDirectory: fx.backendDirectory,
      storeRoot: fx.storeRoot,
      log: () => {},
      extractor: fakeExtractor(fx),
      probe: passingProbe,
    }),
    /manifest is unusable/
  )
})

test('windowsTarExecutable 锚定 System32 绝对路径，不吃 PATH', () => {
  assert.equal(
    windowsTarExecutable({ SystemRoot: 'D:\\Win' }),
    join('D:\\Win', 'System32', 'tar.exe')
  )
  assert.equal(windowsTarExecutable({}), join('C:\\Windows', 'System32', 'tar.exe'))
})

test('persistComponentLog 落盘可回读，写失败不抛', (t) => {
  const fx = fixture()
  t.after(() => rmSync(fx.root, { recursive: true, force: true }))
  const logs = join(fx.root, 'logs')
  persistComponentLog(logs, 'line-one\n')
  persistComponentLog(logs, 'line-two\n')
  assert.equal(readFileSync(join(logs, 'components.log'), 'utf8'), 'line-one\nline-two\n')
  persistComponentLog(
    join(fx.root, 'backend', 'components', 'app-components.json', 'not-a-dir'),
    'x'
  )
})
