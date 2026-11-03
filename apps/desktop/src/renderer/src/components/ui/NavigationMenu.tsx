import { cloneElement, createContext, isValidElement, useContext, useId, useState, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type HTMLAttributes, type ReactElement, type ReactNode } from 'react'

import { IconFont } from '../primitive/Iconfont'
import {
  navigationMenuChevronClassName,
  navigationMenuClassName,
  navigationMenuContentClassName,
  navigationMenuContentHiddenClassName,
  navigationMenuIndicatorClassName,
  navigationMenuItemClassName,
  navigationMenuLinkClassName,
  navigationMenuListClassName,
  navigationMenuTriggerClassName,
  navigationMenuViewportClassName
} from './classes'
import { cx } from './utils'

interface NavigationMenuContextValue {
  openItem: string
  setOpenItem: (value: string) => void
}

interface NavigationMenuItemContextValue {
  value: string
}

const NavigationMenuContext = createContext<NavigationMenuContextValue | null>(null)
const NavigationMenuItemContext = createContext<NavigationMenuItemContextValue | null>(null)

function useNavigationMenuContext(component: string): NavigationMenuContextValue {
  const context = useContext(NavigationMenuContext)
  if (!context) throw new Error(`${component} must be used inside NavigationMenu`)
  return context
}

export function NavigationMenu({ children, className, ...props }: HTMLAttributes<HTMLElement>): JSX.Element {
  const [openItem, setOpenItem] = useState('')
  return (
    <NavigationMenuContext.Provider value={{ openItem, setOpenItem }}>
      <nav className={cx(navigationMenuClassName, className)} {...props}>{children}</nav>
    </NavigationMenuContext.Provider>
  )
}

export function NavigationMenuList({ className, ...props }: HTMLAttributes<HTMLUListElement>): JSX.Element {
  return <ul className={cx(navigationMenuListClassName, className)} {...props} />
}

export function NavigationMenuItem({ children, className, ...props }: HTMLAttributes<HTMLLIElement>): JSX.Element {
  const value = useId()
  return (
    <NavigationMenuItemContext.Provider value={{ value }}>
      <li className={cx(navigationMenuItemClassName, className)} {...props}>{children}</li>
    </NavigationMenuItemContext.Provider>
  )
}

export function NavigationMenuTrigger({ children, className, onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  const { openItem, setOpenItem } = useNavigationMenuContext('NavigationMenuTrigger')
  const item = useContext(NavigationMenuItemContext)
  const value = item?.value ?? String(children)
  return (
    <button
      aria-expanded={openItem === value}
      className={cx(navigationMenuTriggerClassName, className)}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        setOpenItem(openItem === value ? '' : value)
      }}
      type="button"
      {...props}
    >
      {children}
      <IconFont className={navigationMenuChevronClassName} type="fill-switch-arrow-down" />
    </button>
  )
}

export function NavigationMenuContent({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  const { openItem } = useNavigationMenuContext('NavigationMenuContent')
  const item = useContext(NavigationMenuItemContext)
  const open = item?.value ? openItem === item.value : Boolean(openItem)
  return <div className={cx(navigationMenuContentClassName, !open && navigationMenuContentHiddenClassName, className)} {...props} />
}

export function NavigationMenuLink({
  asChild = false,
  children,
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { asChild?: boolean; children?: ReactNode }): JSX.Element {
  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<{ className?: string }>
    return cloneElement(child, {
      ...props,
      className: cx(navigationMenuLinkClassName, child.props.className, className)
    })
  }
  return <a className={cx(navigationMenuLinkClassName, className)} {...props}>{children}</a>
}
export const NavigationMenuIndicator = ({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element => <div className={cx(navigationMenuIndicatorClassName, className)} {...props} />
export const NavigationMenuViewport = ({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element => <div className={cx(navigationMenuViewportClassName, className)} {...props} />
export function navigationMenuTriggerStyle(): string {
  return navigationMenuTriggerClassName
}
