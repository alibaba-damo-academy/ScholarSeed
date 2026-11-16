import type * as React from 'react'
import {
  MenuArrow,
  MenuCheckboxItem,
  MenuContent,
  type MenuContentProps,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioItem,
  MenuRoot,
  type MenuRootProps,
  MenuSeparator,
  MenuShortcut,
  MenuSubTrigger,
  MenuTrigger,
} from './Menu'
import { cx } from './utils'
import { type ReactNode } from 'react'

const DROPDOWN_MENU_CONTENT_CLASS_NAME = 'border-0 shadow-[var(--vds-shadow-2-center)]'

export const DropdownMenuArrow = MenuArrow
export const DropdownMenu = MenuRoot
export const DropdownMenuTrigger = MenuTrigger
// DropdownMenu 默认从触发器下方展开，并让菜单左边缘对齐触发器左侧。
export const DropdownMenuContent = ({
  align = 'start',
  className,
  side = 'bottom',
  ...props
}: MenuContentProps): React.JSX.Element | null => (
  <MenuContent
    align={align}
    className={cx(DROPDOWN_MENU_CONTENT_CLASS_NAME, className)}
    side={side}
    {...props}
  />
)
export const DropdownMenuItem = MenuItem
export const DropdownMenuGroup = MenuGroup
export const DropdownMenuSeparator = MenuSeparator
export const DropdownMenuLabel = MenuLabel
export const DropdownMenuShortcut = MenuShortcut
export const DropdownMenuPortal = ({ children }: { children?: ReactNode }): React.JSX.Element => (
  <>{children}</>
)
export const DropdownMenuSub = ({
  children,
  ...props
}: Omit<MenuRootProps, 'closeOnSiblingOpen' | 'nested'>): React.JSX.Element => (
  <MenuRoot closeOnSiblingOpen={false} {...props} nested>
    {children}
  </MenuRoot>
)
export const DropdownMenuSubContent = ({
  className,
  side = 'right',
  ...props
}: MenuContentProps): React.JSX.Element | null => (
  <MenuContent className={cx(DROPDOWN_MENU_CONTENT_CLASS_NAME, className)} {...props} side={side} />
)
export const DropdownMenuSubTrigger = MenuSubTrigger
export const DropdownMenuRadioGroup = MenuGroup
export const DropdownMenuCheckboxItem = MenuCheckboxItem
export const DropdownMenuRadioItem = MenuRadioItem
