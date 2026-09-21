import React from 'react'
import { useTranslation } from 'react-i18next'

import { OpenWithApp, openPathWith } from '../../api'
import { PRODUCT_MENU_CONTENT_CLASS } from '../../components/primitive/menu'
import { copyPath, listOpenWithApps, openByDefault, OpenContext, revealInFinder, revealLabelKey } from '../../fileOpen'
import { useApp } from '../../store'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '../ui'

// FileContextMenu.tsx — 文件右键菜单 (PRD 2.1.5 图2)。四项: 打开 / 在文件系统中打开 /
// 复制路径 / 打开方式(二级)。

const TRIGGER_CLASS_NAME = 'contents'
const MENU_CLASS_NAME = `${PRODUCT_MENU_CONTENT_CLASS} w-[190px] text-xs`
const SUBMENU_CLASS_NAME = `${PRODUCT_MENU_CONTENT_CLASS} w-[240px] max-h-80 overflow-y-auto text-xs`
const MENU_ITEM_CLASS_NAME = 'text-xs text-[var(--text-2)] hover:bg-[var(--active-bg)] hover:text-[var(--active-text)]'
const MENU_HINT_CLASS_NAME = 'px-[10px] py-[var(--vds-space-2)] text-[11px] text-[var(--text-3)]'

export interface FileContextMenuTarget {
  /** 工作区相对路径 (预览接口用)。 */
  relative: string
  /** 本机绝对路径 (系统打开 / 访达 / 打开方式)。 */
  absolute: string
  name: string
  isDir: boolean
  sessionId?: string
}

export function FileContextMenu({
  children,
  target
}: {
  children: React.ReactNode
  target: FileContextMenuTarget
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { act } = useApp()
  const [apps, setApps] = React.useState<OpenWithApp[] | null>(null)
  const [resetKey, setResetKey] = React.useState(0)

  // 右键目标变化 → 复位子菜单与候选缓存。
  React.useEffect(() => {
    setApps(null)
  }, [target.absolute])

  const ctx: OpenContext = { relative: target.relative, absolute: target.absolute, title: target.name }
  const close = (): void => setResetKey((key) => key + 1)

  const handleOpen = (): void => {
    close()
    void openByDefault(ctx, {
      openPreview: (previewTarget) => act.openFilePreview({
        ...previewTarget,
        sessionId: target.sessionId
      }),
      onFailed: (_c, note) => act.openFilePreview({
        path: ctx.relative,
        absolutePath: ctx.absolute,
        sessionId: target.sessionId,
        title: ctx.title,
        content: note
      })
    })
  }

  const loadApps = (): void => {
    if (apps === null) void listOpenWithApps(ctx).then((list) => setApps(list))
  }

  const openWith = (app: OpenWithApp): void => {
    close()
    void openPathWith(target.absolute, app.path)
  }

  // 目录只给「在文件系统中打开 / 复制路径」两项 (打开=进入目录已由左键承担)。
  return (
    <ContextMenu key={`${target.absolute}:${resetKey}`}>
      <ContextMenuTrigger className={TRIGGER_CLASS_NAME}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className={MENU_CLASS_NAME} data-testid="file-context-menu">
        {!target.isDir && (
          <ContextMenuItem className={MENU_ITEM_CLASS_NAME} data-testid="file-menu-open" onSelect={handleOpen}>
            {t('fileMenu.open')}
          </ContextMenuItem>
        )}
        <ContextMenuItem className={MENU_ITEM_CLASS_NAME} data-testid="file-menu-reveal" onSelect={() => { close(); revealInFinder(ctx) }}>
          {t(revealLabelKey())}
        </ContextMenuItem>
        <ContextMenuItem className={MENU_ITEM_CLASS_NAME} data-testid="file-menu-copy" onSelect={() => { close(); void copyPath(ctx) }}>
          {t('fileMenu.copy')}
        </ContextMenuItem>
        {!target.isDir && (
          <>
            <ContextMenuSeparator />
            <ContextMenuSub>
              <ContextMenuSubTrigger
                className={MENU_ITEM_CLASS_NAME}
                data-testid="file-menu-openwith"
                onClick={loadApps}
                onMouseEnter={loadApps}
              >
                {t('fileMenu.openWith')}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className={SUBMENU_CLASS_NAME} side="right">
                {apps === null && <div className={MENU_HINT_CLASS_NAME}>{t('fileMenu.loading')}</div>}
                {apps !== null && apps.length === 0 && <div className={MENU_HINT_CLASS_NAME}>{t('fileMenu.empty')}</div>}
                {apps?.map((app) => (
                  <ContextMenuItem
                    key={app.path}
                    className={MENU_ITEM_CLASS_NAME}
                    onSelect={() => openWith(app)}
                  >
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap">{app.name}</span>
                    {app.isDefault && <span className="ml-auto text-[10.5px] text-[var(--text-3)]">{t('fileMenu.default')}</span>}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
