import React from 'react'
import { useTranslation } from 'react-i18next'

import { FileItem, FilesResp, getSessionFiles, getWorkspaceFiles, openSystemPath, revealSystemPath } from '../../api'
import { openByDefault } from '../../fileOpen'
import { Icon } from '../../icons'
import { useApp } from '../../store'
import { Button, EmptyState, IconButton, Spinner } from '../ui'
import { cx } from '../ui/utils'
import { FileContextMenu } from './FileContextMenu'

const PAGE_CLASS_NAME = 'absolute inset-[var(--vds-space-0)] z-[var(--vds-z-workspace-files)] flex flex-col bg-[var(--vds-surface-raised)]'
const HEADER_CLASS_NAME = 'flex min-h-[58px] items-center gap-[10px] border-b border-[var(--border-soft)] px-[20px]'
const TITLE_WRAP_CLASS_NAME = 'min-w-0 flex-1'
const TITLE_CLASS_NAME = 'text-[14px] font-[650] text-[var(--text)]'
const ROOT_CLASS_NAME = 'mt-[2px] overflow-hidden text-ellipsis whitespace-nowrap text-[10.5px] text-[var(--text-3)]'
const CRUMBS_CLASS_NAME = 'flex min-h-[42px] items-center gap-[5px] border-b border-[var(--border-soft)] px-[22px] text-[11px]'
const CRUMB_SEPARATOR_CLASS_NAME = 'text-[var(--text-3)]'
const MAIN_CLASS_NAME = 'min-h-0 flex-1 overflow-auto px-[20px] pb-[28px] pt-[14px]'
const EMPTY_CLASS_NAME = 'grid min-h-full place-items-center'
const LIST_CLASS_NAME = 'mx-auto max-w-[920px] overflow-hidden rounded-[10px] border border-[var(--border-soft)] bg-[var(--bg-2)]'
const ROW_CLASS_NAME = 'box-border flex min-h-[42px] w-full items-center gap-[9px] border-0 border-b border-[var(--border-soft)] bg-transparent px-[12px] py-[10px] text-[11.5px] text-[var(--text-2)] transition-[background,color,border-color] duration-150 hover:bg-[var(--hover-bg)] hover:text-[var(--text)]'
const ROW_CONTAINER_CLASS_NAME = cx(ROW_CLASS_NAME, 'p-[var(--vds-space-0)]')
const OPEN_BUTTON_CLASS_NAME = 'flex min-w-0 flex-1 items-center gap-[9px] border-0 bg-transparent px-[12px] py-[10px] text-left text-[var(--text-2)] shadow-none'
const FILE_NAME_CLASS_NAME = 'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px]'
const FILE_SIZE_CLASS_NAME = 'text-[9.5px] text-[var(--text-3)]'

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name
}

