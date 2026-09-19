import React, { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Maximize2, Minimize2 } from 'lucide-react'
import { IconButton } from '../ui'
import { Icon } from '../../icons'

const INITIAL_LEFT = 160
const INITIAL_TOP = 180
const MIN_WIDTH = 320
const MIN_HEIGHT = 180
const DEFAULT_WIDTH = 580
const DEFAULT_HEIGHT = 400
const WINDOW_MARGIN = 16
const KEYBOARD_MOVE = 16

/** Non-modal reader window; geometry is user-controlled, not a visual override. */
export function FloatingWindow({ title, onClose, children, footer, initialSize, pinned = false, onPinnedChange }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; initialSize?: { width: number; height: number }
  pinned?: boolean; onPinnedChange?: (pinned: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation('ui')
  const [box, setBox] = useState(() => {
    const width = Math.min(initialSize?.width ?? DEFAULT_WIDTH, innerWidth - WINDOW_MARGIN * 2)
    const height = Math.min(initialSize?.height ?? DEFAULT_HEIGHT, innerHeight - WINDOW_MARGIN * 2)
    return { left: Math.min(INITIAL_LEFT, innerWidth - width - WINDOW_MARGIN), top: Math.min(INITIAL_TOP, innerHeight - height - WINDOW_MARGIN), width, height }
  })
  const [maximized, setMaximized] = useState(false)
  const drag = useRef<{ x: number; y: number; box: typeof box; resize: boolean }>()
  const begin = (event: React.PointerEvent, resize: boolean): void => {
    if ((event.target as HTMLElement).closest('button')) return
    drag.current = { x: event.clientX, y: event.clientY, box, resize }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: React.PointerEvent): void => {
    const origin = drag.current
    if (!origin) return
    const dx = event.clientX - origin.x, dy = event.clientY - origin.y
    setBox(origin.resize
      ? { ...origin.box, width: Math.max(MIN_WIDTH, Math.min(innerWidth - origin.box.left - WINDOW_MARGIN, origin.box.width + dx)), height: Math.max(MIN_HEIGHT, Math.min(innerHeight - origin.box.top - WINDOW_MARGIN, origin.box.height + dy)) }
      : { ...origin.box, left: Math.max(WINDOW_MARGIN, Math.min(innerWidth - origin.box.width - WINDOW_MARGIN, origin.box.left + dx)), top: Math.max(WINDOW_MARGIN, Math.min(innerHeight - origin.box.height - WINDOW_MARGIN, origin.box.top + dy)) })
  }
  const moveByKeyboard = (event: React.KeyboardEvent): void => {
    if (event.target !== event.currentTarget) return
    if (!event.key.startsWith('Arrow')) return
    event.preventDefault()
    const horizontal = event.key === 'ArrowRight' ? KEYBOARD_MOVE : event.key === 'ArrowLeft' ? -KEYBOARD_MOVE : 0
    const vertical = event.key === 'ArrowDown' ? KEYBOARD_MOVE : event.key === 'ArrowUp' ? -KEYBOARD_MOVE : 0
    setBox(value => ({
      ...value,
      left: Math.max(WINDOW_MARGIN, Math.min(innerWidth - value.width - WINDOW_MARGIN, value.left + horizontal)),
      top: Math.max(WINDOW_MARGIN, Math.min(innerHeight - value.height - WINDOW_MARGIN, value.top + vertical))
    }))
  }
  return <section role="dialog" aria-modal="false" aria-label={title} style={maximized ? { left: WINDOW_MARGIN, top: WINDOW_MARGIN, width: innerWidth - WINDOW_MARGIN * 2, height: innerHeight - WINDOW_MARGIN * 2 } : box} className="fixed z-[var(--vds-z-popover)] flex flex-col overflow-hidden rounded-2xl border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] text-[var(--vds-text-primary)] shadow-xl" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <header aria-label={t('floatingWindow.move', { title })} tabIndex={0} className="flex cursor-move items-center justify-between border-b border-[var(--vds-border-default)] px-5 py-3 font-semibold" onKeyDown={moveByKeyboard} onPointerDown={event => begin(event, false)} onPointerMove={move} onPointerUp={() => { drag.current = undefined }} onPointerCancel={() => { drag.current = undefined }}><span>{title}</span><span className="flex items-center gap-1">{onPinnedChange ? <IconButton aria-pressed={pinned} label={t(pinned ? 'floatingWindow.unpin' : 'floatingWindow.pin')} icon={<Icon name="pin" size={16} />} variant={pinned ? 'secondary' : 'ghost'} onClick={() => onPinnedChange(!pinned)} /> : null}<IconButton data-testid="floating-window-toggle-size" label={t(maximized ? 'floatingWindow.restore' : 'floatingWindow.maximize')} icon={maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />} variant="ghost" onClick={() => setMaximized(value => !value)} /><IconButton label={t('floatingWindow.close', { title })} icon={<Icon name="close" size={16} />} variant="ghost" onClick={onClose} /></span></header>
    <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] px-4 py-3">{footer}</footer>}
    <div role="separator" aria-label={t('floatingWindow.resize')} tabIndex={0} className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize border-b-2 border-r-2 border-[var(--vds-border-default)]" onPointerDown={event => begin(event, true)} onPointerMove={move} onPointerUp={() => { drag.current = undefined }} onKeyDown={event => { if (event.key.startsWith('Arrow')) { event.preventDefault(); setBox(value => ({ ...value, width: Math.max(MIN_WIDTH, Math.min(innerWidth - value.left, value.width + (event.key === 'ArrowRight' ? WINDOW_MARGIN : event.key === 'ArrowLeft' ? -WINDOW_MARGIN : 0))), height: Math.max(MIN_HEIGHT, Math.min(innerHeight - value.top, value.height + (event.key === 'ArrowDown' ? WINDOW_MARGIN : event.key === 'ArrowUp' ? -WINDOW_MARGIN : 0))) })) } }} />
  </section>
}
