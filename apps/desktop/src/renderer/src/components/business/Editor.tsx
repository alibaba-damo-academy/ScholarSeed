import React from 'react'
import type { ComposerDraftStore } from '../../draft'
import { Input, Textarea, type TextareaProps } from '../ui'
import { acceptsPrediction } from '../../prediction'

const COMPOSITION_KEY_CODE = 229
const SCROLL_EDGE_TOLERANCE_PX = 1
const SCROLL_INDICATOR_IDLE_MS = 500

function referenceBounds(element: Element): DOMRect[] {
  return getComputedStyle(element).display === 'contents'
    ? Array.from(element.children).flatMap(referenceBounds)
    : [element.getBoundingClientRect()]
}

export interface ComposerEditorLayout {
  multiline: boolean
  above: boolean
  below: boolean
}

export interface ComposerEditorReference {
  key: string
  content: React.ReactNode
  onRemove?: () => void
}

interface ComposerEditorProps extends Omit<
  TextareaProps,
  'value' | 'defaultValue' | 'onChange' | 'onCompositionStart' | 'onCompositionEnd'
> {
  draft: ComposerDraftStore
  references?: ComposerEditorReference[]
  onRemoveAllReferences?: () => void | boolean | Promise<boolean>
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  maxHeight: number
  maxRows?: number
  compactContainerRef?: React.RefObject<HTMLDivElement | null>
  onLayoutChange?: (layout: ComposerEditorLayout) => void
  onChange: () => void
  prediction?: string
  typographyClassName?: string
  predictionLabel?: string
  onDismissPrediction?: () => void
}

