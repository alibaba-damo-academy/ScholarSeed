import React from 'react'
import { useTranslation } from 'react-i18next'

import { appsForFile, downloadSessionFile, getSessionFiles, openPathWith, revealSystemPath, type OpenWithApp } from '../../api'
import { absoluteSessionFilePath } from '../../components/markdown/links'
import { writeClipboard } from '../../components/primitive/clipboard'
import { PRODUCT_MENU_CONTENT_CLASS } from '../../components/primitive/menu'
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  useToast
} from '../../components/ui'

const MENU_CLASS_NAME = `${PRODUCT_MENU_CONTENT_CLASS} text-[length:var(--vds-font-body-lv2)]`
const SUBMENU_CLASS_NAME = `${PRODUCT_MENU_CONTENT_CLASS} max-w-[var(--vds-model-menu-max-width)] overflow-y-auto text-[length:var(--vds-font-body-lv2)]`
const MENU_HINT_CLASS_NAME = 'px-[var(--vds-space-2)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]'

export function SessionFileLink({
  children,
  onOpen,
  path,
  sessionId
}: {
  children: React.ReactNode
  onOpen: () => void
  path: string
  sessionId: string
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const { toast } = useToast()
  const [apps, setApps] = React.useState<OpenWithApp[] | null>(null)
  const [appsLoading, setAppsLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const segments = path.split('/')
  const name = segments.at(-1) ?? path
  const parent = segments.slice(0, -1).join('/')

  const resolvePath = async (): Promise<string | null> => {
    const directory = await getSessionFiles(sessionId, parent)
    if (!directory?.root || !directory.items.some((item) => item.name === name && !item.dir)) return null
    return absoluteSessionFilePath(directory.root, path)
  }

  const withPath = async (action: (absolute: string) => Promise<void>): Promise<void> => {
    const absolute = await resolvePath()
    if (!absolute) {
      toast({ title: t('artifactEntry.notFound'), tone: 'error' })
      return
    }
    await action(absolute)
  }

  const loadApps = (): void => {
    if (appsLoading || apps !== null) return
    setAppsLoading(true)
    void withPath(async (absolute) => {
      setApps(await appsForFile(absolute))
    }).finally(() => setAppsLoading(false))
  }

  const saveAs = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      const file = await downloadSessionFile(sessionId, path)
      if (!file) {
        toast({ title: t('artifactEntry.readFailed'), tone: 'error' })
        return
      }
      const result = await window.scholarseed?.saveFileCopy({ suggestedName: name, bytes: file.bytes })
      if (!result?.ok && !result?.canceled) toast({ title: t('artifactEntry.copyFailed'), tone: 'error' })
    } catch {
      toast({ title: t('artifactEntry.copyFailed'), tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <ContextMenu onOpenChange={(open) => { if (!open) setApps(null) }}>
      <ContextMenuTrigger asChild>
        <Button
          unstyled
          className="inline cursor-pointer border-0 bg-transparent p-0 [font:inherit] text-[var(--vds-link)] underline hover:text-[var(--vds-link-hover)] focus-visible:[box-shadow:var(--vds-focus-brand)]"
          data-testid="session-file-link"
          onClick={onOpen}
        >{children}</Button>
      </ContextMenuTrigger>
      <ContextMenuContent className={MENU_CLASS_NAME} data-testid="session-file-link-menu">
        <ContextMenuItem data-testid="session-file-link-open" onSelect={onOpen}>{t('artifactEntry.open')}</ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger data-testid="session-file-link-open-with" onClick={loadApps} onMouseEnter={loadApps}>
            {t('artifactEntry.openWith')}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className={SUBMENU_CLASS_NAME}>
            {appsLoading && <div className={MENU_HINT_CLASS_NAME}>{t('artifactEntry.loadingApps')}</div>}
            {!appsLoading && apps?.length === 0 && <div className={MENU_HINT_CLASS_NAME}>{t('artifactEntry.noApps')}</div>}
            {apps?.map((app) => (
              <ContextMenuItem key={app.path} onSelect={() => void withPath(async (absolute) => {
                const result = await openPathWith(absolute, app.path)
                if (!result.ok) toast({ title: t('artifactEntry.openWithFailed', { app: app.name }), description: result.error, tone: 'error' })
              })}>
                <span className="min-w-0 flex-1 truncate">{app.name}</span>
                {app.isDefault && <span className="ml-auto text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">{t('artifactEntry.defaultApp')}</span>}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem data-testid="session-file-link-save-as" disabled={saving} onSelect={() => void saveAs()}>{t('artifactEntry.saveAs')}</ContextMenuItem>
        <ContextMenuItem data-testid="session-file-link-copy-path" onSelect={() => void withPath(async (absolute) => {
          try {
            await writeClipboard(absolute)
            toast({ title: t('artifactEntry.pathCopied'), tone: 'success' })
          } catch {
            toast({ title: t('artifactEntry.copyPathFailed'), tone: 'error' })
          }
        })}>{t('artifactEntry.copyPath')}</ContextMenuItem>
        <ContextMenuItem data-testid="session-file-link-reveal" onSelect={() => void withPath(async (absolute) => {
          const result = await revealSystemPath(absolute)
          if (!result.ok) toast({ title: t('artifactEntry.revealFailed'), description: result.error, tone: 'error' })
        })}>{t(window.scholarseed?.platform === 'darwin' ? 'artifactEntry.revealInFinder' : 'artifactEntry.revealInFileManager')}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
