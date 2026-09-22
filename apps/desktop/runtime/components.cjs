// Windows 版本化组件仓库的单一事实源（proposal 108 §7 / P2a）。
//
// 布局契约与 apps/serve/service/paths.py 的 runtime 契约互为镜像，两侧各有契约测试钉死
// 相对形状（`runtime/python/<target>-<contentId>/`、`runtime/texlive/...`、staging/manifests/locks）。
//
// 设计要点：
// - **组件 = 稳定依赖**。python 组件只含解释器 + uv.lock 锁定的第三方 site-packages；
//   产品代码（5 个本地 wheel）构建期解包进 `backend/pylibs`，运行期用 PYTHONPATH 注入。
//   否则每改一次后端 contentId 就变、组件永不命中（提案 §7.1 明令禁止）。
// - **contentId 是内容寻址**：由决定组件内容的冻结输入（python 归档 sha、requirements/lock sha、
//   vendor 归档 sha）派生，不由 zip 字节决定 —— 跨构建可复现，命中才有意义。
// - win32-only：macOS 载荷与解析保持现状（提案 §10）。
// - 运行期解压原语是 System32 的 bsdtar（`tar.exe`），绝对路径解析，避开 PATH 上
//   Git 自带 GNU tar 的 `C:` 路径歧义（AGENTS.md 跨平台硬约束）。

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const COMPONENT_SCHEMA_VERSION = 1
const RUNTIME_DIRNAME = 'runtime'
const STAGING_DIRNAME = 'staging'
const MANIFESTS_DIRNAME = 'manifests'
const LOCKS_DIRNAME = 'locks'
const COMPONENTS_DIRNAME = 'components'
const PYLIBS_DIRNAME = 'pylibs'
const APP_COMPONENTS_FILENAME = 'app-components.json'
const PYTHON_KIND = 'python'
const TEXLIVE_KIND = 'texlive'
const COMPONENT_KINDS = [PYTHON_KIND, TEXLIVE_KIND]
// 组件目录内保留归档顶层树名（python/、texlive/），entry 是相对组件根的入口路径。
const PYTHON_TREE_DIRNAME = 'python'
const TEXLIVE_TREE_DIRNAME = 'texlive'
const PYTHON_ENTRY_RELATIVE = `${PYTHON_TREE_DIRNAME}/python.exe`
const TEXLIVE_BIN_PARENT_RELATIVE = TEXLIVE_TREE_DIRNAME
const HOME_ENV = 'SCHOLARSEED_HOME'
const CONTENT_ID_PATTERN = /^[a-f0-9]{64}$/
const TARGET_PATTERN = /^[a-z0-9]+-[a-z0-9_]+$/
const SHA256_CHUNK_BYTES = 16 * 1024 * 1024

function componentTarget(platform, arch) {
  if (platform !== 'win32') throw new Error(`component store is win32-only, got ${platform}`)
  if (arch !== 'x64') throw new Error(`component store supports x64 only, got ${arch}`)
  return 'win32-x86_64'
}

function componentDirectoryName(kind, target, contentId) {
  if (!COMPONENT_KINDS.includes(kind)) throw new Error(`unknown component kind: ${kind}`)
  if (!TARGET_PATTERN.test(target)) throw new Error(`invalid component target: ${target}`)
  if (!CONTENT_ID_PATTERN.test(contentId)) throw new Error(`invalid component contentId: ${contentId}`)
  return path.join(kind, `${target}-${contentId}`)
}

function canonicalSha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value, sortedReplacer)).digest('hex')
}

function sortedReplacer(key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value).sort().reduce((accumulator, item) => {
      accumulator[item] = value[item]
      return accumulator
    }, {})
  }
  return value
}

/** python 组件内容标识：解释器归档 + 第三方依赖锁定输入的哈希。 */
function derivePythonContentId({ target, pythonArchiveSha256, requirementsSha256, lockSha256, binaryPackages }) {
  return canonicalSha256({
    kind: PYTHON_KIND,
    target,
    pythonArchiveSha256,
    requirementsSha256,
    lockSha256,
    binaryPackages: [...binaryPackages].sort()
  })
}

/** texlive 组件内容标识：审阅过的 vendor 归档哈希 + 版本。 */
function deriveTexliveContentId({ target, archiveSha256, texlive }) {
  return canonicalSha256({ kind: TEXLIVE_KIND, target, archiveSha256, texlive })
}

