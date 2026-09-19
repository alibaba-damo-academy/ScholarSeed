export type DragPayload = Pick<DataTransfer, 'files' | 'items'> | null | undefined

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
