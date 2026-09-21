import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'

import {
  menuChevronClassName,
  menuContentClassName,
  menuContextTriggerClassName,
  menuGroupClassName,
  menuIndicatorClassName,
  menuItemCheckableClassName,
  menuItemClassName,
  menuItemDestructiveClassName,
  menuItemInsetClassName,
  menuLabelClassName,
  menuLabelInsetClassName,
  menuSeparatorClassName,
  menuShortcutClassName,
  menuSubTriggerClassName,
  menuTriggerClassName
} from './classes'
import { cx } from './utils'
import { inFocusScope, useFocusScope, visibleContent } from './focus'
import { menuPositionStyle, type MenuPosition } from './placement'

interface MenuContextValue {
  contentId: string
  contentRef: RefObject<HTMLDivElement>
  openMenu: (open: boolean) => void
  open: boolean
  position: MenuPosition | null
  setPosition: (position: MenuPosition | null) => void
  setOpen: (open: boolean) => void
  triggerRef: RefObject<HTMLElement>
}

const MenuContext = createContext<MenuContextValue | null>(null)

function useMenuContext(component: string): MenuContextValue {
  const context = useContext(MenuContext)
  if (!context) throw new Error(`${component} must be used inside menu root`)
  return context
}

export interface MenuRootProps {
  children?: ReactNode
  closeOnSiblingOpen?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  open?: boolean
}

export interface MenuItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect'> {
  inset?: boolean
  onSelect?: () => void
}

const MENU_ITEM_SELECTOR = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'
const MENU_OPEN_EVENT = 'vds-menu-open'

export function MenuRoot({
  children,
  closeOnSiblingOpen = true,
  defaultOpen = false,
  onOpenChange,
  open: controlledOpen
}: MenuRootProps): JSX.Element {
  const id = useId()
  const contentRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLElement>(null)
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const open = controlledOpen ?? uncontrolledOpen
  const setMenuOpen = (nextOpen: boolean): void => {
    if (controlledOpen === undefined) setUncontrolledOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }

  useEffect(() => {
    if (!closeOnSiblingOpen) return
    const closeSiblingMenu = (event: Event): void => {
      const detail = (event as CustomEvent<{ id: string }>).detail
      if (detail?.id && detail.id !== id) setMenuOpen(false)
    }
    document.addEventListener(MENU_OPEN_EVENT, closeSiblingMenu)
    return () => document.removeEventListener(MENU_OPEN_EVENT, closeSiblingMenu)
  }, [closeOnSiblingOpen, id])

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!visibleContent(contentRef.current) || inFocusScope(contentRef.current, event.target) || triggerRef.current?.contains(event.target as Node)) return
      setMenuOpen(false)
    }
    // Escape 关闭并把焦点还给触发按钮：键盘用户不应在菜单消失后失焦到 body。
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.key !== 'Escape' || !visibleContent(contentRef.current)) return
      const focusedMenu = document.activeElement?.closest('[role="menu"]')
      if (focusedMenu !== contentRef.current && document.activeElement !== triggerRef.current) return
      event.preventDefault()
      setMenuOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const openMenu = (nextOpen: boolean): void => {
    setMenuOpen(nextOpen)
    if (nextOpen && closeOnSiblingOpen) {
      document.dispatchEvent(new CustomEvent(MENU_OPEN_EVENT, { detail: { id } }))
    }
  }

  return (
    <MenuContext.Provider value={{ contentId: id, contentRef, open, openMenu, position, setOpen: setMenuOpen, setPosition, triggerRef }}>
      {children}
    </MenuContext.Provider>
  )
}

export function MenuTrigger({ asChild = false, children, className, onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }): JSX.Element {
  const { contentId, open, openMenu, setPosition, triggerRef } = useMenuContext('MenuTrigger')
  const triggerProps = {
    ...props,
    'aria-expanded': open,
    'aria-controls': contentId,
    'aria-haspopup': 'menu' as const,
    className: cx(menuTriggerClassName, className),
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      onClick?.(event)
      if (event.defaultPrevented) return
      const rect = event.currentTarget.getBoundingClientRect()
      setPosition({ bottom: rect.bottom, kind: 'anchor', left: rect.left, right: rect.right, top: rect.top, width: rect.width })
      openMenu(!open)
    },
    ref: triggerRef as RefObject<HTMLButtonElement>
  }
  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>
    return cloneElement(child, {
      ...triggerProps,
      className: cx(child.props.className, className),
      onClick: (event: MouseEvent<HTMLButtonElement>) => {
        child.props.onClick?.(event)
        triggerProps.onClick(event)
      },
      type: child.props.type ?? 'button'
    })
  }
  return (
    <button
      {...triggerProps}
      type="button"
    >
      {children}
    </button>
  )
}

