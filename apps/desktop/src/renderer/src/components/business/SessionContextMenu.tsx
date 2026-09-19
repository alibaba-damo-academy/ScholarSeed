import type { SessionTitleFallback } from '../../session'
import React from 'react'
import { useTranslation } from 'react-i18next'

import { PRODUCT_MENU_CONTENT_CLASS } from '../../components/primitive/menu'
import { Icon } from '../../icons'
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
  DropdownMenuTrigger
} from '../ui'

// SessionContextMenu.tsx — 会话行右键菜单 (PRD 2.1.8 ④)。
//   所有会话保持创建时的范围，只提供重命名和删除。

const MENU_CLASS_NAME = `${PRODUCT_MENU_CONTENT_CLASS} w-[176px] text-xs`
const MENU_ITEM_CLASS_NAME = 'text-xs text-[var(--text-2)] hover:bg-[var(--active-bg)] hover:text-[var(--active-text)]'
const DANGER_ITEM_CLASS_NAME = 'text-xs text-[var(--c-tension)] hover:bg-[color-mix(in_srgb,var(--c-tension)_12%,transparent)] hover:text-[var(--c-tension)]'
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
  Separator: ContextMenuSeparator
}

const dropdownParts: MenuParts = {
  Content: DropdownMenuContent,
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator
}

function SessionMenuContent({
  target,
  parts
}: {
  parts: MenuParts
  target: SessionContextMenuTarget
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { set } = useApp()
  const { Content, Item, Separator } = parts

  const handleRename = (): void => {
    set({
      sessionRename: { sessionId: target.sessionId, originalTitle: target.title }
    })
  }

  const handleDelete = (): void => {
    set({ confirmDelete: { label: target.title, title_fallback: target.title_fallback, sessionId: target.sessionId } })
  }

  return (
    <Content className={MENU_CLASS_NAME} data-testid="session-context-menu">
      <Item className={MENU_ITEM_CLASS_NAME} data-testid="session-rename-menu" onSelect={handleRename}>
        <Icon name="edit-square" size={13} />
        <span className={MENU_ITEM_TEXT_CLASS_NAME}>{t('sessionMenu.rename')}</span>
      </Item>
      <Separator />
      <Item className={DANGER_ITEM_CLASS_NAME} data-testid="session-delete-menu" onSelect={handleDelete}>
        <Icon name="close" size={13} />
        <span className={MENU_ITEM_TEXT_CLASS_NAME}>{t('sessionMenu.delete')}</span>
      </Item>
    </Content>
  )
}

function SessionMenu({
  children,
  mode,
  onOpenChange,
  target
}: {
  children: React.ReactNode
  mode: 'context' | 'dropdown'
  onOpenChange?: (open: boolean) => void
  target: SessionContextMenuTarget
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false)

  const updateOpen = (nextOpen: boolean): void => {
    setOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }

  const menu = mode === 'context'
    ? (
        <ContextMenu open={open} onOpenChange={updateOpen}>
          <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
          <SessionMenuContent parts={contextParts} target={target} />
        </ContextMenu>
      )
    : (
        <DropdownMenu open={open} onOpenChange={updateOpen}>
          <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
          <SessionMenuContent parts={dropdownParts} target={target} />
        </DropdownMenu>
      )

  return menu
}

export function SessionContextMenu({
  children,
  onOpenChange,
  target
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
  target
}: {
  children: React.ReactNode
  onOpenChange?: (open: boolean) => void
  target: SessionContextMenuTarget
}): React.JSX.Element {
  return (
    <SessionMenu mode="dropdown" onOpenChange={onOpenChange} target={target}>
      {children}
    </SessionMenu>
  )
}
