import React from 'react'
import { useTranslation } from 'react-i18next'
import { AppWindow } from 'lucide-react'

import type { OpenWithApp } from '../../api'
import { openPathWith } from '../../api'
import { PRODUCT_MENU_CONTENT_CLASS } from '../../components/primitive/menu'
import type { OpenContext } from '../../fileOpen'
import {
  copyPath,
  listOpenWithApps,
  openByDefault,
  revealInFinder,
  revealLabelKey,
} from '../../fileOpen'
import { useApp } from '../../store'
import { FileMenuItems } from './Artifact'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger, EmptyState } from '../ui'

// FileContextMenu.tsx — 文件右键菜单 (PRD 2.1.5 图2)。四项: 打开 / 在文件系统中打开 /
// 复制路径 / 打开方式(二级)。

const TRIGGER_CLASS_NAME = 'contents'
const MENU_CLASS_NAME = `${PRODUCT_MENU_CONTENT_CLASS} w-[190px] text-xs`

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
  target,
}: {
  children: React.ReactNode
  target: FileContextMenuTarget
}): React.JSX.Element {
  const { t } = useTranslation(['components', 'resources'])
  const { act } = useApp()
  const [apps, setApps] = React.useState<OpenWithApp[] | null>(null)
  const [resetKey, setResetKey] = React.useState(0)

  // 右键目标变化 → 复位子菜单与候选缓存。
  React.useEffect(() => {
    setApps(null)
  }, [target.absolute])

  const ctx: OpenContext = {
    relative: target.relative,
    absolute: target.absolute,
    title: target.name,
  }
  const close = (): void => setResetKey((key) => key + 1)

  const handleOpen = (): void => {
    close()
    void openByDefault(ctx, {
      openPreview: (previewTarget) =>
        act.openFilePreview({
          ...previewTarget,
          sessionId: target.sessionId,
        }),
      onFailed: (_c, note) =>
        act.openFilePreview({
          path: ctx.relative,
          absolutePath: ctx.absolute,
          sessionId: target.sessionId,
          title: ctx.title,
          content: note,
        }),
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
      <ContextMenuTrigger className={TRIGGER_CLASS_NAME}>{children}</ContextMenuTrigger>
      <ContextMenuContent className={MENU_CLASS_NAME} data-testid="file-context-menu">
        <FileMenuItems
          kind="context"
          directory={target.isDir}
          apps={apps}
          appsLoading={apps === null}
          canUsePath={Boolean(target.absolute)}
          canSaveAs={false}
          showSaveAs={false}
          downloading={false}
          onOpen={handleOpen}
          loadApps={loadApps}
          onOpenWith={openWith}
          onCopyPath={() => {
            close()
            void copyPath(ctx)
          }}
          onReveal={() => {
            close()
            revealInFinder(ctx)
          }}
          revealLabel={t(revealLabelKey())}
          emptyApps={
            <EmptyState variant="compact" icon={<AppWindow />} title={t('fileMenu.empty')} />
          }
        />
      </ContextMenuContent>
    </ContextMenu>
  )
}
