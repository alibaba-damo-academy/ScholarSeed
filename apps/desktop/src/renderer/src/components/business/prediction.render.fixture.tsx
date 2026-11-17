import React from 'react'
import { createRoot } from 'react-dom/client'
import { ComposerEditor } from './Editor'
import { createComposerDraftStore } from '../../draft'
import { Button } from '../ui'
import '../../styles.css'

const draft = createComposerDraftStore()
const suggestion = '比较这些方法，并列出下一步实验。'

function Probe() {
  const input = React.useRef<HTMLTextAreaElement>(null)
  const [prediction, setPrediction] = React.useState(suggestion)
  const [sends, setSends] = React.useState(0)
  const [references, setReferences] = React.useState(false)
  const text = React.useSyncExternalStore(draft.subscribe, draft.getSnapshot)
  return (
    <>
      <Button
        data-testid="reset"
        onClick={() => {
          draft.set('')
          setPrediction(suggestion)
        }}
      >
        Reset
      </Button>
      <ComposerEditor
        references={
          references
            ? [
                {
                  key: 'session',
                  content: (
                    <span data-testid="inline-reference">Research session · literature-review</span>
                  ),
                  onRemove: () => setReferences(false),
                },
              ]
            : undefined
        }
        inputRef={input}
        draft={draft}
        maxHeight={200}
        data-testid="editor"
        prediction={prediction}
        placeholder="Write a message"
        onDismissPrediction={() => setPrediction('')}
        onChange={() => {}}
        onKeyDown={(event) => {
          if (event.key === 'Enter') setSends((count) => count + 1)
        }}
      />
      <Button data-testid="references" onClick={() => setReferences((current) => !current)}>
        References
      </Button>
      <output data-testid="draft">{text}</output>
      <output data-testid="sends">{sends}</output>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<Probe />)
