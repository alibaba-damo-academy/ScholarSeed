import type * as React from 'react'
import { usePortalDocument } from './portal'
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
  type RefObject,
} from 'react'
import { Portal } from './portal'
import { Check, ChevronRight } from 'lucide-react'

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
  menuTriggerClassName,
} from './classes'
import { cx } from './utils'
import { inFocusScope, useFocusScope, visibleContent } from './focus'
import { menuPositionStyle, type MenuPosition } from './placement'

interface MenuContextValue {
  closeMenu: () => void
  contentId: string
  contentRef: RefObject<HTMLDivElement | null>
  openMenu: (open: boolean) => void
  open: boolean
  position: MenuPosition | null
  setPosition: (position: MenuPosition | null) => void
  setOpen: (open: boolean) => void
  triggerRef: RefObject<HTMLElement | null>
}

const MenuContext = createContext<MenuContextValue | null>(null)
const MenuPointerMotionContext = createContext<RefObject<boolean> | null>(null)

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
  nested?: boolean
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
  open: controlledOpen,
  nested = false,
}: MenuRootProps): React.JSX.Element {
  const parent = useContext(MenuContext)
  const document = usePortalDocument()
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
  const closeMenu = (): void => {
    setMenuOpen(false)
    if (nested) parent?.closeMenu()
  }

  useEffect(() => {
    if (!closeOnSiblingOpen) return
    const closeSiblingMenu = (event: Event): void => {
      const detail = (event as CustomEvent<{ id: string }>).detail
      if (detail?.id && detail.id !== id) setMenuOpen(false)
    }
    document.addEventListener(MENU_OPEN_EVENT, closeSiblingMenu)
    return () => document.removeEventListener(MENU_OPEN_EVENT, closeSiblingMenu)
  }, [closeOnSiblingOpen, id, document])

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (
        !visibleContent(contentRef.current) ||
        inFocusScope(contentRef.current, event.target) ||
        triggerRef.current?.contains(event.target as Node)
      )
        return
      setMenuOpen(false)
    }
    // Escape 关闭并把焦点还给触发按钮：键盘用户不应在菜单消失后失焦到 body。
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.key !== 'Escape' || !visibleContent(contentRef.current))
        return
      const focusedMenu = document.activeElement?.closest('[role="menu"]')
      if (focusedMenu !== contentRef.current && document.activeElement !== triggerRef.current)
        return
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
  }, [open, document])

  const openMenu = (nextOpen: boolean): void => {
    setMenuOpen(nextOpen)
    if (nextOpen && closeOnSiblingOpen) {
      document.dispatchEvent(new CustomEvent(MENU_OPEN_EVENT, { detail: { id } }))
    }
  }

  return (
    <MenuContext.Provider
      value={{
        closeMenu,
        contentId: id,
        contentRef,
        open,
        openMenu,
        position,
        setOpen: setMenuOpen,
        setPosition,
        triggerRef,
      }}
    >
      {children}
    </MenuContext.Provider>
  )
}

export function MenuTrigger({
  asChild = false,
  children,
  className,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }): React.JSX.Element {
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
      setPosition({
        bottom: rect.bottom,
        kind: 'anchor',
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      })
      openMenu(!open)
    },
    ref: triggerRef as RefObject<HTMLButtonElement | null>,
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
      type: child.props.type ?? 'button',
    })
  }
  return (
    <button {...triggerProps} type="button">
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
}: HTMLAttributes<HTMLDivElement> & { asChild?: boolean }): React.JSX.Element {
  const { contentId, open, openMenu, setPosition, triggerRef } =
    useMenuContext('ContextMenuTrigger')
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
    ref: triggerRef as RefObject<HTMLDivElement | null>,
  }
  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<HTMLAttributes<HTMLDivElement>>
    return cloneElement(child, {
      ...triggerProps,
      className: cx(child.props.className, className),
      onContextMenu: (event: MouseEvent<HTMLDivElement>) => {
        child.props.onContextMenu?.(event)
        triggerProps.onContextMenu(event)
      },
    })
  }
  return (
    <div role="button" tabIndex={0} {...triggerProps}>
      {children}
    </div>
  )
}

