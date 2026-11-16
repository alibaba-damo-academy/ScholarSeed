import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Languages, MessageCirclePlus, MessageSquareText, Trash2 } from 'lucide-react'

import { Button, CopyButton, IconButton, Divider } from '../../../components/ui'
import { Icon } from '../../../icons'
import type { PdfComment, PdfMark } from '../api'
import type { PdfTextMarkStyle } from '../../../contracts/workbench'
import type { PdfMarkColor } from './records'
import { PDF_COPY_FEEDBACK_DURATION_MS, PdfSelectionActions, PdfTools } from './Tools'
import { PdfExplanation } from './Explanation'
import { PdfCommentEditor, type PdfCommentEdit } from './Comment'
import { createPointMark } from './records'

export function PdfAnnotation({
  analyzing,
  canAnalyze,
  comments,
  mark,
  saving,
  onColorChange,
  onComment,
  onUpdateComments,
  onClose,
  onDelete,
  onExplain,
  onOpenSettings,
  onStyleChange,
  onTranslate,
  result,
  onAddToTask,
  initialMode = 'edit',
  inlineComment = false,
  appearanceOnly = false,
  draft = false,
}: {
  analyzing: boolean
  canAnalyze: boolean
  comments: PdfComment[]
  mark: PdfMark
  saving: boolean
  onColorChange?: (color: PdfMarkColor) => void
  onComment: (body: string) => Promise<boolean>
  onUpdateComments: (comments: PdfCommentEdit[]) => Promise<boolean>
  onClose: () => void
  onDelete?: () => void
  onOpenSettings?: () => void
  onExplain?: (instruction: string) => void
  onStyleChange?: (style: PdfTextMarkStyle) => void
  onTranslate?: () => void
  result?: {
    kind: 'selection_explanation' | 'selection_translation'
    panel: React.ReactNode
  } | null
  onAddToTask?: () => Promise<boolean>
  initialMode?: 'edit' | 'comment'
  inlineComment?: boolean
  appearanceOnly?: boolean
  draft?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('pdf')
  const [commentOpen, setCommentOpen] = useState(initialMode === 'comment')
  const initialCommentFocus = useRef(initialMode === 'comment')
  const [addingContext, setAddingContext] = useState(false)
  const [contextError, setContextError] = useState(false)
  const pointComment = mark.style === 'comment'
  const [explanationOpen, setExplanationOpen] = useState(false)
  const [explanationDraft, setExplanationDraft] = useState('')
  useEffect(() => {
    if (!explanationOpen) setExplanationDraft('')
  }, [explanationOpen])

  const submitExplanation = (): void => {
    onExplain?.(explanationDraft.trim())
    setExplanationOpen(false)
  }

  if (appearanceOnly) {
    return (
      <div className="p-[var(--vds-space-3)]">
        <PdfTools
          section="marks"
          colors={{ highlight: mark.color, underline: mark.color, strikethrough: mark.color }}
          selectionColor={mark.color}
          onSelectionColor={onColorChange}
          disabled={saving || !onStyleChange || !onColorChange}
          hasSelection
          onApply={(style) => onStyleChange?.(style)}
          onColor={() => {}}
          commentOpen={false}
          onComment={() => {}}
        />
      </div>
    )
  }

  if (commentOpen && initialMode === 'comment' && inlineComment) {
    return (
      <section
        className="w-[var(--vds-pdf-comment-width)] max-w-full max-h-[var(--vds-pdf-annotation-max-height)] overflow-x-hidden overflow-y-auto overscroll-contain"
        data-testid={`pdf-annotation-inspector-${mark.id}`}
        onMouseUp={(event) => event.stopPropagation()}
      >
        <PdfCommentEditor
          inline={inlineComment}
          comments={comments}
          saving={saving}
          onSubmit={(drafts) =>
            comments.length ? onUpdateComments(drafts) : onComment(drafts[0].body)
          }
          onCancel={onClose}
        />
      </section>
    )
  }

  return (
    <section
      className="w-max max-w-full max-h-[var(--vds-pdf-annotation-max-height)] overflow-x-hidden overflow-y-auto overscroll-contain"
      data-testid={`pdf-annotation-inspector-${mark.id}`}
      onMouseUp={(event) => event.stopPropagation()}
      onFocusCapture={(event) => {
        if (!initialCommentFocus.current) return
        const input = event.currentTarget.querySelector('textarea')
        if (!input) return
        initialCommentFocus.current = false
        input.focus({ preventScroll: true })
      }}
    >
      <div
        data-testid="pdf-annotation-actions"
        className="flex flex-nowrap items-center gap-[var(--vds-space-half)] overflow-x-auto px-[var(--vds-space-3)] py-[var(--vds-space-2)]"
      >
        <PdfSelectionActions>
          <PdfTools
            section="marks"
            colors={{ highlight: mark.color, underline: mark.color, strikethrough: mark.color }}
            selectionColor={mark.color}
            onSelectionColor={onColorChange}
            disabled={pointComment || saving || !onStyleChange || !onColorChange}
            hasSelection
            onApply={(style) => onStyleChange?.(style)}
            onColor={() => {}}
            onComment={() => setCommentOpen(true)}
            commentOpen={commentOpen}
          />
          <Button
            size="sm"
            variant="ghost"
            className="justify-start"
            icon={<Icon name="sparkle" size={16} />}
            disabled={pointComment || !canAnalyze || analyzing || !onExplain}
            aria-pressed={
              explanationOpen || (!commentOpen && result?.kind === 'selection_explanation')
            }
            onClick={() => {
              setCommentOpen(false)
              setExplanationOpen((value) => !value)
            }}
          >
            {t('pdfAnnotation.explain')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="justify-start"
            icon={<Languages size={16} />}
            disabled={pointComment || !canAnalyze || analyzing || !onTranslate}
            aria-pressed={
              !explanationOpen && !commentOpen && result?.kind === 'selection_translation'
            }
            onClick={() => {
              setCommentOpen(false)
              setExplanationOpen(false)
              onTranslate?.()
            }}
          >
            {t('pdfAnnotation.translate')}
          </Button>

          <Button
            size="sm"
            variant="ghost"
            className="justify-start"
            icon={<MessageCirclePlus size={16} />}
            disabled={!onAddToTask || addingContext || saving}
            onClick={async () => {
              if (!onAddToTask || addingContext) return
              setAddingContext(true)
              setContextError(false)
              try {
                setContextError(!(await onAddToTask()))
              } catch {
                setContextError(true)
              } finally {
                setAddingContext(false)
              }
            }}
          >
            {t('selectionAddConversation')}
          </Button>
          <Divider
            orientation="vertical"
            className="!self-center !min-h-0 !h-[var(--vds-lh-body-lv1)] [--vds-divider-margin-vertical:0_var(--vds-space-1)]"
          />
          <CopyButton
            disabled={pointComment}
            iconOnly
            icon={<Copy size={16} />}
            copiedIcon={<Check size={16} />}
            feedbackDuration={PDF_COPY_FEEDBACK_DURATION_MS}
            value={mark.text}
            writeText={async (text) => {
              const result = await window.scholarseed?.writeClipboard(text)
              if (!result?.ok) throw new Error('clipboard write failed')
            }}
            size="sm"
            variant="ghost"
            idleLabel={t('pdfAnnotation.copy')}
          />
          <IconButton
            size="sm"
            variant="ghost"
            label={t('pdfAnnotation.comment')}
            icon={<MessageSquareText size={16} />}
            aria-pressed={commentOpen}
            onClick={() => {
              setExplanationOpen(false)
              setCommentOpen((value) => !value)
            }}
          />
          {!draft && onDelete && (
            <IconButton
              data-testid="pdf-annotation-delete"
              label={t('pdfAnnotation.delete')}
              size="sm"
              variant="ghost"
              className="!text-[var(--vds-error-text-primary)] [&_.vds-icon]:!text-current"
              icon={<Trash2 size={16} />}
              disabled={saving}
              onClick={onDelete}
            />
          )}
          {contextError ? <p role="alert">{t('pdfAnnotation.contextFailed')}</p> : null}
        </PdfSelectionActions>
      </div>
      {commentOpen ? (
        <div className="border-t border-[var(--vds-divider-default)] p-[var(--vds-space-3)]">
          <PdfCommentEditor
            inline
            comments={comments}
            saving={saving}
            onSubmit={(drafts) => {
              return comments.length ? onUpdateComments(drafts) : onComment(drafts[0].body)
            }}
            onCancel={() => (initialMode === 'comment' ? onClose() : setCommentOpen(false))}
          />
        </div>
      ) : null}
      {explanationOpen ? (
        <PdfExplanation
          value={explanationDraft}
          onChange={setExplanationDraft}
          onOpenSettings={() => onOpenSettings?.()}
          disabled={analyzing}
          onSubmit={submitExplanation}
        />
      ) : null}
      {!commentOpen && !explanationOpen ? result?.panel : null}
    </section>
  )
}

export function PdfCommentDraft({
  page,
  point,
  saving,
  onSave,
  onCancel,
}: {
  page: number
  point: [number, number]
  saving: boolean
  onSave: (body: string) => Promise<boolean>
  onCancel: () => void
}): React.JSX.Element {
  const mark = useMemo(() => createPointMark(page, point), [page, point])
  return (
    <section data-testid="pdf-point-comment-draft">
      <PdfAnnotation
        draft
        mark={mark}
        comments={[]}
        initialMode="comment"
        saving={saving}
        analyzing={false}
        canAnalyze={false}
        onComment={onSave}
        onUpdateComments={(drafts) => onSave(drafts[0].body)}
        onClose={onCancel}
      />
    </section>
  )
}
