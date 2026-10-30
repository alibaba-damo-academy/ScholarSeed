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
      apps.push({ name, path: p, isDefault: p === defPath, icon: iconData(p) })
    }
  }
  return JSON.stringify({ default: defPath, apps })
}
`

interface JxaResult {
  default: string | null
  apps: AppCandidate[]
}

function runJxa(filePath: string): Promise<JxaResult | null> {
  return new Promise((resolve) => {
    // 路径经 argv 传入, 与脚本正文隔离, 不存在 shell/脚本注入。
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_SCRIPT, filePath])
    let out = ''
    child.stdout.on('data', (d) => (out += String(d)))
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
  const list = result.apps.filter(
    (application) =>
      !application.name.startsWith(HIDDEN_APPLICATION_PREFIX) &&
      !basename(application.path).startsWith(HIDDEN_APPLICATION_PREFIX)
  )
  list.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return list.slice(0, MAX_CANDIDATES)
}

// 用指定应用打开文件。shell.openPath 不支持指定 app, 故用 `open -a`。
export function openPathWith(target: string, appPath: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/open', ['-a', appPath, target])
    let err = ''
    child.stderr.on('data', (d) => (err += String(d)))
    child.on('error', (e) => resolve({ ok: false, error: e.message }))
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true })
      else resolve({ ok: false, error: err.trim() || `open exited ${code}` })
    })
  })
}