export interface MenuContentProps extends HTMLAttributes<HTMLDivElement> {
  /** Keep one active row; stationary pointers must not compete with keyboard navigation. */
  coordinateNavigation?: boolean
  horizontalAnchorRef?: RefObject<HTMLElement | null>
  sideOffset?: number | `--${string}`
  position?: MenuPosition
  /** Hover-driven submenus can leave focus on their trigger until keyboard entry. */
  autoFocus?: boolean
  trapFocus?: boolean
  /** anchor 定位下菜单相对触发器的水平对齐；point（右键）定位不受影响。 */
  align?: 'center' | 'end' | 'start'
  /** 菜单相对触发器的首选方位；空间不足时自动翻向另一侧。 */
  side?: 'bottom' | 'left' | 'right' | 'top'
}

export function MenuContent({
  coordinateNavigation = false,
  horizontalAnchorRef,
  sideOffset,
  autoFocus = true,
  trapFocus = false,
  align = 'start',
  className,
  side = 'bottom',
  style,
  position: controlledPosition,
  onKeyDown,
  onKeyDownCapture,
  onPointerMoveCapture,
  ...props
}: MenuContentProps): React.JSX.Element | null {
  const document = usePortalDocument()
  const window = document.defaultView ?? globalThis.window
  const { contentId, contentRef, open, position: triggerPosition } = useMenuContext('MenuContent')
  const position = controlledPosition ?? triggerPosition
  const [floatingStyle, setFloatingStyle] = useState<CSSProperties | undefined>(undefined)
  const [navigation, setNavigation] = useState<'keyboard' | 'pointer'>('keyboard')
  const pointerPosition = useRef<{ x: number; y: number } | null>(null)
  const pointerMoved = useRef(false)
  useEffect(() => {
    if (!coordinateNavigation) return
    const trackPointer = (event: PointerEvent): void => {
      const previous = pointerPosition.current
      pointerMoved.current =
        previous === null || previous.x !== event.clientX || previous.y !== event.clientY
      pointerPosition.current = { x: event.clientX, y: event.clientY }
    }
    document.addEventListener('pointermove', trackPointer, true)
    return () => document.removeEventListener('pointermove', trackPointer, true)
  }, [coordinateNavigation, document])
  useLayoutEffect(() => {
    if (open) setNavigation('keyboard')
  }, [open])

  useLayoutEffect(() => {
    if (!open || !position || !contentRef.current) {
      setFloatingStyle(undefined)
      return
    }

    const reposition = (): void => {
      if (!contentRef.current) return
      const contentRect = contentRef.current.getBoundingClientRect()
      const horizontalAnchor = horizontalAnchorRef?.current?.getBoundingClientRect()
      const anchoredPosition =
        horizontalAnchor && position.kind === 'anchor'
          ? {
              ...position,
              left: horizontalAnchor.left,
              right: horizontalAnchor.right,
              width: horizontalAnchor.width,
            }
          : position
      const measuredOffset =
        typeof sideOffset === 'string'
          ? Number.parseFloat(getComputedStyle(contentRef.current).getPropertyValue(sideOffset))
          : sideOffset
      const offset =
        measuredOffset !== undefined && Number.isFinite(measuredOffset) ? measuredOffset : undefined
      setFloatingStyle(
        menuPositionStyle(
          anchoredPosition,
          contentRect,
          { width: window.innerWidth, height: window.innerHeight },
          side,
          align,
          offset
        )
      )
    }
    reposition()
    const observer = new ResizeObserver(reposition)
    observer.observe(contentRef.current)
    if (horizontalAnchorRef?.current) observer.observe(horizontalAnchorRef.current)
    window.addEventListener('resize', reposition)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', reposition)
    }
  }, [align, contentRef, horizontalAnchorRef, open, position, side, sideOffset, window])

  const positionedStyle = position
    ? {
        visibility: floatingStyle ? ('visible' as const) : ('hidden' as const),
        ...floatingStyle,
        ...style,
      }
    : style
  useFocusScope(contentRef, open && positionedStyle?.visibility !== 'hidden', trapFocus, autoFocus)
  if (!open || typeof document === 'undefined') return null
  return (
    <Portal>
      <MenuPointerMotionContext.Provider value={coordinateNavigation ? pointerMoved : null}>
        <div
          className={cx(
            menuContentClassName,
            'no-drag',
            coordinateNavigation &&
              '[&[data-navigation=keyboard]_:is(button,[role=menuitem]):hover:not(:focus):not([aria-expanded=true])]:!bg-transparent',
            className
          )}
          id={contentId}
          tabIndex={-1}
          ref={contentRef}
          role="menu"
          style={positionedStyle}
          {...props}
          data-navigation={coordinateNavigation ? navigation : undefined}
          onKeyDownCapture={(event) => {
            onKeyDownCapture?.(event)
            if (
              coordinateNavigation &&
              ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key)
            )
              setNavigation('keyboard')
          }}
          onPointerMoveCapture={(event) => {
            onPointerMoveCapture?.(event)
            if (
              !coordinateNavigation ||
              event.pointerType !== 'mouse' ||
              !(event.target instanceof Element) ||
              event.target.closest('[role="menu"]') !== event.currentTarget
            )
              return
            if (!pointerMoved.current) return
            setNavigation('pointer')
            const item = event.target.closest<HTMLElement>(`${MENU_ITEM_SELECTOR}, button`)
            if (item && !item.matches(':disabled') && item.getAttribute('aria-disabled') !== 'true')
              item.focus({ preventScroll: true })
          }}
          onKeyDown={(event) => {
            onKeyDown?.(event)
            if (
              event.defaultPrevented ||
              (event.target as HTMLElement).closest('[role="menu"]') !== event.currentTarget
            )
              return
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR),
            ].filter(
              (item) =>
                item.closest('[role="menu"]') === event.currentTarget &&
                !item.matches(':disabled') &&
                item.getAttribute('aria-disabled') !== 'true' &&
                visibleContent(item)
            )
            if (!items.length) return
            event.preventDefault()
            const current = items.indexOf(document.activeElement as HTMLElement)
            const index =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? items.length - 1
                  : event.key === 'ArrowDown'
                    ? (current + 1) % items.length
                    : (current - 1 + items.length) % items.length
            items[index].focus()
          }}
        />
      </MenuPointerMotionContext.Provider>
    </Portal>
  )
}

