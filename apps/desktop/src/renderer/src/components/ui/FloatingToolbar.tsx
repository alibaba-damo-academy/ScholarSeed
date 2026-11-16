import type { HTMLAttributes, ReactNode } from 'react'
import { forwardRef, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { GripVertical, MoveDiagonal } from 'lucide-react'
import { IconButton } from './IconButton'

import { floatingToolbarActionsClassName, floatingToolbarClassName } from './classes'

export interface FloatingToolbarProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  actions: ReactNode
  children?: ReactNode
  expanded?: boolean
  label: string
  onMove?: (delta: { x: number; y: number }) => void
  onResize?: (delta: { x: number; y: number }, edge?: { x: number; y: number }) => void
  resizeHandle?: 'button' | 'edges'
  moveHandle?: 'button' | 'surface'
}

const KEYBOARD_STEP = 16
const RESIZE_EDGES = [
  {
    name: 'top',
    x: 0,
    y: -1,
    className: 'inset-x-[var(--vds-space-1)] top-0 h-[var(--vds-space-1)] cursor-n-resize',
  },
  {
    name: 'bottom',
    x: 0,
    y: 1,
    className: 'inset-x-[var(--vds-space-1)] bottom-0 h-[var(--vds-space-1)] cursor-s-resize',
  },
  {
    name: 'left',
    x: -1,
    y: 0,
    className: 'inset-y-[var(--vds-space-1)] left-0 w-[var(--vds-space-1)] cursor-w-resize',
  },
  {
    name: 'right',
    x: 1,
    y: 0,
    className: 'inset-y-[var(--vds-space-1)] right-0 w-[var(--vds-space-1)] cursor-e-resize',
  },
  {
    name: 'top-left',
    x: -1,
    y: -1,
    className: 'left-0 top-0 size-[var(--vds-space-1)] cursor-nw-resize',
  },
  {
    name: 'top-right',
    x: 1,
    y: -1,
    className: 'right-0 top-0 size-[var(--vds-space-1)] cursor-ne-resize',
  },
  {
    name: 'bottom-left',
    x: -1,
    y: 1,
    className: 'bottom-0 left-0 size-[var(--vds-space-1)] cursor-sw-resize',
  },
  {
    name: 'bottom-right',
    x: 1,
    y: 1,
    className: 'bottom-0 right-0 size-[var(--vds-space-1)] cursor-se-resize',
  },
]

/**
 * Opaque, elevated shell for contextual actions anchored over product content.
 * Positioning and business state remain owned by the consuming feature.
 */
export const FloatingToolbar = forwardRef<HTMLDivElement, FloatingToolbarProps>(
  (
    {
      actions,
      children,
      className,
      expanded = false,
      label,
      onMove,
      onResize,
      resizeHandle = 'button',
      moveHandle = 'button',
      ...props
    },
    ref
  ) => {
    const { t } = useTranslation('ui')
    const pointer = useRef<{ x: number; y: number } | null>(null)
    const controls = (change: (delta: { x: number; y: number }) => void, surface = false) => ({
      onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
        if (event.button !== 0) return
        if (
          surface &&
          event.target instanceof Element &&
          event.target.closest('button, input, textarea, select, a, [role="switch"]')
        )
          return
        event.preventDefault()
        pointer.current = { x: event.clientX, y: event.clientY }
        event.currentTarget.setPointerCapture(event.pointerId)
      },
      onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
        if (!pointer.current) return
        change({ x: event.clientX - pointer.current.x, y: event.clientY - pointer.current.y })
        pointer.current = { x: event.clientX, y: event.clientY }
      },
      onPointerUp: () => {
        pointer.current = null
      },
      onPointerCancel: () => {
        pointer.current = null
      },
      onLostPointerCapture: () => {
        pointer.current = null
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
        if (surface && event.target !== event.currentTarget) return
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        change({
          x:
            event.key === 'ArrowLeft'
              ? -KEYBOARD_STEP
              : event.key === 'ArrowRight'
                ? KEYBOARD_STEP
                : 0,
          y:
            event.key === 'ArrowUp'
              ? -KEYBOARD_STEP
              : event.key === 'ArrowDown'
                ? KEYBOARD_STEP
                : 0,
        })
      },
    })
    return (
      <div
        className={floatingToolbarClassName({ className, expanded })}
        data-state={expanded ? 'expanded' : 'collapsed'}
        ref={ref}
        {...props}
      >
        <div
          aria-label={label}
          className={`${floatingToolbarActionsClassName}${onMove ? (moveHandle === 'surface' ? ' shrink-0 flex-wrap cursor-move touch-none' : ' shrink-0 overflow-x-auto') : ''}`}
          role="toolbar"
          tabIndex={onMove && moveHandle === 'surface' ? 0 : undefined}
          {...(onMove && moveHandle === 'surface' ? controls(onMove, true) : {})}
        >
          {onMove && moveHandle === 'button' && (
            <IconButton
              label={t('floatingWindow.move', { title: label })}
              icon={<GripVertical size={14} />}
              size="sm"
              variant="ghost"
              className="cursor-move touch-none"
              {...controls(onMove)}
            />
          )}
          {actions}
        </div>
        {children}
        {onResize &&
          resizeHandle === 'edges' &&
          RESIZE_EDGES.map((edge) => (
            <div
              key={edge.name}
              role="separator"
              aria-label={t('floatingWindow.resize')}
              aria-orientation={edge.x === 0 ? 'horizontal' : 'vertical'}
              tabIndex={0}
              data-resize-edge={edge.name}
              className={`absolute z-[var(--vds-z-local-control)] touch-none focus-visible:shadow-[var(--vds-focus-ring)] ${edge.className}`}
              {...controls((delta) => onResize(delta, edge))}
            />
          ))}
        {onResize && resizeHandle === 'button' && (
          <IconButton
            label={t('floatingWindow.resize')}
            icon={<MoveDiagonal size={14} />}
            size="sm"
            variant="ghost"
            className="absolute bottom-0 right-0 cursor-se-resize touch-none"
            {...controls(onResize)}
          />
        )}
      </div>
    )
  }
)

FloatingToolbar.displayName = 'FloatingToolbar'
