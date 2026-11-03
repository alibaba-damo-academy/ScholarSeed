import type { SessionTitleFallback } from '../../session'
import React from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, Pencil, Trash2 } from 'lucide-react'

import { useApp } from '../../store'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui'

// SessionContextMenu.tsx — 会话行右键菜单 (PRD 2.1.8 ④)。
//   所有会话保持创建时的范围，只提供重命名和删除。

const MENU_ITEM_TEXT_CLASS_NAME = 'flex-1'

export interface SessionContextMenuTarget {
  inProject: boolean
  sessionId: string
  title: string
  title_fallback?: SessionTitleFallback
}

type MenuParts = {
  Content: typeof ContextMenuContent
  Item: typeof ContextMenuItem
  Separator: typeof ContextMenuSeparator
}

const contextParts: MenuParts = {
  Content: ContextMenuContent,
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
}

const dropdownParts: MenuParts = {
  Content: DropdownMenuContent,
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
}

function SessionMenuContent({
  target,
  parts,
  layoutActions,
}: {
  parts: MenuParts
  target: SessionContextMenuTarget
  layoutActions?: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { set } = useApp()
  const { Content, Item, Separator } = parts

  const handleRename = (): void => {
    set({
      sessionRename: {
        sessionId: target.sessionId,
        originalTitle: target.title,
        ...(layoutActions ? { mode: 'dialog' as const } : {}),
      },
    })
  }

  const handleDelete = (): void => {
    set({
      confirmDelete: {
        label: target.title,
        title_fallback: target.title_fallback,
        sessionId: target.sessionId,
      },
    })
  }

  return (
    <Content align={layoutActions ? 'end' : undefined} data-testid="session-context-menu">
      <Item disabled={!target.sessionId} data-testid="session-rename-menu" onSelect={handleRename}>
        <Pencil />
        <span className={MENU_ITEM_TEXT_CLASS_NAME}>{t('sessionMenu.rename')}</span>
      </Item>
      {layoutActions}
      <Separator />
      {target.inProject && (
        <Item
          disabled={!target.sessionId}
          data-testid="session-archive-menu"
          onSelect={() =>
            set({ sessionArchive: { sessionId: target.sessionId, title: target.title } })
          }
        >
          <Archive />
          <span className={MENU_ITEM_TEXT_CLASS_NAME}>{t('taskArchive.archive')}</span>
        </Item>
      )}
      <Item
        disabled={!target.sessionId}
        destructive
        data-testid="session-delete-menu"
        onSelect={handleDelete}
      >
        <Trash2 />
        <span className={MENU_ITEM_TEXT_CLASS_NAME}>{t('sessionMenu.delete')}</span>
      </Item>
    </Content>
  )
}

function SessionMenu({
  children,
  mode,
  onOpenChange,
  target,
  layoutActions,
}: {
  children: React.ReactNode
  mode: 'context' | 'dropdown'
  onOpenChange?: (open: boolean) => void
  target: SessionContextMenuTarget
  layoutActions?: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false)

  const updateOpen = (nextOpen: boolean): void => {
    setOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }

  const menu =
    mode === 'context' ? (
      <ContextMenu open={open} onOpenChange={updateOpen}>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <SessionMenuContent parts={contextParts} target={target} />
      </ContextMenu>
    ) : (
      <DropdownMenu open={open} onOpenChange={updateOpen}>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <SessionMenuContent parts={dropdownParts} target={target} layoutActions={layoutActions} />
      </DropdownMenu>
    )

  return menu
}

export function SessionContextMenu({
  children,
  onOpenChange,
  target,
}: {
  children: React.ReactNode
  onOpenChange?: (open: boolean) => void
  target: SessionContextMenuTarget
}): React.JSX.Element {
  return (
    <SessionMenu mode="context" onOpenChange={onOpenChange} target={target}>
      {children}
    </SessionMenu>
  )
}

export function SessionDropdownMenu({
  children,
  onOpenChange,
  target,
  layoutActions,
}: {
  children: React.ReactNode
  onOpenChange?: (open: boolean) => void
  target: SessionContextMenuTarget
  layoutActions?: React.ReactNode
}): React.JSX.Element {
  return (
    <SessionMenu
      mode="dropdown"
      onOpenChange={onOpenChange}
      target={target}
      layoutActions={layoutActions}
    >
      {children}
    </SessionMenu>
  )
}
