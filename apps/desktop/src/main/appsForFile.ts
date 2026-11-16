// appsForFile.ts — 「打开方式」候选应用枚举 (macOS)。
//
// 用 macOS 原生 NSWorkspace (经 osascript JXA 桥) 取「能打开此文件的全部应用」与
// 「系统默认应用」。相比自己解析 .app 的 Info.plist, 这条路天然覆盖 Office 等应用
// 用私有 UTI 声明的类型 (如 Excel 的 xlsx), 结果与 Finder「打开方式」一致。
// 纯 macOS 本机能力, 属产品层; 不进 Agent 层, 也不读任何文件内容, 只按路径问系统。

import { spawn } from 'child_process'
import { basename } from 'path'

export interface AppCandidate {
  name: string
  path: string
  isDefault: boolean
  icon?: string
}

const MAX_CANDIDATES = 10
const HIDDEN_APPLICATION_PREFIX = '.'
const NUMERIC_VERSION = /^\d+(?:\.\d+)*$/

interface NativeCandidate extends AppCandidate {
  readonly bundleId?: string
  readonly bundleName?: string
  readonly bundleDisplayName?: string
  readonly executable?: string
  readonly version?: string
  readonly build?: string
}

function numericVersion(value: string | undefined): bigint[] | null {
  return typeof value === 'string' && NUMERIC_VERSION.test(value)
    ? value.split('.').map(BigInt)
    : null
}

function compareVersion(left: bigint[], right: bigint[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0n) - (right[index] ?? 0n)
    if (difference !== 0n) return difference > 0n ? 1 : -1
  }
  return 0
}

function newestComparable(
  candidates: NativeCandidate[],
  field: 'version' | 'build'
): NativeCandidate[] {
  const versions = candidates.map((candidate) => numericVersion(candidate[field]))
  if (versions.some((version) => version === null)) return candidates
  const highest = versions.reduce((left, right) =>
    compareVersion(left!, right!) >= 0 ? left : right
  )!
  return candidates.filter((_, index) => compareVersion(versions[index]!, highest) === 0)
}

function representative(candidates: NativeCandidate[]): NativeCandidate {
  const preferred = candidates.find((candidate) => candidate.isDefault)
  if (preferred) return preferred
  const versions = newestComparable(candidates, 'version')
  const comparable = versions.every((candidate) => numericVersion(candidate.version) !== null)
  const finalists = comparable ? newestComparable(versions, 'build') : versions
  return finalists.reduce((left, right) => (left.path <= right.path ? left : right))
}

// JXA 脚本: 从 argv 读文件路径 (不拼接进脚本, 防注入), 输出 {default, apps} JSON。
// URLsForApplicationsToOpenURL / URLForApplicationToOpenURL 需要真实存在的文件路径,
// 右键场景下文件确实存在, 因此可靠。
const JXA_SCRIPT = `
function run(argv) {
  ObjC.import('AppKit'); ObjC.import('Foundation')
  const ws = $.NSWorkspace.sharedWorkspace
  const iconData = (path) => {
    const source = ws.iconForFile(path)
    const image = $.NSImage.alloc.initWithSize($.NSMakeSize(32, 32))
    image.lockFocus
    source.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 32, 32), $.NSZeroRect, $.NSCompositingOperationCopy, 1)
    image.unlockFocus
    const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation)
    const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $())
    return 'data:image/png;base64,' + ObjC.unwrap(png.base64EncodedStringWithOptions(0))
  }
  const url = $.NSURL.fileURLWithPath(argv[0])
  const def = ws.URLForApplicationToOpenURL(url)
  const defPath = def && !def.isNil() ? ObjC.unwrap(def.path) : null
  const arr = ws.URLsForApplicationsToOpenURL(url)
  const apps = []
  if (arr && !arr.isNil()) {
    for (let i = 0; i < arr.count; i++) {
      const p = ObjC.unwrap(arr.objectAtIndex(i).path)
      const name = ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(p)).replace(/\\.app$/, '')
      const bundle = $.NSBundle.bundleWithPath(p)
      const info = bundle && !bundle.isNil() ? bundle.infoDictionary : null
      const metadata = (key) => {
        const value = info && !info.isNil() ? info.objectForKey(key) : null
        return value && !value.isNil() ? ObjC.unwrap(value) : undefined
      }
      apps.push({ name, path: p, isDefault: p === defPath, icon: iconData(p),
        bundleId: metadata('CFBundleIdentifier'), bundleName: metadata('CFBundleName'),
        bundleDisplayName: metadata('CFBundleDisplayName'), executable: metadata('CFBundleExecutable'),
        version: metadata('CFBundleShortVersionString'), build: metadata('CFBundleVersion') })
    }
  }
  return JSON.stringify({ default: defPath, apps })
}
`

interface JxaResult {
  default: string | null
  apps: NativeCandidate[]
}

function runJxa(filePath: string): Promise<JxaResult | null> {
  return new Promise((resolve) => {
    // 路径经 argv 传入, 与脚本正文隔离, 不存在 shell/脚本注入。
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_SCRIPT, filePath])
    let out = ''
    child.stdout.setEncoding('utf8').on('data', (data: string) => (out += data))
    child.on('error', () => resolve(null))
    child.on('close', () => {
      try {
        resolve(JSON.parse(out.trim()))
      } catch {
        resolve(null)
      }
    })
  })
}

export async function appsForFile(filePath: string): Promise<AppCandidate[]> {
  if (!filePath) return []
  const result = await runJxa(filePath)
  if (!result) return []
  // 默认项置顶, 其余按名称排序; 上限 MAX_CANDIDATES。
  const list = [
    ...new Map(
      result.apps
        .filter(
          (application) =>
            !application.name.startsWith(HIDDEN_APPLICATION_PREFIX) &&
            !basename(application.path).startsWith(HIDDEN_APPLICATION_PREFIX)
        )
        .map((application) => [
          application.path,
          {
            ...application,
            isDefault: application.path === result.default,
          },
        ])
    ).values(),
  ]
  const groups = new Map<string, NativeCandidate[]>()
  for (const candidate of list) {
    const identity =
      candidate.bundleId && candidate.bundleName && candidate.executable
        ? JSON.stringify([
            candidate.bundleId,
            candidate.bundleName,
            candidate.bundleDisplayName ?? '',
            candidate.executable,
          ])
        : candidate.path
    const group = groups.get(identity) ?? []
    group.push(candidate)
    groups.set(identity, group)
  }
  const selected = [...groups.values()].map(representative)
  selected.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    return a.name.localeCompare(b.name) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  })
  return selected
    .slice(0, MAX_CANDIDATES)
    .map(({ name, path, isDefault, icon }) =>
      icon === undefined ? { name, path, isDefault } : { name, path, isDefault, icon }
    )
}

// 用指定应用打开文件。shell.openPath 不支持指定 app, 故用 `open -a`。
export function openPathWith(
  target: string,
  appPath: string
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/open', ['-a', appPath, target])
    let err = ''
    child.stderr.setEncoding('utf8').on('data', (data: string) => (err += data))
    child.on('error', (e) => resolve({ ok: false, error: e.message }))
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true })
      else resolve({ ok: false, error: err.trim() || `open exited ${code}` })
    })
  })
}
