import {
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
  MenuSubTrigger,
  MenuTrigger
} from './Menu'
import { createContext, useContext, type HTMLAttributes, type ReactNode } from 'react'
import { menubarClassName, menubarTriggerClassName } from './classes'
import { cx } from './utils'

export const Menubar = ({ children, className }: { children?: ReactNode; className?: string }): JSX.Element => (
  <div className={cx(menubarClassName, className)} role="menubar">{children}</div>
)
export const MenubarMenu = MenuRoot
export const MenubarTrigger = ({ className, ...props }: Parameters<typeof MenuTrigger>[0]): JSX.Element => (
  <MenuTrigger className={cx(menubarTriggerClassName, className)} {...props} />
)
export const MenubarContent = MenuContent
export const MenubarItem = MenuItem
export const MenubarGroup = MenuGroup
export const MenubarSeparator = MenuSeparator
export const MenubarLabel = MenuLabel
export const MenubarShortcut = MenuShortcut
export const MenubarPortal = ({ children }: { children?: ReactNode }): JSX.Element => <>{children}</>
export const MenubarSub = ({ children, defaultOpen }: { children?: ReactNode; defaultOpen?: boolean }): JSX.Element => (
  <MenuRoot closeOnSiblingOpen={false} defaultOpen={defaultOpen}>{children}</MenuRoot>
)
export const MenubarSubContent = (props: MenuContentProps): JSX.Element | null => (
  <MenuContent {...props} side="right" />
)
export const MenubarSubTrigger = MenuSubTrigger
export const MenubarCheckboxItem = MenuCheckboxItem

interface MenubarRadioGroupContextValue {
  onValueChange?: (value: string) => void
  value?: string
}

const MenubarRadioGroupContext = createContext<MenubarRadioGroupContextValue | null>(null)

export function MenubarRadioGroup({
  children,
  onValueChange,
  value,
  ...props
}: HTMLAttributes<HTMLDivElement> & MenubarRadioGroupContextValue): JSX.Element {
  return (
    <MenubarRadioGroupContext.Provider value={{ onValueChange, value }}>
      <MenuGroup role="group" {...props}>{children}</MenuGroup>
    </MenubarRadioGroupContext.Provider>
  )
}

export function MenubarRadioItem({
  checked,
  onSelect,
  value,
  ...props
}: Parameters<typeof MenuRadioItem>[0] & { value?: string }): JSX.Element {
  const radioGroup = useContext(MenubarRadioGroupContext)
  const selected = value !== undefined && radioGroup?.value !== undefined ? radioGroup.value === value : checked

  return (
    <MenuRadioItem
      checked={selected}
      onSelect={() => {
        if (value !== undefined) radioGroup?.onValueChange?.(value)
        onSelect?.()
      }}
      {...props}
    />
  )
}
