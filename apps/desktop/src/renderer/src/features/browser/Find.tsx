import type * as React from 'react'
import { useRef, useState, type RefObject } from 'react'
import { ArrowDown, ArrowUp, GripVertical, X } from 'lucide-react'
import { IconButton, Input, Popover, PopoverContent } from '../../components/ui'
import { PAGE_LIMIT } from '../../../../browser'
import type { MenuModel } from '../../../../menu'

export interface FindLabels {
  title: string
  move: string
  previous: string
  next: string
  close: string
  status: string
}
export function FindPanel({
  anchor,
  input,
  text,
  labels,
  onText,
  onSubmit,
  onClose,
}: {
  anchor: MenuModel['anchor']
  input: RefObject<HTMLInputElement | null>
  text: string
  labels: FindLabels
  onText(text: string, composing: boolean): void
  onSubmit(direction: 'forward' | 'backward'): void
  onClose(): void
}): React.JSX.Element {
  const [position, setPosition] = useState<{ kind: 'point'; x: number; y: number } | null>(null)
  const drag = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null)
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <PopoverContent
        autoFocus={false}
        trapFocus
        side="bottom"
        align="end"
        aria-label={labels.title}
        data-testid="browser-find"
        className="w-[var(--vds-browser-find-width)] max-w-full"
        position={
          position ?? {
            kind: 'anchor',
            left: anchor.x,
            top: anchor.y,
            bottom: anchor.y + anchor.height,
            width: anchor.width,
          }
        }
      >
        <div className="flex items-center gap-[var(--vds-space-2)]">
          <IconButton
            variant="ghost"
            size="sm"
            label={labels.move}
            icon={<GripVertical />}
            className="shrink-0 cursor-grab touch-none active:cursor-grabbing"
            onPointerDown={(event) => {
              if (event.button !== 0) return
              const panel = event.currentTarget.closest('[role="region"]')
              if (!panel) return
              const bounds = panel.getBoundingClientRect()
              event.preventDefault()
              drag.current = {
                pointerId: event.pointerId,
                offsetX: event.clientX - bounds.x,
                offsetY: event.clientY - bounds.y,
              }
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={(event) => {
              if (drag.current?.pointerId !== event.pointerId) return
              setPosition({
                kind: 'point',
                x: event.clientX - drag.current.offsetX,
                y: event.clientY - drag.current.offsetY,
              })
            }}
            onPointerUp={(event) => {
              if (drag.current?.pointerId !== event.pointerId) return
              drag.current = null
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId)
            }}
            onPointerCancel={() => {
              drag.current = null
            }}
            onLostPointerCapture={() => {
              drag.current = null
            }}
          />
          <div className="min-w-0 flex-1">
            <Input
              ref={input}
              aria-label={labels.title}
              value={text}
              maxLength={PAGE_LIMIT.text}
              onChange={(event) =>
                onText(event.target.value, (event.nativeEvent as InputEvent).isComposing)
              }
              onCompositionEnd={(event) => onText(event.currentTarget.value, false)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.key !== 'Enter') return
                event.preventDefault()
                onSubmit(event.shiftKey ? 'backward' : 'forward')
              }}
            />
          </div>
          <div
            role="status"
            className="shrink-0 whitespace-nowrap text-[var(--vds-text-secondary)]"
          >
            {labels.status}
          </div>
          <IconButton
            variant="ghost"
            label={labels.previous}
            icon={<ArrowUp />}
            disabled={!text}
            onClick={() => onSubmit('backward')}
          />
          <IconButton
            variant="ghost"
            label={labels.next}
            icon={<ArrowDown />}
            disabled={!text}
            onClick={() => onSubmit('forward')}
          />
          <IconButton variant="ghost" label={labels.close} icon={<X />} onClick={onClose} />
        </div>
      </PopoverContent>
    </Popover>
  )
}
