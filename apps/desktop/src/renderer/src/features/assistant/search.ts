import type { FileItem, FilesResp, ServeSession } from '../../api'

export type OutputPages = ReadonlyMap<string, FilesResp>
type ReadDirectory = (session: string, path: string, offset: number) => Promise<FilesResp | null>
type OutputSearchResult = { pages: OutputPages; failed: boolean; complete: boolean }

export function createOutputSearch(
  read: ReadDirectory,
  publish: (result: OutputSearchResult) => void
): { load: (sessions: ServeSession[], roots: OutputPages) => void; cancel: () => void } {
  let cancelled = false
  let running = false
  let pending: { sessions: ServeSession[]; roots: OutputPages } | null = null
  let previous: OutputPages = new Map()
  const run = async (): Promise<void> => {
    running = true
    while (pending && !cancelled) {
      const snapshot = pending
      pending = null
      const result = await loadOutputPages(
        snapshot.sessions,
        snapshot.roots,
        read,
        () => cancelled,
        (progress) => {
          if (!cancelled) publish({ ...progress, pages: new Map([...previous, ...progress.pages]) })
        }
      )
      if (result && !cancelled) {
        previous = result.pages
        publish(result)
      }
    }
    running = false
  }
  return {
    load(sessions, roots) {
      if (cancelled) return
      pending = { sessions: [...sessions], roots: new Map(roots) }
      if (!running) void run()
    },
    cancel() {
      cancelled = true
      pending = null
    },
  }
}

export async function loadOutputPages(
  sessions: ServeSession[],
  roots: OutputPages,
  read: ReadDirectory,
  cancelled: () => boolean,
  publish?: (result: OutputSearchResult) => void
): Promise<OutputSearchResult | null> {
  const pages = new Map<string, FilesResp>()
  let failed = false
  const progress = (): void => {
    if (!cancelled()) publish?.({ pages: new Map(pages), failed, complete: false })
  }
  for (const session of sessions) {
    const key = session.session_id + ':'
    const root = roots.get(key)
    if (root) pages.set(key, root)
  }
  if (pages.size) progress()
  for (const session of sessions) {
    const pending = [{ path: '', ancestors: new Set<string>() }]
    for (let index = 0; index < pending.length; index += 1) {
      if (cancelled()) return null
      const directory = pending[index]
      const key = session.session_id + ':' + directory.path
      try {
        let page =
          (!directory.path && roots.get(key)) || (await read(session.session_id, directory.path, 0))
        if (cancelled()) return null
        if (!page) {
          failed = true
          continue
        }
        if (directory.ancestors.has(page.path)) continue
        const ancestors = new Set([...directory.ancestors, page.path])
        let items = [...page.items]
        pages.set(key, { ...page, items })
        progress()
        while (items.length < (page.total ?? items.length)) {
          const next = await read(session.session_id, directory.path, items.length)
          if (cancelled()) return null
          if (!next || !next.items.length) {
            failed = true
            break
          }
          items = [...items, ...next.items]
          page = next
          pages.set(key, { ...page, items })
          progress()
        }
        pages.set(key, { ...page, items, total: items.length })
        for (const item of items) {
          if (item.dir)
            pending.push({
              path: [directory.path, item.name].filter(Boolean).join('/'),
              ancestors,
            })
        }
      } catch {
        failed = true
      }
    }
  }
  return cancelled() ? null : { pages, failed, complete: true }
}

export function searchOutputPages(
  sessions: ServeSession[],
  pages: OutputPages,
  query: string,
  accepts: (item: FileItem) => boolean = () => true
): { sessions: ServeSession[]; pages: OutputPages } {
  const needle = query.trim().toLocaleLowerCase()
  const matches = new Map<string, FilesResp>()
  const visible = sessions.filter((session) => {
    const taskMatch = session.title.toLocaleLowerCase().includes(needle)
    const visit = (path: string): boolean => {
      const key = session.session_id + ':' + path
      const page = pages.get(key)
      if (!page) return false
      const items = page.items.filter((item) => {
        const relative = [path, item.name].filter(Boolean).join('/')
        return item.dir
          ? visit(relative)
          : accepts(item) && (taskMatch || relative.toLocaleLowerCase().includes(needle))
      })
      const literature = page.literature?.filter(
        (document) =>
          accepts({ name: 'document.pdf', dir: false, size: 0 }) &&
          (taskMatch || document.title.toLocaleLowerCase().includes(needle))
      )
      if (!items.length && !literature?.length) return false
      matches.set(key, { ...page, items, literature, total: items.length })
      return true
    }
    return visit('')
  })
  return { sessions: visible, pages: matches }
}