export function ContextMenuTrigger({
  asChild = false,
  children,
  className,
  onContextMenu,
  ...props
}: HTMLAttributes<HTMLDivElement> & { asChild?: boolean }): JSX.Element {
  const { contentId, open, openMenu, setPosition, triggerRef } = useMenuContext('ContextMenuTrigger')
  const triggerProps = {
    ...props,
    'aria-expanded': open,
    'aria-controls': contentId,
    'aria-haspopup': 'menu' as const,
    className: cx(menuContextTriggerClassName, className),
    onContextMenu: (event: MouseEvent<HTMLDivElement>) => {
      onContextMenu?.(event)
      if (event.defaultPrevented) return
      event.preventDefault()
      setPosition({ kind: 'point', x: event.clientX, y: event.clientY })
      openMenu(true)
    },
    ref: triggerRef as RefObject<HTMLDivElement>
  }
  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<HTMLAttributes<HTMLDivElement>>
    return cloneElement(child, {
      ...triggerProps,
      className: cx(child.props.className, className),
      onContextMenu: (event: MouseEvent<HTMLDivElement>) => {
        child.props.onContextMenu?.(event)
        triggerProps.onContextMenu(event)
      }
    })
  }
  return (
    <div
      role="button"
      tabIndex={0}
      {...triggerProps}
    >
      {children}
    </div>
  )
}

export interface MenuContentProps extends HTMLAttributes<HTMLDivElement> {
  position?: MenuPosition
  /** Hover-driven submenus can leave focus on their trigger until keyboard entry. */
  autoFocus?: boolean
  /** anchor 定位下菜单相对触发器的水平对齐；point（右键）定位不受影响。 */
  align?: 'center' | 'end' | 'start'
  /** 子菜单需要从父级菜单项侧边展开；普通菜单默认在触发器下方。right/left 为首选方位, 空间不足时自动翻向另一侧。 */
  side?: 'bottom' | 'left' | 'right'
}

export function MenuContent({ autoFocus = true, align = 'start', className, side = 'bottom', style, position: controlledPosition, onKeyDown, ...props }: MenuContentProps): JSX.Element | null {
  const { contentId, contentRef, open, position: triggerPosition } = useMenuContext('MenuContent')
  const position = controlledPosition ?? triggerPosition
  const [floatingStyle, setFloatingStyle] = useState<CSSProperties | undefined>(undefined)

  useLayoutEffect(() => {
    if (!open || !position || !contentRef.current) {
      setFloatingStyle(undefined)
      return
    }

    const reposition = (): void => {
      if (!contentRef.current) return
      const contentRect = contentRef.current.getBoundingClientRect()
      setFloatingStyle(menuPositionStyle(position, contentRect, { width: window.innerWidth, height: window.innerHeight }, side, align))
    }
    reposition()
    const observer = new ResizeObserver(reposition)
    observer.observe(contentRef.current)
    window.addEventListener('resize', reposition)
    return () => { observer.disconnect(); window.removeEventListener('resize', reposition) }

  }, [align, contentRef, open, position, side])

  const positionedStyle = position ? { visibility: floatingStyle ? 'visible' as const : 'hidden' as const, ...floatingStyle, ...style } : style
  useFocusScope(contentRef, open && positionedStyle?.visibility !== 'hidden', false, autoFocus)
  if (!open || typeof document === 'undefined') return null
  // Portal 到 body：fixed 定位不受父级 overflow/transform 影响，且菜单
  // 不会被裁进任何滚动容器（原生 select 之外的下拉/上下文菜单的通用前提）。
  return createPortal(
    <div className={cx(menuContentClassName, className)} id={contentId} tabIndex={-1} ref={contentRef} role="menu" style={positionedStyle} {...props}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.defaultPrevented || (event.target as HTMLElement).closest('[role="menu"]') !== event.currentTarget) return
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)]
          .filter(item => item.closest('[role="menu"]') === event.currentTarget && !item.matches(':disabled') && item.getAttribute('aria-disabled') !== 'true' && visibleContent(item))
        if (!items.length) return
        event.preventDefault()
        const current = items.indexOf(document.activeElement as HTMLElement)
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length
        items[index].focus()
      }} />,
    document.body
  )
}