export const ComposerEditor = React.memo(function ComposerEditor({
  draft,
  references,
  onRemoveAllReferences,
  inputRef,
  maxHeight,
  maxRows,
  compactContainerRef,
  onLayoutChange,
  onChange,
  onKeyDown,
  prediction = '',
  typographyClassName = '',
  predictionLabel,
  onDismissPrediction,
  ...props
}: ComposerEditorProps): React.JSX.Element {
  const text = React.useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot)
  const composing = React.useRef(false)
  const referencesRef = React.useRef<HTMLDivElement>(null)
  const [referenceLayout, setReferenceLayout] = React.useState({ indent: 0, top: 0 })
  const [scrolled, setScrolled] = React.useState(false)
  const [scrollIndicator, setScrollIndicator] = React.useState<{
    height: number
    top: number
  } | null>(null)
  const scrollIdle = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => () => clearTimeout(scrollIdle.current), [])
  const [referenceOffset, setReferenceOffset] = React.useState(0)
  const [allSelected, setAllSelected] = React.useState(false)
  const boundaries = React.useRef<(HTMLInputElement | null)[]>([])
  const pendingBoundary = React.useRef<number | null>(null)
  const hasReferences = Boolean(references?.length)
  React.useLayoutEffect(() => {
    if (pendingBoundary.current === null) return
    const boundary = boundaries.current[Math.min(pendingBoundary.current, references?.length ?? 0)]
    pendingBoundary.current = null
    if (hasReferences && boundary) boundary.focus()
    else inputRef.current?.focus()
  }, [references, hasReferences, inputRef])
  React.useLayoutEffect(() => {
    const prefix = referencesRef.current
    const input = inputRef.current
    if (!hasReferences || !prefix || !input) {
      setReferenceLayout((previous) =>
        previous.indent || previous.top ? { indent: 0, top: 0 } : previous
      )
      return
    }
    const measure = (): void => {
      const style = getComputedStyle(input)
      const bounds = prefix.getBoundingClientRect()
      const gap = Number.parseFloat(style.getPropertyValue('--vds-space-2'))
      const minimum = Number.parseFloat(style.getPropertyValue('--vds-control-height-standard'))
      const lineHeight = Number.parseFloat(style.lineHeight)
      const padding = Number.parseFloat(style.paddingBottom)
      const last = Array.from(prefix.children).flatMap(referenceBounds).at(-1) ?? bounds
      setReferenceOffset(padding + Math.max(0, (lineHeight - last.height) / 2))
      const indent = last.right - bounds.left + gap
      const stacked = indent + minimum > input.clientWidth
      const next = stacked
        ? { indent: 0, top: bounds.height + gap + padding }
        : { indent, top: last.top - bounds.top + padding }
      setReferenceLayout((previous) =>
        previous.indent === next.indent && previous.top === next.top ? previous : next
      )
    }
    const observer = new ResizeObserver(measure)
    observer.observe(prefix)
    observer.observe(input)
    measure()
    return () => observer.disconnect()
  }, [references, hasReferences, inputRef])
  const compactReservedWidth = React.useRef<number | null>(null)
  const layout = React.useRef<ComposerEditorLayout>({
    multiline: false,
    above: false,
    below: false,
  })
  React.useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    const publish = (multiline: boolean): void => {
      const next = {
        multiline,
        above: Boolean(text) && input.scrollTop > SCROLL_EDGE_TOLERANCE_PX,
        below:
          Boolean(text) &&
          input.scrollHeight - input.clientHeight - input.scrollTop > SCROLL_EDGE_TOLERANCE_PX,
      }
      if (
        Object.keys(next).every(
          (key) =>
            next[key as keyof ComposerEditorLayout] ===
            layout.current[key as keyof ComposerEditorLayout]
        )
      )
        return
      layout.current = next
      onLayoutChange?.(next)
    }
    const resize = (): void => {
      if (!input.getBoundingClientRect().width) return
      const style = getComputedStyle(input)
      const lineHeight = Number.parseFloat(style.lineHeight)
      const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
      const maximumHeight = maxRows ? lineHeight * maxRows + padding : maxHeight
      const scrollTop = input.scrollTop
      const previousWidth = input.style.width
      input.style.height = '0px'
      const container = compactContainerRef?.current
      if (container) {
        const containerStyle = getComputedStyle(container)
        const containerWidth =
          container.clientWidth -
          Number.parseFloat(containerStyle.paddingLeft) -
          Number.parseFloat(containerStyle.paddingRight)
        if (!layout.current.multiline || compactReservedWidth.current === null) {
          compactReservedWidth.current = containerWidth - input.getBoundingClientRect().width
        }
        input.style.width = `${Math.max(SCROLL_EDGE_TOLERANCE_PX, containerWidth - compactReservedWidth.current)}px`
      }
      const compactHeight = text ? input.scrollHeight : lineHeight + padding
      const prefix = referencesRef.current
      const referencesMultiline = Boolean(
        prefix &&
        (prefix.getBoundingClientRect().height > lineHeight + SCROLL_EDGE_TOLERANCE_PX ||
          prefix.getBoundingClientRect().width +
            Number.parseFloat(style.getPropertyValue('--vds-space-2')) +
            Number.parseFloat(style.getPropertyValue('--vds-control-height-standard')) >
            input.getBoundingClientRect().width)
      )
      input.style.width = previousWidth
      const contentHeight = text ? input.scrollHeight : lineHeight + padding
      input.style.height = `${Math.min(contentHeight, maximumHeight)}px`
      input.style.overflowY = contentHeight > maximumHeight ? 'auto' : 'hidden'
      input.style.maxHeight = maxRows ? `${maximumHeight}px` : ''
      input.scrollTop = scrollTop
      publish(
        referencesMultiline ||
          referenceLayout.top > Number.parseFloat(style.paddingBottom) + SCROLL_EDGE_TOLERANCE_PX ||
          compactHeight > lineHeight + padding + SCROLL_EDGE_TOLERANCE_PX
      )
    }
    let previousWidth = input.getBoundingClientRect().width
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width
      if (width === previousWidth) return
      previousWidth = width
      resize()
    })
    observer.observe(input)
    const onScroll = (): void => publish(layout.current.multiline)
    input.addEventListener('scroll', onScroll)
    resize()
    return () => {
      observer.disconnect()
      input.removeEventListener('scroll', onScroll)
    }
  }, [
    inputRef,
    maxHeight,
    maxRows,
    compactContainerRef,
    onLayoutChange,
    text,
    prediction,
    props.className,
    props.placeholder,
    referenceLayout,
  ])
  const editor = (
    <Textarea
      {...props}
      className={`${props.className ?? ''} ![scrollbar-width:none] [&::-webkit-scrollbar]:!hidden${hasReferences ? ' w-full min-w-0' : ''}`}
      style={
        hasReferences
          ? {
              ...props.style,
              textIndent: referenceLayout.indent,
              paddingTop: referenceLayout.top || undefined,
            }
          : props.style
      }
      onScroll={(event) => {
        const input = event.currentTarget
        setScrolled(input.scrollTop > 0)
        clearTimeout(scrollIdle.current)
        const { clientHeight, scrollHeight, scrollTop } = input
        const range = scrollHeight - clientHeight
        if (range > 0 && clientHeight > 0) {
          const minimum = Number.parseFloat(
            getComputedStyle(input).getPropertyValue('--vds-scrollbar-thumb-min-size')
          )
          const height = Math.min(clientHeight, Math.max(minimum, clientHeight ** 2 / scrollHeight))
          setScrollIndicator({ height, top: (scrollTop / range) * (clientHeight - height) })
          scrollIdle.current = setTimeout(() => setScrollIndicator(null), SCROLL_INDICATOR_IDLE_MS)
        } else {
          setScrollIndicator(null)
        }
        props.onScroll?.(event)
      }}
      ref={inputRef}
      value={text}
      placeholder={!text && prediction ? prediction : props.placeholder}
      title={prediction ? predictionLabel : props.title}
      aria-keyshortcuts={prediction ? 'Tab ArrowRight' : undefined}
      data-prediction={Boolean(!text && prediction)}
      onChange={(event) => {
        onDismissPrediction?.()
        draft.set(event.target.value)
        onChange()
      }}
      onCompositionStart={() => {
        composing.current = true
        onDismissPrediction?.()
      }}
      onCompositionEnd={() => {
        composing.current = false
      }}
      onKeyDown={(event) => {
        if (
          composing.current ||
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === COMPOSITION_KEY_CODE
        )
          return
        if (acceptsPrediction(event, draft.getSnapshot(), prediction)) {
          event.preventDefault()
          event.stopPropagation()
          draft.set(prediction)
          onDismissPrediction?.()
          onChange()
          return
        }
        if (event.key === 'Escape' && prediction) {
          event.preventDefault()
          onDismissPrediction?.()
          return
        }
        onKeyDown?.(event)
      }}
    />
  )
  return (
    <div
      className={`relative w-full min-w-0 ${typographyClassName}`}
      onPointerDownCapture={() => setAllSelected(false)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setAllSelected(false)
      }}
      onKeyDownCapture={(event) => {
        if (props.disabled || props.readOnly || composing.current || event.nativeEvent.isComposing)
          return
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'a') {
          event.preventDefault()
          inputRef.current?.focus()
          inputRef.current?.select()
          setAllSelected(true)
          return
        }
        if (allSelected && (event.key === 'Backspace' || event.key === 'Delete')) {
          event.preventDefault()
          event.stopPropagation()
          setAllSelected(false)
          const revision = draft.getRevision()
          const scope = draft.getScope()
          const clear = (): void => {
            if (draft.getRevision() !== revision || draft.getScope() !== scope) return
            draft.set('')
            onDismissPrediction?.()
            onChange()
          }
          const result = onRemoveAllReferences?.()
          if (result instanceof Promise) {
            void result.then((removed) => {
              if (removed) clear()
            })
          } else if (result !== false) clear()
          return
        }
        if (!['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)) setAllSelected(false)
      }}
    >
      {hasReferences && (
        <div
          ref={referencesRef}
          data-testid="composer-reference-list"
          data-composer-inline-references
          style={{ top: referenceOffset }}
          className={`pointer-events-none absolute left-0 top-0 z-[var(--vds-z-local-control)] flex w-max max-w-full flex-wrap items-center gap-y-[var(--vds-space-1)] [&>*]:pointer-events-auto ${scrolled ? 'invisible' : ''}`}
        >
          {references?.map((reference, index) => (
            <React.Fragment key={reference.key}>
              <Input
                ref={(element) => {
                  boundaries.current[index] = element
                }}
                data-testid="composer-reference-boundary"
                aria-label={props['aria-label']}
                tabIndex={-1}
                unstyled
                disabled={props.disabled || props.readOnly || !reference.onRemove}
                value=""
                className="!h-auto !w-[var(--vds-space-2)] !min-w-0 cursor-text !rounded-none !border-0 !bg-transparent !p-0 !shadow-none !outline-none [font:inherit]"
                onChange={(event) => {
                  draft.set(event.target.value + draft.getSnapshot())
                  onDismissPrediction?.()
                  onChange()
                  inputRef.current?.focus()
                }}
                onKeyDown={(event) => {
                  if (event.defaultPrevented || event.nativeEvent.isComposing) return
                  const removeIndex = event.key === 'Backspace' ? index - 1 : index
                  if (event.key === 'Backspace' || event.key === 'Delete') {
                    event.preventDefault()
                    const remove = references[removeIndex]?.onRemove
                    if (remove) {
                      pendingBoundary.current = Math.max(0, removeIndex)
                      remove()
                    }
                  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault()
                    const next = index + (event.key === 'ArrowLeft' ? -1 : 1)
                    if (next >= references.length) {
                      inputRef.current?.focus()
                      inputRef.current?.setSelectionRange(0, 0)
                    } else boundaries.current[Math.max(0, next)]?.focus()
                  }
                }}
              />
              <div
                data-testid={allSelected ? 'composer-selected-reference' : undefined}
                className={`flex max-w-full shrink-0 items-center ${allSelected ? 'bg-[var(--vds-brand-light-bg-default)]' : ''}`}
              >
                {reference.content}
              </div>
            </React.Fragment>
          ))}
        </div>
      )}
      {editor}
      {scrollIndicator && (
        <span
          aria-hidden="true"
          data-testid="composer-scroll-indicator"
          className="pointer-events-none absolute right-[calc(-1*var(--vds-composer-right-padding,var(--vds-space-0)))] z-[var(--vds-z-local-control)] w-[var(--vds-overlay-scrollbar-size)] rounded-[var(--vds-scrollbar-radius)] bg-[var(--vds-scrollbar-thumb)]"
          style={scrollIndicator}
        />
      )}
    </div>
  )
})
