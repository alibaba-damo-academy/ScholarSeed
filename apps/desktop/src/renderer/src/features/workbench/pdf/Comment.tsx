import { forwardRef, useRef, useState, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Button, IconButton, Textarea } from '../../../components/ui'
import type { PdfComment } from '../api'

export type PdfCommentEdit = Pick<PdfComment, 'id' | 'body'>

export const PdfCommentInput = forwardRef<HTMLTextAreaElement, ComponentProps<typeof Textarea>>(
  (props, ref) => {
    const { t } = useTranslation('pdf')
    return (
      <Textarea
        {...props}
        ref={ref}
        placeholder={t('commentPlaceholder')}
        className="!min-h-[calc(3*var(--vds-lh-body-lv2)+2*var(--vds-space-2)+2*var(--vds-border-width-1))] resize-y"
      />
    )
  }
)

PdfCommentInput.displayName = 'PdfCommentInput'

export function PdfCommentEditor({
  comments = [],
  saving,
  onSubmit,
  onCancel,
  inline = false,
}: {
  comments?: PdfComment[]
  saving: boolean
  onSubmit: (comments: PdfCommentEdit[]) => Promise<boolean>
  onCancel: () => void
  inline?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('pdf')
  const [drafts, setDrafts] = useState<PdfCommentEdit[]>(() =>
    comments.length ? comments.map(({ id, body }) => ({ id, body })) : [{ id: '', body: '' }]
  )
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const initialFocus = useRef(true)
  const editing = comments.length > 0
  return (
    <section
      className={`grid min-w-0 max-w-full grid-cols-1 gap-[var(--vds-space-4)] text-[length:var(--vds-pdf-reading-font-size)]${inline ? '' : ' p-[var(--vds-space-3)]'}`}
      onFocusCapture={() => {
        if (!initialFocus.current) return
        initialFocus.current = false
        inputRef.current?.focus({ preventScroll: true })
      }}
    >
      {!inline && editing && (
        <header className="relative flex items-center gap-[var(--vds-space-2)] pr-[var(--vds-control-height-sm)] font-[var(--vds-fw-semibold)]">
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {t(editing ? 'pdfAnnotation.editComment' : 'addComment')}
          </span>
          <IconButton
            className="absolute right-0 top-1/2 -translate-y-1/2"
            label={t('pdfAnnotation.closeComment')}
            icon={<X size={16} />}
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={onCancel}
          />
        </header>
      )}
      {drafts.map((draft, index) => (
        <PdfCommentInput
          key={draft.id}
          ref={index === 0 ? inputRef : undefined}
          autoFocus={index === 0}
          aria-label={t('pdfAnnotation.commentLabel')}
          label={
            drafts.length > 1
              ? t('pdfAnnotation.numberedComment', { number: index + 1 })
              : undefined
          }
          rows={3}
          value={draft.body}
          disabled={saving}
          onChange={(event) => {
            const value = event.target.value
            setDrafts((current) =>
              current.map((item) => (item.id === draft.id ? { ...item, body: value } : item))
            )
          }}
        />
      ))}
      <div className="flex justify-end gap-[var(--vds-space-2)]">
        <Button size="sm" variant="outline" disabled={saving} onClick={onCancel}>
          {t('pdfAnnotation.cancel')}
        </Button>
        <Button
          size="sm"
          disabled={saving || drafts.some((draft) => !draft.body.trim())}
          onClick={async () => {
            const saved = await onSubmit(
              drafts.map((draft) => ({ ...draft, body: draft.body.trim() }))
            )
            if (saved) onCancel()
          }}
        >
          {t('pdfAnnotation.saveComment')}
        </Button>
      </div>
    </section>
  )
}
