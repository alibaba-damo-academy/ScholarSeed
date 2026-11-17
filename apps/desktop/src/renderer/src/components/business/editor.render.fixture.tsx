import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../styles.css'
import { createComposerDraftStore } from '../../draft'
import { partitionComposerReferences } from '../../reference'
import { ComposerEditor, type ComposerEditorLayout } from './Editor'
import { ReferenceAttachment } from '../primitive'
import { Button, ScrollArea } from '../ui'
import { ComposerSkillRefs } from './SkillRefs'

const draft = createComposerDraftStore()
Object.assign(window, { editorDraft: draft })

function Fixture(): React.JSX.Element {
  const standard = new URLSearchParams(location.search).has('standard')
  const ordering = new URLSearchParams(location.search).has('ordering')
  const hints = new URLSearchParams(location.search).has('hints')
  const [hint, setHint] = React.useState('idle')
  const kinds = ['session', 'skill', 'file', 'image', 'note', 'selection']
  const input = React.useRef<HTMLTextAreaElement>(null)
  const container = React.useRef<HTMLDivElement>(null)
  const [referenceLabels, setReferenceLabels] = React.useState(
    new URLSearchParams(location.search).has('references')
      ? ['会话滚动按钮与长任务引用换行验证任务', '精确检索文献', '书深产品操作']
      : []
  )
  const [layout, setLayout] = React.useState<ComposerEditorLayout>({
    multiline: false,
    above: false,
    below: false,
  })
  const referenceGroups = partitionComposerReferences(
    (ordering ? [...referenceLabels].sort() : referenceLabels).map((label, index) => ({
      key: label,
      inline: !ordering || label === 'session' || label === 'skill',
      onRemove: () => setReferenceLabels((current) => current.filter((item) => item !== label)),
      content: ordering ? (
        <ReferenceAttachment
          variant={label === 'session' || label === 'skill' ? 'text' : undefined}
          label={<span data-testid="ordered-reference">{label}</span>}
          onClose={() => setReferenceLabels((current) => current.filter((item) => item !== label))}
        />
      ) : index === 0 ? (
        <ReferenceAttachment
          variant="text"
          label={<Button unstyled>{label}</Button>}
          onClose={() => undefined}
        />
      ) : (
        <ComposerSkillRefs refs={[{ type: 'skill', id: label, title: label, path: label }]} />
      ),
    })),
    referenceLabels
  )
  return (
    <div
      ref={container}
      className="flex w-full flex-wrap gap-[var(--vds-space-1)] p-[var(--vds-space-3)]"
    >
      {ordering && referenceGroups.attachments.length > 0 && (
        <div data-testid="fixture-attachments" className="w-full min-w-0">
          <ScrollArea orientation="horizontal">
            <div className="flex w-max min-w-full flex-nowrap items-center gap-[var(--vds-space-2)]">
              {referenceGroups.attachments.map((reference) => (
                <React.Fragment key={reference.key}>{reference.content}</React.Fragment>
              ))}
            </div>
          </ScrollArea>
        </div>
      )}
      <div data-testid="fixture-inline" className={layout.multiline ? 'w-full' : 'min-w-0 flex-1'}>
        <ComposerEditor
          typographyClassName={`font-[var(--font-serif)] text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] ${standard ? 'leading-[var(--vds-lh-body-lv2)]' : 'leading-[var(--vds-space-6)]'}`}
          inputRef={input}
          draft={draft}
          references={referenceGroups.inline}
          onRemoveAllReferences={
            new URLSearchParams(location.search).has('async-removal')
              ? () =>
                  new Promise<boolean>((resolve) => {
                    const references = referenceLabels
                    Object.assign(window, {
                      finishRemoval: (removed: boolean) => {
                        if (removed)
                          setReferenceLabels((items) =>
                            items.filter((item) => !references.includes(item))
                          )
                        resolve(removed)
                      },
                    })
                  })
              : () => setReferenceLabels([])
          }
          maxHeight={132}
          maxRows={10}
          compactContainerRef={container}
          onLayoutChange={setLayout}
          onChange={() => undefined}
          unstyled
          rows={1}
          placeholder={
            hints
              ? hint === 'running'
                ? '任务运行中，可继续编辑并发送到待处理消息，当前回答完成后会继续处理。'
                : '描述任务'
              : '描述任务，引用与正文对齐'
          }
          prediction={
            hints && hint === 'prediction'
              ? '帮我找几篇近两年关于大模型智能体规划能力的论文，并简要说明每篇的核心思路。'
              : undefined
          }
          data-testid="editor"
          className="block w-full min-h-0 resize-none py-[var(--vds-space-1)] [font:inherit]"
        />
      </div>
      <div data-testid="toolbar" className="w-[var(--vds-space-8)] shrink-0" />
      {hints && (
        <div className="w-full">
          {['idle', 'running', 'prediction'].map((value) => (
            <Button key={value} data-testid={`hint-${value}`} onClick={() => setHint(value)}>
              {value}
            </Button>
          ))}
        </div>
      )}
      {ordering &&
        kinds.map((kind) => (
          <Button
            key={kind}
            data-testid={`add-${kind}`}
            onClick={() =>
              setReferenceLabels((current) =>
                current.includes(kind) ? current : [...current, kind]
              )
            }
          >
            {kind}
          </Button>
        ))}
      {ordering && (
        <Button
          data-testid="reset-draft"
          onClick={() => {
            draft.reset()
            setReferenceLabels([])
          }}
        >
          Reset
        </Button>
      )}
      <output data-testid="layout" className="hidden">
        {JSON.stringify(layout)}
      </output>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
