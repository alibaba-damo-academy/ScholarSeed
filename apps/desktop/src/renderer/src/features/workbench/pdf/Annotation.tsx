import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, CopyButton, IconButton, Textarea } from '../../../components/ui'
import { PromptSettingsGuide } from '../../../components/business/PromptSettingsGuide'
import { Icon } from '../../../icons'
import { MAX_SELECTION_REQUIREMENT_CHARS } from '../../../../../prompts'
import type { PdfComment, PdfMark } from '../api'
import { PDF_MARK_PALETTE, type PdfMarkColor } from './records'

const PALETTE_KEYS = {
  yellow: 'pdfAnnotation.palette.yellow',
  orange: 'pdfAnnotation.palette.orange',
  green: 'pdfAnnotation.palette.green',
  teal: 'pdfAnnotation.palette.teal',
  blue: 'pdfAnnotation.palette.blue',
  purple: 'pdfAnnotation.palette.purple',
  red: 'pdfAnnotation.palette.red',
  gray: 'pdfAnnotation.palette.gray',
} as const

export function PdfAnnotation({
  analyzing,
  canAnalyze,
  comments,
  mark,
  saving,
  onColorChange,
  onComment,
  onDelete,
  onExplain,
  onStyleChange,
  onTranslate,
}: {
  analyzing: boolean
  canAnalyze: boolean
  comments: PdfComment[]
  mark: PdfMark
  saving: boolean
  onColorChange: (color: PdfMarkColor) => void
  onComment: (body: string) => Promise<boolean>
  onDelete: () => void
  onExplain: (instruction: string) => void
  onStyleChange: (style: PdfMark['style']) => void
  onTranslate: () => void
}): React.JSX.Element {
  const { t } = useTranslation('pdf')
  const [commentOpen, setCommentOpen] = useState(false)
  const [commentDraft, setCommentDraft] = useState('')
  const [explanationOpen, setExplanationOpen] = useState(false)
  const [explanationDraft, setExplanationDraft] = useState('')
  const location =
    comments.length > 0
      ? t('pdfAnnotation.commentedLocation', { page: mark.page, text: mark.text })
      : t('pdfAnnotation.location', { page: mark.page, text: mark.text })

  useEffect(() => {
    if (!commentOpen) setCommentDraft('')
  }, [commentOpen])
  useEffect(() => {
    if (!explanationOpen) setExplanationDraft('')
  }, [explanationOpen])

  const submitComment = async (): Promise<void> => {
    const body = commentDraft.trim()
    if (!body) return
    if (await onComment(body)) setCommentOpen(false)
  }
  const submitExplanation = (): void => {
    onExplain(explanationDraft.trim())
    setExplanationOpen(false)
  }

  return (
    <section
      className="w-[288px] max-w-full max-h-[var(--vds-pdf-annotation-max-height)] overflow-x-hidden overflow-y-auto overscroll-contain"
      data-testid={`pdf-annotation-inspector-${mark.id}`}
      onMouseUp={(event) => event.stopPropagation()}
    >
      <header
        className="flex min-w-0 items-center gap-[var(--vds-space-1)] px-3.5 pb-[var(--vds-space-2)] pt-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-tertiary)]"
        title={location}
      >
        <span className="shrink-0">{t('pdfAnnotation.pageLocation', { page: mark.page })}</span>
        <span className="truncate">{mark.text}</span>
        {comments.length > 0 ? (
          <span className="shrink-0">{t('pdfAnnotation.commentStatus')}</span>
        ) : null}
      </header>
      {comments.length > 0 ? (
        <div
          className="mx-3.5 mb-[var(--vds-space-2)] grid min-w-0 max-h-[var(--vds-pdf-annotation-preview-max-height)] gap-[var(--vds-space-1)] overflow-x-hidden overflow-y-auto overscroll-contain rounded-[var(--vds-radius-3)] bg-[var(--vds-surface-muted)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] leading-5 text-[var(--vds-text-secondary)]"
          tabIndex={0}
          role="region"
          aria-label={t('pdfAnnotation.commentLabel')}
        >
          {comments.map((comment) => (
            <p
              className="m-0 min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]"
              key={comment.id}
            >
              {comment.body}
            </p>
          ))}
        </div>
      ) : null}
      <div
        data-testid="pdf-annotation-styles"
        className="grid grid-cols-3 gap-[var(--vds-space-1)] px-3.5 pb-[var(--vds-space-2)] pt-[var(--vds-space-1)]"
        aria-label={t('pdfAnnotation.styles')}
      >
        <Button
          size="sm"
          variant={mark.style === 'highlight' ? 'secondary' : 'ghost'}
          className="min-w-0 justify-center px-[var(--vds-space-2)]"
          icon={<Icon name="highlighter" size={16} />}
          disabled={saving}
          onClick={() => onStyleChange('highlight')}
        >
          {t('pdfAnnotation.highlight')}
        </Button>
        <Button
          size="sm"
          variant={mark.style === 'underline' ? 'secondary' : 'ghost'}
          className="min-w-0 justify-center px-[var(--vds-space-2)]"
          icon={<Icon name="underline" size={16} />}
          disabled={saving}
          onClick={() => onStyleChange('underline')}
        >
          {t('pdfAnnotation.underline')}
        </Button>
        <Button
          size="sm"
          variant={mark.style === 'strikethrough' ? 'secondary' : 'ghost'}
          className="min-w-0 justify-center px-[var(--vds-space-2)]"
          icon={<Icon name="strikethrough" size={16} />}
          disabled={saving}
          onClick={() => onStyleChange('strikethrough')}
        >
          {t('pdfAnnotation.strikethrough')}
        </Button>
      </div>
      <div
        data-testid="pdf-annotation-colors"
        className="flex items-center gap-[var(--vds-space-1)] px-3.5 py-1.5"
        aria-label={t('pdfAnnotation.colors')}
      >
        {PDF_MARK_PALETTE.map((color) => (
          <IconButton
            key={color.name}
            label={t('pdfAnnotation.color', { color: t(PALETTE_KEYS[color.name]) })}
            size="sm"
            variant="ghost"
            aria-pressed={mark.color === color.name}
            className="rounded-full aria-pressed:ring-2 aria-pressed:ring-[var(--vds-brand-light-border)] aria-pressed:ring-offset-2 aria-pressed:ring-offset-[var(--vds-bg-white-default)]"
            icon={
              <span
                className="size-[var(--vds-icon-8)] rounded-full border border-black/15 bg-[var(--pdf-mark-color)]"
                style={{ '--pdf-mark-color': color.hex } as React.CSSProperties}
              />
            }
            disabled={saving}
            onClick={() => onColorChange(color.name)}
          />
        ))}
      </div>
      <div
        data-testid="pdf-annotation-actions"
        className="grid border-t border-[var(--vds-divider-default)] px-[var(--vds-space-2)] py-[var(--vds-space-2)]"
      >
        <Button
          size="sm"
          variant="ghost"
          className="justify-start"
          icon={<Icon name="quote" size={16} />}
          onClick={() => {
            setExplanationOpen(false)
            setCommentOpen((value) => !value)
          }}
        >
          {t('pdfAnnotation.comment')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="justify-start"
          icon={<Icon name="sparkle" size={16} />}
          disabled={!canAnalyze || analyzing}
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
          icon={<Icon name="globe" size={16} />}
          disabled={!canAnalyze || analyzing}
          onClick={() => {
            setCommentOpen(false)
            setExplanationOpen(false)
            onTranslate()
          }}
        >
          {t('pdfAnnotation.translate')}
        </Button>
        <CopyButton
          value={mark.text}
          writeText={async (text) => {
            const result = await window.scholarseed?.writeClipboard(text)
            if (!result?.ok) throw new Error('clipboard write failed')
          }}
          size="sm"
          variant="ghost"
          className="justify-start"
          idleLabel={t('pdfAnnotation.copy')}
        >
          <Icon name="copy" size={16} />
          {t('pdfAnnotation.copy')}
        </CopyButton>
      </div>
      {commentOpen ? (
        <div className="grid gap-[var(--vds-space-2)] border-t border-[var(--vds-divider-default)] p-[var(--vds-space-3)]">
          <Textarea
            autoFocus
            label={t('pdfAnnotation.commentLabel')}
            value={commentDraft}
            rows={3}
            onChange={(event) => setCommentDraft(event.target.value)}
          />
          <Button
            className="justify-self-end"
            size="sm"
            disabled={!commentDraft.trim() || saving}
            onClick={() => void submitComment()}
          >
            {t('pdfAnnotation.saveComment')}
          </Button>
        </div>
      ) : null}
      {explanationOpen ? (
        <div className="grid gap-[var(--vds-space-2)] border-t border-[var(--vds-divider-default)] p-[var(--vds-space-3)]">
          <Textarea
            autoFocus
            label={t('pdfAnnotation.explainPrompt')}
            placeholder={t('pdfAnnotation.explainPlaceholder')}
            maxLength={MAX_SELECTION_REQUIREMENT_CHARS}
            value={explanationDraft}
            rows={2}
            onChange={(event) => setExplanationDraft(event.target.value)}
          />
          <PromptSettingsGuide
            prefix={t('pdfAnnotation.promptGuide')}
            linkPrefix={t('pdfAnnotation.promptGuideLinkPrefix')}
            linkLabel={t('pdfAnnotation.promptSettings')}
          />
          <Button
            className="justify-self-start"
            size="sm"
            disabled={analyzing}
            onClick={submitExplanation}
          >
            {t('pdfAnnotation.submitExplanation')}
          </Button>
        </div>
      ) : null}
      <div
        data-testid="pdf-annotation-delete"
        className="border-t border-[var(--vds-divider-default)] px-[var(--vds-space-2)] py-[var(--vds-space-2)]"
      >
        <Button
          size="sm"
          variant="ghost"
          className="w-full justify-start text-[var(--vds-error-text-primary)] [&_.vds-icon]:text-current"
          icon={<Icon name="trash" size={16} />}
          disabled={saving}
          onClick={onDelete}
        >
          {t('pdfAnnotation.delete')}
        </Button>
      </div>
    </section>
  )
}