export function MenuArrow(): React.JSX.Element {
  return <ChevronRight aria-hidden="true" className={menuChevronClassName} />
}

export function MenuSubTrigger({
  children,
  className,
  inset = false,
  openOnHover = false,
  onPointerEnter,
  onPointerMove,
  onKeyDown,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  inset?: boolean
  openOnHover?: boolean
}): React.JSX.Element {
  const { contentId, open, setOpen, setPosition, triggerRef } = useMenuContext('MenuSubTrigger')
  const pointerMotion = useContext(MenuPointerMotionContext)
  const expand = (element: HTMLElement): void => {
    const rect = element.getBoundingClientRect()
    setPosition({
      bottom: rect.bottom,
      kind: 'anchor',
      left: rect.left,
      right: rect.right,
      top: rect.top,
      width: rect.width,
    })
    setOpen(true)
  }
  return (
    <button
      aria-expanded={open}
      aria-controls={contentId}
      aria-haspopup="menu"
      ref={triggerRef as RefObject<HTMLButtonElement | null>}
      className={cx(
        menuItemClassName,
        menuSubTriggerClassName,
        inset && menuItemInsetClassName,
        className
      )}
      onPointerEnter={(event) => {
        onPointerEnter?.(event)
        if (event.currentTarget.closest('[data-navigation="keyboard"]')) return
        if (openOnHover && !props.disabled && !event.defaultPrevented) expand(event.currentTarget)
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event)
        if (pointerMotion && !pointerMotion.current) return
        if (openOnHover && !open && !props.disabled && !event.defaultPrevented)
          expand(event.currentTarget)
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (!event.defaultPrevented && event.key === 'ArrowRight') {
          event.preventDefault()
          expand(event.currentTarget)
          requestAnimationFrame(() =>
            document
              .getElementById(contentId)
              ?.querySelector<HTMLElement>(MENU_ITEM_SELECTOR)
              ?.focus()
          )
        }
      }}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        const rect = event.currentTarget.getBoundingClientRect()
        setPosition({
          bottom: rect.bottom,
          kind: 'anchor',
          left: rect.left,
          right: rect.right,
          top: rect.top,
          width: rect.width,
        })
        setOpen(openOnHover || !open)
      }}
      role="menuitem"
      type="button"
      {...props}
    >
      {children}
      <MenuArrow />
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
}: MenuItemProps & { destructive?: boolean }): React.JSX.Element {
  const { closeMenu } = useMenuContext('MenuItem')
  return (
    <button
      className={cx(
        destructive ? menuItemDestructiveClassName : menuItemClassName,
        inset && menuItemInsetClassName,
        'disabled:!cursor-not-allowed',
        className
      )}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented || disabled) return
        onSelect?.()
        closeMenu()
      }}
      role="menuitem"
      type="button"
      {...props}
    />
  )
}

