import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../styles.css'
import { createComposerDraftStore } from '../../draft'
import { ComposerEditor, type ComposerEditorLayout } from './Editor'

const draft = createComposerDraftStore()

function Fixture(): React.JSX.Element {
  const input = React.useRef<HTMLTextAreaElement>(null)
  const container = React.useRef<HTMLDivElement>(null)
  const [layout, setLayout] = React.useState<ComposerEditorLayout>({
    multiline: false,
    above: false,
    below: false,
  })
  return (
    <div
      ref={container}
      className="flex w-full flex-wrap gap-[var(--vds-space-1)] p-[var(--vds-space-3)]"
    >
      <div className={layout.multiline ? 'w-full' : 'min-w-0 flex-1'}>
        <ComposerEditor
          inputRef={input}
          draft={draft}
          maxHeight={132}
          maxRows={10}
          compactContainerRef={container}
          onLayoutChange={setLayout}
          onChange={() => undefined}
          unstyled
          rows={1}
          data-testid="editor"
          className="block w-full min-h-0 resize-none py-[var(--vds-space-1)] leading-[var(--vds-space-6)]"
        />
      </div>
      <div data-testid="toolbar" className="w-[var(--vds-space-16)]" />
      <output data-testid="layout" className="hidden">
        {JSON.stringify(layout)}
      </output>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