export function MenuSubTrigger({ children, className, inset = false, openOnHover = false, onPointerEnter, onKeyDown, onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { inset?: boolean; openOnHover?: boolean }): JSX.Element {
  const { contentId, open, setOpen, setPosition, triggerRef } = useMenuContext('MenuSubTrigger')
  const expand = (element: HTMLElement): void => {
    const rect = element.getBoundingClientRect()
    setPosition({ bottom: rect.bottom, kind: 'anchor', left: rect.left, right: rect.right, top: rect.top, width: rect.width })
    setOpen(true)
  }
  return (
    <button
      aria-expanded={open}
      aria-controls={contentId}
      aria-haspopup="menu"
      ref={triggerRef as RefObject<HTMLButtonElement>}
      className={cx(menuItemClassName, menuSubTriggerClassName, inset && menuItemInsetClassName, className)}
      onPointerEnter={(event) => {
        onPointerEnter?.(event)
        if (openOnHover && !props.disabled && !event.defaultPrevented) expand(event.currentTarget)
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (!event.defaultPrevented && event.key === 'ArrowRight') {
          event.preventDefault()
          expand(event.currentTarget)
          requestAnimationFrame(() => document.getElementById(contentId)?.querySelector<HTMLElement>(MENU_ITEM_SELECTOR)?.focus())
        }
      }}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        const rect = event.currentTarget.getBoundingClientRect()
        setPosition({ bottom: rect.bottom, kind: 'anchor', left: rect.left, right: rect.right, top: rect.top, width: rect.width })
        setOpen(!open)
      }}
      role="menuitem"
      type="button"
      {...props}
    >
      {children}
      <span aria-hidden="true" className={menuChevronClassName}>›</span>
    </button>
  )
}

export function MenuItem({
  className,
  destructive = false,
  disabled,
  inset = false,
  onSelect,
  onClick,
  ...props
}: MenuItemProps & { destructive?: boolean }): JSX.Element {
  const { setOpen } = useMenuContext('MenuItem')
  return (
    <button
      className={cx(
        destructive ? menuItemDestructiveClassName : menuItemClassName,
        inset && menuItemInsetClassName,
        className
      )}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented || disabled) return
        onSelect?.()
        setOpen(false)
      }}
      role="menuitem"
      type="button"
      {...props}
    />
  )
}

export const MenuGroup = ({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element => <div className={cx(menuGroupClassName, className)} {...props} />
export const MenuSeparator = ({ className, ...props }: HTMLAttributes<HTMLHRElement>): JSX.Element => <hr className={cx(menuSeparatorClassName, className)} {...props} />
export const MenuLabel = ({ className, inset = false, ...props }: HTMLAttributes<HTMLDivElement> & { inset?: boolean }): JSX.Element => (
  <div className={cx(menuLabelClassName, inset && menuLabelInsetClassName, className)} {...props} />
)
export const MenuShortcut = ({ className, ...props }: HTMLAttributes<HTMLSpanElement>): JSX.Element => <span className={cx(menuShortcutClassName, className)} {...props} />

export interface MenuCheckboxItemProps extends MenuItemProps {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
}

export function MenuCheckboxItem({
  checked,
  children,
  className,
  onCheckedChange,
  onSelect,
  ...props
}: MenuCheckboxItemProps): JSX.Element {
  return (
    <MenuItem
      aria-checked={checked}
      className={cx(menuItemCheckableClassName, className)}
      role="menuitemcheckbox"
      onSelect={() => {
        onCheckedChange?.(!checked)
        onSelect?.()
      }}
      {...props}
    >
      <span aria-hidden="true" className={menuIndicatorClassName}>{checked ? '✓' : null}</span>
      {children}
    </MenuItem>
  )
}

export function MenuRadioItem({
  checked,
  children,
  className,
  ...props
}: MenuItemProps & { checked?: boolean }): JSX.Element {
  return (
    <MenuItem aria-checked={checked} className={cx(menuItemCheckableClassName, className)} role="menuitemradio" {...props}>
      <span aria-hidden="true" className={menuIndicatorClassName}>{checked ? '•' : null}</span>
      {children}
    </MenuItem>
  )
}