export const MenuGroup = ({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): React.JSX.Element => (
  <div className={cx(menuGroupClassName, className)} {...props} />
)
export const MenuSeparator = ({
  className,
  ...props
}: HTMLAttributes<HTMLHRElement>): React.JSX.Element => (
  <hr className={cx(menuSeparatorClassName, className)} {...props} />
)
export const MenuLabel = ({
  className,
  inset = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & { inset?: boolean }): React.JSX.Element => (
  <div className={cx(menuLabelClassName, inset && menuLabelInsetClassName, className)} {...props} />
)
export const MenuShortcut = ({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>): React.JSX.Element => (
  <span className={cx(menuShortcutClassName, className)} {...props} />
)

export interface MenuCheckboxItemProps extends MenuItemProps {
  checked?: boolean
  indicatorAlign?: 'start' | 'end'
  onCheckedChange?: (checked: boolean) => void
}

export function MenuCheckboxItem({
  checked,
  indicatorAlign = 'start',
  children,
  className,
  onCheckedChange,
  onSelect,
  ...props
}: MenuCheckboxItemProps): React.JSX.Element {
  return (
    <MenuItem
      aria-checked={checked}
      className={cx(
        indicatorAlign === 'end' ? 'relative pr-[var(--vds-space-8)]' : menuItemCheckableClassName,
        className
      )}
      role="menuitemcheckbox"
      onSelect={() => {
        onCheckedChange?.(!checked)
        onSelect?.()
      }}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cx(
          menuIndicatorClassName,
          indicatorAlign === 'end' && '!left-auto right-[var(--vds-space-2)]'
        )}
      >
        {checked ? '✓' : null}
      </span>
      {children}
    </MenuItem>
  )
}

export function MenuRadioItem({
  checked,
  children,
  className,
  variant = 'default',
  ...props
}: MenuItemProps & { checked?: boolean; variant?: 'default' | 'select' }): React.JSX.Element {
  return (
    <MenuItem
      aria-checked={checked}
      className={cx(
        menuItemCheckableClassName,
        variant === 'select' &&
          '!px-[var(--vds-space-3)] aria-checked:!bg-[var(--vds-brand-light-bg-default)] aria-checked:!text-[var(--vds-brand-text-primary)]',
        className
      )}
      role="menuitemradio"
      {...props}
    >
      {variant === 'default' && (
        <span aria-hidden="true" className={menuIndicatorClassName}>
          {checked ? '•' : null}
        </span>
      )}
      {children}
      {variant === 'select' && checked && (
        <Check
          aria-hidden="true"
          className="ml-auto size-[var(--vds-icon-7)] shrink-0 !text-current"
        />
      )}
    </MenuItem>
  )
}
