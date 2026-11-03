import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ComposerEditor } from '../../src/renderer/src/components/business/Editor'
import { createComposerDraftStore } from '../../src/renderer/src/draft'

const draft = createComposerDraftStore('')
const MAX_HEIGHT = 132
const INPUT_STYLE: React.CSSProperties = { width: 240, lineHeight: '20px', boxSizing: 'border-box' }
const NARROW_INPUT_STYLE: React.CSSProperties = { ...INPUT_STYLE, width: 40 }

function Fixture(): React.JSX.Element {
  const [updates, setUpdates] = useState(0)
  const [disabled, setDisabled] = useState(false)
  const [placeholder, setPlaceholder] = useState('idle')
  const [keys, setKeys] = useState<string[]>([])
  const [changes, setChanges] = useState(0)
  const [narrow, setNarrow] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const onChange = useCallback(() => setChanges(value => value + 1), [])
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    setKeys(value => [...value, event.key])
  }, [])
  useLayoutEffect(() => {
    inputRef.current?.focus()
  }, [])
  return <>
    <button onClick={() => setUpdates(value => value + 1)}>unrelated update</button>
    <button onClick={() => draft.set('restored draft')}>restore draft</button>
    <button onClick={() => draft.set('')}>clear draft</button>
    <button onClick={() => setDisabled(value => !value)}>toggle disabled</button>
    <button onClick={() => setPlaceholder('running')}>change placeholder</button>
    <button onClick={() => setNarrow(value => !value)}>toggle width</button>
    <output data-testid="updates">{updates}</output>
    <output data-testid="keys">{keys.join(',')}</output>
    <output data-testid="changes">{changes}</output>
    <ComposerEditor
      inputRef={inputRef}
      draft={draft}
      maxHeight={MAX_HEIGHT}
      onChange={onChange}
      onKeyDown={onKeyDown}
      disabled={disabled}
      placeholder={placeholder}
      aria-label="draft"
      data-testid="composer-input"
      style={narrow ? NARROW_INPUT_STYLE : INPUT_STYLE}
    />
  </>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
