export type DragPayload = Pick<DataTransfer, 'files' | 'items'> | null | undefined

export const LITERATURE_DRAG_TYPE = 'application/x-scholarseed-literature'
export const PROJECT_ENTRY_DRAG_TYPE = 'application/x-scholarseed-project-entry'

interface DraggedProjectEntry {
  path: string
  name: string
  kind: 'file' | 'dir'
}

export function hasDraggedProjectEntry(payload: Pick<DataTransfer, 'types'>): boolean {
  return Array.from(payload.types).includes(PROJECT_ENTRY_DRAG_TYPE)
}

export function writeProjectEntryDrag(
  payload: Pick<DataTransfer, 'setData' | 'effectAllowed'>,
  projectId: string,
  entry: DraggedProjectEntry
): void {
  payload.setData(
    PROJECT_ENTRY_DRAG_TYPE,
    JSON.stringify({
      projectId,
      entry: { kind: entry.kind, path: entry.path, name: entry.name },
    })
  )
  payload.effectAllowed = 'copy'
}

export function readProjectEntryDrag(
  payload: Pick<DataTransfer, 'getData'>,
  projectId: string | null
): DraggedProjectEntry | null {
  try {
    const value = JSON.parse(payload.getData(PROJECT_ENTRY_DRAG_TYPE))
    const entry = value?.entry
    if (
      !projectId ||
      value.projectId !== projectId ||
      !entry ||
      !['file', 'dir'].includes(entry.kind) ||
      typeof entry.name !== 'string' ||
      !entry.name.trim() ||
      typeof entry.path !== 'string' ||
      !entry.path.trim() ||
      entry.path.startsWith('/') ||
      /[\\\u0000]/.test(entry.path) ||
      /^[a-z]:/i.test(entry.path) ||
      entry.path.split('/').some((part: string) => !part || part === '..' || part === '.')
    )
      return null
    return { kind: entry.kind, path: entry.path, name: entry.name }
  } catch {
    return null
  }
}

interface DraggedLiterature {
  id: string
  title: string
}

export function hasDraggedLiterature(payload: Pick<DataTransfer, 'types'>): boolean {
  return Array.from(payload.types).includes(LITERATURE_DRAG_TYPE)
}

export function writeLiteratureDrag(
  payload: Pick<DataTransfer, 'setData' | 'effectAllowed'>,
  projectId: string,
  dragged: DraggedLiterature,
  selected: DraggedLiterature[]
): void {
  const items = selected.some((item) => item.id === dragged.id) ? selected : [dragged]
  payload.setData(
    LITERATURE_DRAG_TYPE,
    JSON.stringify({
      projectId,
      items: items.map(({ id, title }) => ({ id, title })),
    })
  )
  payload.effectAllowed = 'copy'
}

export function readLiteratureDrag(
  payload: Pick<DataTransfer, 'getData'>,
  projectId: string | null
): DraggedLiterature[] | null {
  try {
    const value = JSON.parse(payload.getData(LITERATURE_DRAG_TYPE))
    if (
      !projectId ||
      !value ||
      value.projectId !== projectId ||
      !Array.isArray(value.items) ||
      value.items.length === 0 ||
      !value.items.every(
        (item: unknown) =>
          item !== null &&
          typeof item === 'object' &&
          'id' in item &&
          typeof item.id === 'string' &&
          item.id.trim() &&
          'title' in item &&
          typeof item.title === 'string'
      )
    )
      return null
    return value.items.map(({ id, title }: DraggedLiterature) => ({ id, title }))
  } catch {
    return null
  }
}

export type DraggedFilePathResolver = (file: File) => string

export interface DraggedFilePathResolution {
  paths: string[]
  unresolvedCount: number
}

export function hasDraggedFiles(payload: DragPayload): boolean {
  if (!payload) return false
  if (payload.items && Array.from(payload.items).some((item) => item.kind === 'file')) return true
  return Boolean(payload.files && payload.files.length > 0)
}

/**
 * 将用户从操作系统明确拖入的 File 解析成可交给桌面导入 API 的真实路径。
 *
 * 浏览器不能直接读取本地路径；调用方必须传入 preload 暴露的受限解析器。
 * 单个文件解析失败时显式计数，避免多选拖入发生静默的部分导入。
 */
export function resolveDraggedFilePaths(
  files: FileList | null | undefined,
  resolvePath: DraggedFilePathResolver | null | undefined
): DraggedFilePathResolution {
  const incoming = Array.from(files ?? [])
  if (!resolvePath) {
    return { paths: [], unresolvedCount: incoming.length }
  }

  const paths: string[] = []
  const seen = new Set<string>()
  let unresolvedCount = 0
  for (const file of incoming) {
    try {
      const path = resolvePath(file)
      if (!path) {
        unresolvedCount += 1
        continue
      }
      if (!seen.has(path)) {
        seen.add(path)
        paths.push(path)
      }
    } catch {
      unresolvedCount += 1
    }
  }
  return { paths, unresolvedCount }
}
