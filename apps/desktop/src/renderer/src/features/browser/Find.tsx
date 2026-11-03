import type { RefObject } from 'react'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { IconButton, Input, Popover, PopoverContent } from '../../components/ui'
import { PAGE_LIMIT } from '../../../../browser'
import type { MenuModel } from '../../../../menu'

export interface FindLabels { title: string; previous: string; next: string; close: string; status: string }
export function FindPanel({ anchor, input, text, labels, onText, onSubmit, onClose }: {
  anchor: MenuModel['anchor']; input: RefObject<HTMLInputElement>; text: string; labels: FindLabels
  onText(text: string, composing: boolean): void; onSubmit(direction: 'forward' | 'backward'): void; onClose(): void
}): JSX.Element {
  return <Popover open onOpenChange={open => { if (!open) onClose() }}>
    <PopoverContent autoFocus={false} trapFocus side="bottom" align="end" aria-label={labels.title} data-testid="browser-find"
      className="w-[var(--vds-popover-width-md)] max-w-full"
      position={{ kind: 'anchor', left: anchor.x, top: anchor.y, bottom: anchor.y + anchor.height, width: anchor.width }}>
      <div className="flex items-center gap-[var(--vds-space-2)]">
        <div className="min-w-0 flex-1"><Input ref={input} aria-label={labels.title} value={text} maxLength={PAGE_LIMIT.text}
          onChange={event => onText(event.target.value, (event.nativeEvent as InputEvent).isComposing)}
          onCompositionEnd={event => onText(event.currentTarget.value, false)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.key !== 'Enter') return
            event.preventDefault()
            onSubmit(event.shiftKey ? 'backward' : 'forward')
          }} /></div>
        <IconButton variant="ghost" label={labels.previous} icon={<ArrowUp />} disabled={!text} onClick={() => onSubmit('backward')} />
        <IconButton variant="ghost" label={labels.next} icon={<ArrowDown />} disabled={!text} onClick={() => onSubmit('forward')} />
        <IconButton variant="ghost" label={labels.close} icon={<X />} onClick={onClose} />
      </div>
      <div role="status" className="text-[var(--vds-text-secondary)]">{labels.status}</div>
    </PopoverContent>
  </Popover>
}