function componentArchiveName(kind, contentId) {
  return `${kind}-${contentId}.zip`
}

function sha256FileSync(file) {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(SHA256_CHUNK_BYTES)
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (read <= 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

/**
 * 把本地产品 wheel 解包进 backend/pylibs（构建期，win32 组件化路径）。
 * 只接受纯 Python wheel（Tag 以 -none-any 结尾）：编译型产物属于第三方依赖，
 * 归 python 组件的 site-packages，不允许混进按应用版本变化的 pylibs。
 * zipfile 成员名先做穿越断言，再交给 Python zipfile 的既有净化。
 */
function writeProductLibraries(runner, python, wheels, pylibsDirectory) {
  fs.mkdirSync(pylibsDirectory, { recursive: true })
  const script = [
    'import json, pathlib, sys, zipfile',
    'target = pathlib.Path(sys.argv[1])',
    'summary = []',
    'for wheel in sys.argv[2:]:',
    '    with zipfile.ZipFile(wheel) as archive:',
    '        names = archive.namelist()',
    '        if any(name.startswith("/") or ".." in name.replace("\\\\", "/").split("/") for name in names):',
    '            raise SystemExit(f"unsafe member path in {wheel}")',
    '        metas = [name for name in names if name.endswith(".dist-info/WHEEL")]',
    '        if len(metas) != 1:',
    '            raise SystemExit(f"expected one dist-info in {wheel}, got {metas}")',
    '        tags = [line.split(":", 1)[1].strip() for line in archive.read(metas[0]).decode("utf-8").splitlines() if line.startswith("Tag:")]',
    '        if not tags or not all(tag.endswith("-none-any") for tag in tags):',
    '            raise SystemExit(f"product wheel is not pure-python: {wheel} {tags}")',
    '        archive.extractall(target)',
    '        summary.append(metas[0].split("/")[0])',
    'print(json.dumps(summary))'
  ].join('\n')
  runner(python, ['-I', '-B', '-c', script, pylibsDirectory, ...wheels])
}

/**
 * 打一个组件 zip：bsdtar `--format zip`，保留归档顶层树名（python/、texlive/）。
 * 归档字节不承诺跨构建稳定（contentId 与 zip 字节无关）；archiveSha256 按包记录，
 * 供包内校验。
 */
function packComponentArchive(backendDirectory, treeDirectoryName, archivePath, tarExecutable) {
  const result = spawnSync(tarExecutable,
    ['--format', 'zip', '-cf', archivePath, '-C', backendDirectory, treeDirectoryName],
    { stdio: 'pipe' })
  if (result.error || result.status !== 0) {
    throw new Error(`component archive failed for ${treeDirectoryName}: ${result.stderr || result.error}`)
  }
}

function appComponentsManifest(target, components) {
  const manifest = { schemaVersion: COMPONENT_SCHEMA_VERSION, target, components }
  if (!validateAppComponents(manifest)) throw new Error('generated app-components manifest is invalid')
  return manifest
}

function validateAppComponents(value) {
  if (!value || typeof value !== 'object') return false
  if (value.schemaVersion !== COMPONENT_SCHEMA_VERSION) return false
  if (typeof value.target !== 'string' || !TARGET_PATTERN.test(value.target)) return false
  if (!Array.isArray(value.components) || value.components.length === 0) return false
  const kinds = new Set()
  for (const component of value.components) {
    if (!component || typeof component !== 'object') return false
    if (!COMPONENT_KINDS.includes(component.kind) || kinds.has(component.kind)) return false
    kinds.add(component.kind)
    if (!CONTENT_ID_PATTERN.test(component.contentId || '')) return false
    if (component.archive !== componentArchiveName(component.kind, component.contentId)) return false
    if (!CONTENT_ID_PATTERN.test(component.archiveSha256 || '')) return false
    if (!Number.isInteger(component.archiveBytes) || component.archiveBytes <= 0) return false
    if (typeof component.entry !== 'string' || !component.entry || path.isAbsolute(component.entry)) return false
    if (component.kind === PYTHON_KIND && component.entry !== PYTHON_ENTRY_RELATIVE) return false
    if (component.kind === TEXLIVE_KIND &&
      (component.entry !== `${TEXLIVE_BIN_PARENT_RELATIVE}/bin/windows` ||
        !Array.isArray(component.executables) || component.executables.length === 0)) return false
  }
  return kinds.size === COMPONENT_KINDS.length
}

function parseAppComponents(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  return validateAppComponents(value) ? value : null
}

// ---- 组件仓库（$SCHOLARSEED_HOME/runtime）路径 ----

function storeStagingDirectory(storeRoot) {
  return path.join(storeRoot, STAGING_DIRNAME)
}

function storeManifestsDirectory(storeRoot) {
  return path.join(storeRoot, MANIFESTS_DIRNAME)
}

function storeLocksDirectory(storeRoot) {
  return path.join(storeRoot, LOCKS_DIRNAME)
}

function storeComponentDirectory(storeRoot, kind, target, contentId) {
  return path.join(storeRoot, componentDirectoryName(kind, target, contentId))
}

function storeManifestPath(storeRoot, contentId) {
  if (!CONTENT_ID_PATTERN.test(contentId)) throw new Error(`invalid contentId: ${contentId}`)
  return path.join(storeRoot, MANIFESTS_DIRNAME, `${contentId}.json`)
}

function storeLockPath(storeRoot, contentId) {
  if (!CONTENT_ID_PATTERN.test(contentId)) throw new Error(`invalid contentId: ${contentId}`)
  return path.join(storeRoot, LOCKS_DIRNAME, `${contentId}.lock`)
}

// ---- Windows 启动器寻址（.cmd） ----

/**
 * .cmd 前导：把解释器定位到组件仓库（SCHOLARSEED_HOME 覆盖 → 默认 %USERPROFILE%\.scholarseed），
 * 并把 backend/pylibs 前置进 PYTHONPATH（产品代码不在组件里）。组件尚未 provision 时
 * 显式报错退出，不静默回落宿主 Python（AGENTS.md：禁止回退宿主解释器）。
 */
function windowsComponentPreamble(target, contentId) {
  const runtimeRelative = componentDirectoryName(PYTHON_KIND, target, contentId)
    .split(path.sep).join('\\')
  return [
    '@echo off',
    'setlocal',
    `if defined ${HOME_ENV} (set "SS_RUNTIME=%${HOME_ENV}%\\${RUNTIME_DIRNAME}") else (set "SS_RUNTIME=%USERPROFILE%\\.scholarseed\\${RUNTIME_DIRNAME}")`,
    `set "SS_PY=%SS_RUNTIME%\\${runtimeRelative}\\${PYTHON_TREE_DIRNAME}\\python.exe"`,
    'if not exist "%SS_PY%" (echo ScholarSeed runtime component is not provisioned yet; start the ScholarSeed app first. 1>&2 & exit /b 1)',
    'set "PYTHONPATH=%~dp0..\\' + PYLIBS_DIRNAME + ';%PYTHONPATH%"'
  ]
}

function skillPythonLauncherCommand(target, contentId, module) {
  return [...windowsComponentPreamble(target, contentId), `"%SS_PY%" -m ${module} %*`, ''].join('\r\n')
}

function consoleScriptLauncherCommand(target, contentId, pyLaunch) {
  return [...windowsComponentPreamble(target, contentId), `"%SS_PY%" -c "${pyLaunch}" %*`, ''].join('\r\n')
}

module.exports = {
  APP_COMPONENTS_FILENAME,
  COMPONENTS_DIRNAME,
  COMPONENT_KINDS,
  COMPONENT_SCHEMA_VERSION,
  CONTENT_ID_PATTERN,
  HOME_ENV,
  LOCKS_DIRNAME,
  MANIFESTS_DIRNAME,
  PYLIBS_DIRNAME,
  PYTHON_ENTRY_RELATIVE,
  PYTHON_KIND,
  PYTHON_TREE_DIRNAME,
  RUNTIME_DIRNAME,
  STAGING_DIRNAME,
  TARGET_PATTERN,
  TEXLIVE_BIN_PARENT_RELATIVE,
  TEXLIVE_KIND,
  TEXLIVE_TREE_DIRNAME,
  appComponentsManifest,
  componentArchiveName,
  componentDirectoryName,
  componentTarget,
  consoleScriptLauncherCommand,
  derivePythonContentId,
  deriveTexliveContentId,
  packComponentArchive,
  parseAppComponents,
  sha256FileSync,
  skillPythonLauncherCommand,
  storeComponentDirectory,
  storeLockPath,
  storeLocksDirectory,
  storeManifestPath,
  storeManifestsDirectory,
  storeStagingDirectory,
  validateAppComponents,
  windowsComponentPreamble,
  writeProductLibraries
}
