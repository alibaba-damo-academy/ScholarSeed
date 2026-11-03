import type { OpenWithApp } from './api'
import { appsForFile, revealSystemPath } from './api'
import { uniqueApplications } from './applications'
import { writeClipboard } from './components/primitive/clipboard'
import type { FilePreviewTarget } from './model'

const REVEAL_LABEL_KEYS = {
  darwin: 'resources:menu.reveal',
  win32: 'resources:menu.revealInFolder'
} as const
const DEFAULT_REVEAL_LABEL_KEY = 'resources:menu.revealInFileManager'

export function revealLabelKey() {
  const platform = window.scholarseed?.platform
  return REVEAL_LABEL_KEYS[platform as keyof typeof REVEAL_LABEL_KEYS] ?? DEFAULT_REVEAL_LABEL_KEY
}

// fileOpen.ts — 产物打开路由 (PRD 2.1.5)。集中判定「平台内预览 / 系统程序打开」,
// 供文件列表点击与右键菜单共用, 避免两处各写一份判定而分叉。

export function fileSuffix(name: string): string {
  const base = name.split('/').filter(Boolean).pop() || name
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : ''
}

export interface OpenContext {
  /** 工作区相对路径 (预览接口用)。 */
  relative: string
  /** 本机绝对路径 (系统打开 / 访达 / 打开方式用)。 */
  absolute: string
  title: string
}

export interface OpenHandlers {
  openPreview: (target: FilePreviewTarget) => void
  /** 平台预览器与系统程序都打不开时的兜底: 弹「文件预览失败」层。 */
  onFailed: (ctx: OpenContext, note: string) => void
}

/** 所有文件点击都进入统一工作台；格式识别由后端投影负责。 */
export async function openByDefault(ctx: OpenContext, h: OpenHandlers): Promise<void> {
  h.openPreview({ path: ctx.relative, absolutePath: ctx.absolute, title: ctx.title })
}

export const revealInFinder = (ctx: OpenContext): void => void revealSystemPath(ctx.absolute)

export async function copyPath(ctx: OpenContext): Promise<void> {
  try {
    await writeClipboard(ctx.absolute)
  } catch {
    // 剪贴板不可用时静默失败: 复制路径不是关键路径, 不打断用户。
  }
}

export const listOpenWithApps = async (ctx: OpenContext): Promise<OpenWithApp[]> => (
  uniqueApplications(await appsForFile(ctx.absolute))
)