function sizeLabel(size: number): string {
  if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(1)} MB`
  if (size >= 1_000) return `${(size / 1_000).toFixed(1)} KB`
  return `${size} B`
}

function absolutePath(root: string, relative: string): string {
  return relative ? `${root}/${relative}` : root
}

function fileTestId(relative: string): string {
  return encodeURIComponent(relative).split('%').join('_')
}

/** Project browser for the ScholarSeed MVP. Files are intentionally read-only. */
export function WorkspaceFiles(): React.JSX.Element {
  const { t } = useTranslation('components')
  const { state, set, act } = useApp()
  const sessionId = state.workspaceFilesSessionId
  const [listing, setListing] = React.useState<FilesResp | null>(null)
  const [path, setPath] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(false)
  const [reloadVersion, setReloadVersion] = React.useState(0)

  React.useEffect(() => {
    let active = true
    setLoading(true)
    setError(false)
    const request = sessionId ? getSessionFiles(sessionId, path) : getWorkspaceFiles(path)
    void request.then((result) => {
      if (!active) return
      setLoading(false)
      setListing(result)
      if (!result) setError(true)
    })
    return () => {
      active = false
    }
  }, [path, reloadVersion, sessionId])

  const openItem = (item: FileItem): void => {
    const relative = joinPath(path, item.name)
    if (item.dir) {
      setPath(relative)
      return
    }
    if (!listing) return
    const absolute = absolutePath(listing.root, relative)
    void openByDefault(
      { relative, absolute, title: item.name },
      {
        openPreview: (target) => act.openFilePreview({ ...target, sessionId: sessionId || undefined }),
        // 系统与预览器都打不开 → 复用预览层显示「文件预览失败」+ 兜底按钮。
        onFailed: (_ctx, note) => act.openFilePreview({
          path: relative,
          absolutePath: absolute,
          sessionId: sessionId || undefined,
          title: item.name,
          content: note
        })
      }
    )
  }

  const crumbs = listing?.crumbs ?? []

  return (
    <div data-testid="workspace-files-page" className={PAGE_CLASS_NAME}>
      <header className={HEADER_CLASS_NAME}>
        <Icon name="folder" size={18} />
        <div className={TITLE_WRAP_CLASS_NAME}>
          <div className={TITLE_CLASS_NAME}>{t('files.title')}</div>
          <div title={listing?.root} className={ROOT_CLASS_NAME}>{listing?.root || t('files.current')}</div>
        </div>
        {listing && (
          <>
            <Button size="sm" variant="outline" data-testid="workspace-open-root" onClick={() => void openSystemPath(listing.root)}>{t('files.systemOpen')}</Button>
            <Button size="sm" variant="outline" data-testid="workspace-reveal-root" onClick={() => void revealSystemPath(listing.root)}>{t('files.reveal')}</Button>
          </>
        )}
        <IconButton data-testid="workspace-files-close" icon={<Icon name="close" size={16} />} label={t('files.close')} onClick={() => set({ workspaceFilesOpen: false, workspaceFilesSessionId: null })} size="sm" variant="ghostIcon" />
      </header>

      <div className={CRUMBS_CLASS_NAME}>
        <Button size="sm" variant="ghost" onClick={() => setPath('')}>{t('files.project')}</Button>
        {crumbs.map((crumb, index) => {
          const next = crumbs.slice(0, index + 1).join('/')
          return <React.Fragment key={next}><span className={CRUMB_SEPARATOR_CLASS_NAME}>/</span><Button size="sm" variant="ghost" onClick={() => setPath(next)}>{crumb}</Button></React.Fragment>
        })}
      </div>

      <main className={MAIN_CLASS_NAME}>
        {loading && <div className={EMPTY_CLASS_NAME}><Spinner aria-label={t('files.loading')} /></div>}
        {!loading && error && <EmptyState className={EMPTY_CLASS_NAME} icon={<Icon name="folder" size={24} />} title={t('files.failed')} action={<Button variant="secondary" onClick={() => setReloadVersion((version) => version + 1)}>{t('files.retry')}</Button>} />}
        {!loading && listing && listing.items.length === 0 && <EmptyState className={EMPTY_CLASS_NAME} icon={<Icon name="folder" size={24} />} title={t('files.empty')} />}
        {!loading && listing && listing.items.length > 0 && (
          <div className={LIST_CLASS_NAME}>
            {path && (
              <Button unstyled className={ROW_CLASS_NAME} onClick={() => setPath(path.split('/').slice(0, -1).join('/'))}>
                <Icon name="folder" size={15} /><span className="flex-1 text-left">..</span>
              </Button>
            )}
            {listing.items.map((item) => {
              const relative = joinPath(path, item.name)
              const absolute = absolutePath(listing.root, relative)
              return (
                <FileContextMenu
                  key={item.name}
                  target={{
                    relative,
                    absolute,
                    name: item.name,
                    isDir: item.dir,
                    sessionId: sessionId || undefined
                  }}
                >
                  <div className={ROW_CONTAINER_CLASS_NAME} data-testid={`workspace-row-${fileTestId(relative)}`}>
                    <Button unstyled data-testid={`workspace-open-${fileTestId(relative)}`} onClick={() => openItem(item)} className={OPEN_BUTTON_CLASS_NAME}>
                      <Icon name={item.dir ? 'folder' : 'artifacts'} size={15} />
                      <span className={FILE_NAME_CLASS_NAME}>{item.name}</span>
                      {!item.dir && <span className={FILE_SIZE_CLASS_NAME}>{sizeLabel(item.size)}</span>}
                    </Button>
                    {!item.dir && <Button className="mr-[var(--vds-space-2)]" size="sm" variant="outline" data-testid={`workspace-system-open-${fileTestId(relative)}`} onClick={() => void openSystemPath(absolute)}>{t('files.systemOpen')}</Button>}
                    <Button className="mr-[var(--vds-space-2)]" size="sm" variant="outline" data-testid={`workspace-reveal-${fileTestId(relative)}`} onClick={() => void revealSystemPath(absolute)}>{t('files.reveal')}</Button>
                  </div>
                </FileContextMenu>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
