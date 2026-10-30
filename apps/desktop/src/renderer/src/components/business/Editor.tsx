import React from 'react'
import type { ComposerDraftStore } from '../../draft'
import { Textarea, type TextareaProps } from '../ui'

const COMPOSITION_KEY_CODE = 229
const SCROLL_EDGE_TOLERANCE_PX = 1

export interface ComposerEditorLayout {
  multiline: boolean
  above: boolean
  below: boolean
}

interface ComposerEditorProps extends Omit<
  TextareaProps,
  'value' | 'defaultValue' | 'onChange' | 'onCompositionStart' | 'onCompositionEnd'
> {
  draft: ComposerDraftStore
  inputRef: React.RefObject<HTMLTextAreaElement>
  maxHeight: number
  maxRows?: number
  compactContainerRef?: React.RefObject<HTMLDivElement>
  onLayoutChange?: (layout: ComposerEditorLayout) => void
  onChange: () => void
}

export const ComposerEditor = React.memo(function ComposerEditor({
  draft,
  inputRef,
  maxHeight,
  maxRows,
  compactContainerRef,
  onLayoutChange,
  onChange,
  onKeyDown,
  ...props
}: ComposerEditorProps): React.JSX.Element {
  const text = React.useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot)
  const composing = React.useRef(false)
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
        above: input.scrollTop > SCROLL_EDGE_TOLERANCE_PX,
        below: input.scrollHeight - input.clientHeight - input.scrollTop > SCROLL_EDGE_TOLERANCE_PX,
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
      const compactHeight = input.scrollHeight
      input.style.width = previousWidth
      const contentHeight = input.scrollHeight
      input.style.height = `${Math.min(contentHeight, maximumHeight)}px`
      input.style.overflowY = contentHeight > maximumHeight ? 'auto' : 'hidden'
      input.style.maxHeight = maxRows ? `${maximumHeight}px` : ''
      input.scrollTop = scrollTop
      publish(compactHeight > lineHeight + padding + SCROLL_EDGE_TOLERANCE_PX)
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
    props.className,
    props.placeholder,
  ])
  return (
    <Textarea
      {...props}
      ref={inputRef}
      value={text}
      onChange={(event) => {
        draft.set(event.target.value)
        onChange()
      }}
      onCompositionStart={() => {
        composing.current = true
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
        onKeyDown?.(event)
      }}
    />
  )
})
