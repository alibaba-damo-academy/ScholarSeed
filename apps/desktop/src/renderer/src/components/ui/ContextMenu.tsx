import {
  ContextMenuTrigger,
  MenuCheckboxItem,
  MenuContent,
  type MenuContentProps,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuShortcut,
  MenuSubTrigger
} from './Menu'
import { type ReactNode } from 'react'

export const ContextMenu = MenuRoot
export { ContextMenuTrigger }
export const ContextMenuContent = MenuContent
export const ContextMenuItem = MenuItem
export const ContextMenuGroup = MenuGroup
export const ContextMenuSeparator = MenuSeparator
export const ContextMenuLabel = MenuLabel
export const ContextMenuShortcut = MenuShortcut
export const ContextMenuPortal = ({ children }: { children?: ReactNode }): JSX.Element => <>{children}</>
export const ContextMenuSub = ({ children, defaultOpen }: { children?: ReactNode; defaultOpen?: boolean }): JSX.Element => (
  <MenuRoot closeOnSiblingOpen={false} defaultOpen={defaultOpen}>{children}</MenuRoot>
)
export const ContextMenuSubContent = (props: MenuContentProps): JSX.Element | null => (
  <MenuContent {...props} side="right" />
)
export const ContextMenuSubTrigger = MenuSubTrigger
export const ContextMenuRadioGroup = MenuGroup
export const ContextMenuCheckboxItem = MenuCheckboxItem
export const ContextMenuRadioItem = MenuRadioItem
