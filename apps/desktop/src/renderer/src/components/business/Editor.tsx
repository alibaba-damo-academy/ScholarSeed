import React from 'react'
import type { ComposerDraftStore } from '../../draft'
import { Textarea, type TextareaProps } from '../ui'

const COMPOSITION_KEY_CODE = 229

interface ComposerEditorProps extends Omit<TextareaProps, 'value' | 'defaultValue' | 'onChange' | 'onCompositionStart' | 'onCompositionEnd'> {
  draft: ComposerDraftStore
  inputRef: React.RefObject<HTMLTextAreaElement>
  maxHeight: number
  onChange: () => void
}

export const ComposerEditor = React.memo(function ComposerEditor({
  draft,
  inputRef,
  maxHeight,
  onChange,
  onKeyDown,
  ...props
}: ComposerEditorProps): React.JSX.Element {
  const text = React.useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot)
  const composing = React.useRef(false)
  React.useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = '0px'
    input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`
    input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [inputRef, maxHeight, text])
  return <Textarea
    {...props}
    ref={inputRef}
    value={text}
    onChange={event => {
      draft.set(event.target.value)
      onChange()
    }}
    onCompositionStart={() => { composing.current = true }}
    onCompositionEnd={() => { composing.current = false }}
    onKeyDown={event => {
      if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === COMPOSITION_KEY_CODE) return
      onKeyDown?.(event)
    }}
  />
})
