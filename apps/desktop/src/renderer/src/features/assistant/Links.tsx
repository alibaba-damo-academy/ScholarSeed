import React from 'react'
import { useTranslation } from 'react-i18next'
import { EllipsisVertical } from 'lucide-react'

import {
  appsForFile,
  downloadSessionFile,
  getSessionFiles,
  openPathWith,
  revealSystemPath,
  type OpenWithApp,
} from '../../api'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  IconButton,
  useToast,
} from '../../components/ui'

const MENU_CLASS_NAME = `${PRODUCT_MENU_CONTENT_CLASS} text-[length:var(--vds-font-body-lv2)]`
const SUBMENU_CLASS_NAME = `${PRODUCT_MENU_CONTENT_CLASS} max-w-[var(--vds-model-menu-max-width)] overflow-y-auto text-[length:var(--vds-font-body-lv2)]`
const MENU_HINT_CLASS_NAME =
  'px-[var(--vds-space-2)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]'

export function SessionFileLink({
  className,
  children,
  actions,
  onOpen,
  path,
  sessionId,
  mode = 'link',
}: {
  className?: string
  children?: React.ReactNode
  actions?: React.ReactNode
  onOpen: () => void
  path: string
  sessionId: string
  mode?: 'link' | 'actions'
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const { toast } = useToast()
  const [apps, setApps] = React.useState<OpenWithApp[] | null>(null)
  const [appsLoading, setAppsLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const segments = path.split('/')
  const name = segments.at(-1) ?? path
  const parent = segments.slice(0, -1).join('/')
  const Menu = mode === 'actions' ? DropdownMenu : ContextMenu
  const Content = mode === 'actions' ? DropdownMenuContent : ContextMenuContent
  const Item = mode === 'actions' ? DropdownMenuItem : ContextMenuItem
  const Separator = mode === 'actions' ? DropdownMenuSeparator : ContextMenuSeparator
  const Sub = mode === 'actions' ? DropdownMenuSub : ContextMenuSub
  const SubContent = mode === 'actions' ? DropdownMenuSubContent : ContextMenuSubContent
  const SubTrigger = mode === 'actions' ? DropdownMenuSubTrigger : ContextMenuSubTrigger

  const resolvePath = async (): Promise<string | null> => {
    const directory = await getSessionFiles(sessionId, parent)
    if (!directory?.root || !directory.items.some((item) => item.name === name && !item.dir))
      return null
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
      const result = await window.scholarseed?.saveFileCopy({
        suggestedName: name,
        bytes: file.bytes,
      })
      if (!result?.ok && !result?.canceled)
        toast({ title: t('artifactEntry.copyFailed'), tone: 'error' })
    } catch {
      toast({ title: t('artifactEntry.copyFailed'), tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Menu
      onOpenChange={(open) => {
        if (!open) setApps(null)
      }}
    >
      {mode === 'actions' ? (
        <DropdownMenuTrigger asChild>
          <IconButton
            data-testid="session-file-actions"
            label={t('artifactEntry.moreActions', { name })}
            icon={<EllipsisVertical />}
            size="sm"
            variant="ghostIcon"
          />
        </DropdownMenuTrigger>
      ) : (
        <ContextMenuTrigger asChild>
          <Button
            unstyled
            className={`inline cursor-pointer border-0 bg-transparent p-0 [font:inherit] text-[var(--vds-link)] underline hover:text-[var(--vds-link-hover)] focus-visible:[box-shadow:var(--vds-focus-brand)] ${className ?? ''}`}
            data-testid="session-file-link"
            onClick={onOpen}
          >
            {children}
          </Button>
        </ContextMenuTrigger>
      )}
      <Content className={MENU_CLASS_NAME} data-testid="session-file-link-menu">
        <Item data-testid="session-file-link-open" onSelect={onOpen}>
          {t('artifactEntry.open')}
        </Item>
        {actions}
        <Sub>
          <SubTrigger
            openOnHover
            data-testid="session-file-link-open-with"
            onClick={loadApps}
            onMouseEnter={loadApps}
            onFocus={loadApps}
          >
            {t('artifactEntry.openWith')}
          </SubTrigger>
          <SubContent className={SUBMENU_CLASS_NAME}>
            {appsLoading && (
              <div className={MENU_HINT_CLASS_NAME}>{t('artifactEntry.loadingApps')}</div>
            )}
            {!appsLoading && apps?.length === 0 && (
              <div className={MENU_HINT_CLASS_NAME}>{t('artifactEntry.noApps')}</div>
            )}
            {apps?.map((app) => (
              <Item
                key={app.path}
                onSelect={() =>
                  void withPath(async (absolute) => {
                    const result = await openPathWith(absolute, app.path)
                    if (!result.ok)
                      toast({
                        title: t('artifactEntry.openWithFailed', { app: app.name }),
                        description: result.error,
                        tone: 'error',
                      })
                  })
                }
              >
                <span className="min-w-0 flex-1 truncate">{app.name}</span>
                {app.isDefault && (
                  <span className="ml-auto text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
                    {t('artifactEntry.defaultApp')}
                  </span>
                )}
              </Item>
            ))}
          </SubContent>
        </Sub>
        <Separator />
        <Item
          data-testid="session-file-link-save-as"
          disabled={saving}
          onSelect={() => void saveAs()}
        >
          {t('artifactEntry.saveAs')}
        </Item>
        <Item
          data-testid="session-file-link-copy-path"
          onSelect={() =>
            void withPath(async (absolute) => {
              try {
                await writeClipboard(absolute)
                toast({ title: t('artifactEntry.pathCopied'), tone: 'success' })
              } catch {
                toast({ title: t('artifactEntry.copyPathFailed'), tone: 'error' })
              }
            })
          }
        >
          {t('artifactEntry.copyPath')}
        </Item>
        <Item
          data-testid="session-file-link-reveal"
          onSelect={() =>
            void withPath(async (absolute) => {
              const result = await revealSystemPath(absolute)
              if (!result.ok)
                toast({
                  title: t('artifactEntry.revealFailed'),
                  description: result.error,
                  tone: 'error',
                })
            })
          }
        >
          {t(
            window.scholarseed?.platform === 'darwin'
              ? 'artifactEntry.revealInFinder'
              : 'artifactEntry.revealInFileManager'
          )}
        </Item>
      </Content>
    </Menu>
  )
}
