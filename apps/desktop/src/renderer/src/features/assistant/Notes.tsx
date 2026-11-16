import React, {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
} from 'react'
import { useTranslation } from 'react-i18next'
import { PencilLine, Trash, Trash2 } from 'lucide-react'

import type { AnswerAnnotation } from '../../contracts/assistant'
import { ReferenceAttachment, SentReferenceAttachment } from '../../components/primitive'
import {
  Alert,
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPortal,
  AlertDialogTitle,
  Badge,
  Button,
  HoverCard,
  HoverCardContent,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Textarea,
  Tooltip,
} from '../../components/ui'
import { ANSWER_ANNOTATION_LOCATION, type AnswerAnnotationLocation } from './anchors'

const COMMENT_MAX_LENGTH = 600

const ANNOTATION_BADGE_CLASS =
  'inline-grid size-[var(--vds-badge-height-sm)] shrink-0 place-items-center rounded-[var(--vds-radius-8)] rounded-bl-[var(--vds-radius-1)] border-0 bg-[var(--vds-text-primary)] p-0 text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-semibold)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-surface-raised)] shadow-none focus-visible:shadow-[var(--vds-focus-brand)]'

const NOTE_EDITOR_POPOVER_CLASS =
  '!w-[var(--vds-answer-annotation-editor-width)] !max-w-[var(--vds-answer-annotation-editor-max-width)] !gap-0 overflow-hidden !rounded-[var(--vds-radius-6)] !border !border-solid !border-[var(--vds-border-default)] !bg-[var(--vds-surface-raised)] !p-0 !shadow-[var(--vds-shadow-aidialog-2)]'

export function AnnotationBadge({
  className,
  number,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { number: number }): React.JSX.Element {
  return (
    <Button
      className={className ? `${ANNOTATION_BADGE_CLASS} ${className}` : ANNOTATION_BADGE_CLASS}
      unstyled
      {...props}
    >
      {number}
    </Button>
  )
}

function AnnotationCommentEditor({
  annotation,
  inputLabel,
  onClose,
  onRemove,
  onSave,
}: {
  annotation: AnnotationDisplay
  inputLabel: string
  onClose: () => void
  onRemove?: () => void
  onSave: (annotationId: string, comment: string) => Promise<boolean>
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const [draft, setDraft] = useState(annotation.comment)
  const [saving, setSaving] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [moreBelow, setMoreBelow] = useState(false)
  const updateOverflow = useCallback((): void => {
    const textarea = textareaRef.current
    if (textarea) {
      setMoreBelow(textarea.scrollHeight > Math.ceil(textarea.clientHeight + textarea.scrollTop))
    }
  }, [])
  useLayoutEffect(updateOverflow, [draft, updateOverflow])
  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus({ preventScroll: true })
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [])
  const save = async (): Promise<void> => {
    setSaving(true)
    const ok = await onSave(annotation.id, draft)
    setSaving(false)
    if (ok) onClose()
  }
  return (
    <div className="flex min-w-0 flex-col gap-[var(--vds-space-2)] p-[calc(var(--vds-space-3)_-_var(--vds-border-width-1))] font-[var(--vds-fw-regular)]">
      <div className="relative min-w-0">
        <Textarea
          aria-label={inputLabel}
          autoFocus
          className="block min-h-[var(--vds-answer-annotation-editor-min-height)] max-h-[var(--vds-answer-annotation-editor-max-height)] w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-answer-annotation-text)] shadow-none [field-sizing:content] [scrollbar-width:none] focus:outline-none"
          disabled={saving}
          maxLength={COMMENT_MAX_LENGTH}
          placeholder={t('remaining.optionalComment')}
          onChange={(event) => setDraft(event.target.value)}
          onScroll={updateOverflow}
          ref={textareaRef}
          rows={2}
          unstyled
          value={draft}
        />
        {moreBelow ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-[var(--vds-lh-body-lv2)] bg-[linear-gradient(to_bottom,transparent,var(--vds-surface-raised))]"
            data-testid="annotation-editor-fade"
          />
        ) : null}
      </div>
      <div className="flex items-center justify-between">
        {onRemove ? (
          <IconButton
            className="text-[var(--vds-text-secondary)]"
            icon={<Trash2 size={14} />}
            label={t('remaining.deleteAnnotation')}
            onClick={onRemove}
            size="sm"
            variant="ghost"
          />
        ) : (
          <span />
        )}
        <div className="flex items-center gap-[var(--vds-space-2)]">
          <Button
            className="!border-0 !px-[var(--vds-space-3)] !text-[length:var(--vds-font-body-lv1)] !leading-[var(--vds-lh-body-lv1)]"
            disabled={saving}
            onClick={onClose}
            size="sm"
            variant="tertiary"
          >
            {t('remaining.cancel')}
          </Button>
          <Button
            className="min-w-[var(--vds-answer-annotation-save-min-width)] !border-0 !px-[var(--vds-space-3)] !text-[length:var(--vds-font-body-lv1)] !leading-[var(--vds-lh-body-lv1)]"
            disabled={saving}
            loading={saving}
            onClick={() => void save()}
            size="sm"
            variant="primary"
          >
            {t('remaining.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}

// 标识交互: hover 展示备注文本气泡; 点击展示可编辑弹窗(文本域 + 删除/取消/保存),
// 弹窗点击外部区域关闭; 删除走确认对话框, 未保存的草稿标识仅支持 hover。
export function AnnotationBadgeNote({
  annotation,
  ariaLabel,
  noteText,
  number,
  onRemove,
  onSave,
  onOpenChange,
  open,
}: {
  annotation: AnnotationDisplay | null
  ariaLabel: string
  noteText: string
  number: number
  onRemove?: (annotationId: string) => Promise<boolean> | boolean
  onSave?: (annotationId: string, comment: string) => Promise<boolean>
  onOpenChange?: (open: boolean) => void
  open?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const [internalEditOpen, setInternalEditOpen] = useState(false)
  const editOpen = open ?? internalEditOpen
  const changeEditOpen = (open: boolean): void => {
    setInternalEditOpen(open)
    onOpenChange?.(open)
  }
  const [pendingRemove, setPendingRemove] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState(false)
  const confirmRemove = async (): Promise<void> => {
    if (!annotation || !onRemove) return
    setRemoving(true)
    setRemoveError(false)
    const ok = await onRemove(annotation.id)
    setRemoving(false)
    if (ok) setPendingRemove(false)
    else setRemoveError(true)
  }
  const tooltip = (
    <Tooltip
      content={noteText}
      contentClassName="whitespace-pre-wrap"
      disabled={editOpen}
      side="top"
    >
      <AnnotationBadge aria-label={ariaLabel} number={number} />
    </Tooltip>
  )
  if (!annotation || !onSave) return tooltip
  return (
    <>
      <Popover open={editOpen} onOpenChange={changeEditOpen}>
        <PopoverTrigger asChild>
          <span className="inline-flex">{tooltip}</span>
        </PopoverTrigger>
        <PopoverContent className={NOTE_EDITOR_POPOVER_CLASS}>
          <AnnotationCommentEditor
            annotation={annotation}
            inputLabel={t('remaining.editNote', { number })}
            onClose={() => changeEditOpen(false)}
            onRemove={
              onRemove
                ? () => {
                    changeEditOpen(false)
                    setPendingRemove(true)
                  }
                : undefined
            }
            onSave={onSave}
          />
        </PopoverContent>
      </Popover>
      {pendingRemove ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && !removing) {
              setPendingRemove(false)
              setRemoveError(false)
            }
          }}
        >
          <AlertDialogPortal>
            <AlertDialogContent data-testid="answer-annotation-delete-dialog">
              <AlertDialogHeader>
                <AlertDialogTitle>{t('remaining.deleteAnnotationTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('remaining.deleteAnnotationDescription')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              {removeError ? (
                <Alert description={t('remaining.deleteAnnotationFailed')} tone="error" />
              ) : null}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={removing}>{t('remaining.cancel')}</AlertDialogCancel>
                <Button
                  disabled={removing}
                  loading={removing}
                  onClick={() => void confirmRemove()}
                  variant="danger"
                >
                  {t('remaining.deleteAnnotation')}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialogPortal>
        </AlertDialog>
      ) : null}
    </>
  )
}

export interface AnnotationDisplay {
  id: string
  previewText: string
  comment: string
}

export function annotationDisplay(annotation: AnswerAnnotation): AnnotationDisplay {
  return {
    id: annotation.annotation_id,
    previewText: annotation.preview_text,
    comment: annotation.comment,
  }
}

export function AnnotationDetails({
  annotations,
  onEdit,
  onOpenOriginal,
  onRemove,
  location,
  numberForAnnotation,
  removeLabel,
}: {
  annotations: AnnotationDisplay[]
  onEdit?: (annotationId: string, comment: string) => Promise<boolean>
  onOpenOriginal?: (annotationId: string) => void
  onRemove?: (annotationId: string) => void
  location?: { annotationId: string; status: AnswerAnnotationLocation } | null
  numberForAnnotation?: (annotationId: string, index: number) => number
  removeLabel?: string
}): React.JSX.Element | null {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const { t } = useTranslation('assistant')
  if (annotations.length === 0) return null

  const beginEdit = (annotation: AnnotationDisplay): void => {
    setEditingId(annotation.id)
    setCommentDraft(annotation.comment)
  }
  const saveEdit = async (): Promise<void> => {
    if (!editingId || !onEdit) return
    setSaving(true)
    const ok = await onEdit(editingId, commentDraft)
    setSaving(false)
    if (ok) setEditingId(null)
  }
  const locationLabel = (annotationId: string): string | null => {
    if (location?.annotationId !== annotationId) return null
    if (location.status === ANSWER_ANNOTATION_LOCATION.POSITION_LOST)
      return t('annotation.positionLost')
    if (location.status === ANSWER_ANNOTATION_LOCATION.UNAVAILABLE)
      return t('annotation.unavailable')
    return null
  }

  return (
    <div className="flex max-h-[min(var(--vds-assistant-notes-max-height),var(--floating-available-height,var(--vds-assistant-notes-max-height)))] flex-col gap-[var(--vds-space-1)] overflow-x-hidden overflow-y-auto overscroll-contain p-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] leading-[var(--vds-lh-body-lv1)]">
      {annotations.map((annotation, index) => {
        const number = numberForAnnotation?.(annotation.id, index) ?? index + 1
        const statusLabel = locationLabel(annotation.id)
        return (
          <div
            className="grid shrink-0 grid-cols-[var(--vds-assistant-notes-number-width)_minmax(0,1fr)_auto] items-start gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] p-[var(--vds-space-2)] hover:bg-[var(--vds-bg-white-hover-transparent)] focus-within:bg-[var(--vds-bg-white-hover-transparent)]"
            data-testid={`answer-annotation-details-${annotation.id}`}
            key={annotation.id}
          >
            <span className="text-center text-[var(--vds-text-tertiary)]">{number}.</span>
            <div className="flex min-w-0 flex-col gap-[var(--vds-assistant-notes-content-gap)] [overflow-wrap:anywhere]">
              {annotation.previewText ? (
                <div className="text-[var(--vds-text-tertiary)]">
                  {t('annotation.selectedText')}
                </div>
              ) : null}
              {annotation.previewText &&
                (onOpenOriginal ? (
                  <Button
                    className="h-auto min-h-0 w-full justify-start whitespace-pre-wrap p-0 text-left text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] leading-[var(--vds-lh-body-lv1)] !text-[var(--vds-text-primary)] hover:underline"
                    data-testid={`answer-annotation-open-${annotation.id}`}
                    onClick={() => onOpenOriginal(annotation.id)}
                    unstyled
                  >
                    {annotation.previewText}
                  </Button>
                ) : (
                  <div className="whitespace-pre-wrap text-[var(--vds-text-primary)]">
                    {annotation.previewText}
                  </div>
                ))}
              {annotation.comment ? (
                <div className="flex flex-col gap-[var(--vds-assistant-notes-content-gap)]">
                  <div className="text-[var(--vds-text-tertiary)]">
                    {t('annotation.userComment')}
                  </div>
                  <div className="whitespace-pre-wrap text-[var(--vds-text-primary)]">
                    {annotation.comment}
                  </div>
                </div>
              ) : null}
              {onEdit && editingId === annotation.id ? (
                <div className="mt-[var(--vds-space-2)] space-y-[var(--vds-space-2)]">
                  <Input
                    aria-label={t('remaining.editNote', { number })}
                    autoFocus
                    disabled={saving}
                    maxLength={COMMENT_MAX_LENGTH}
                    onChange={(event) => setCommentDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                      event.preventDefault()
                      void saveEdit()
                    }}
                    value={commentDraft}
                  />
                  <div className="flex justify-end gap-[var(--vds-space-2)]">
                    <Button
                      className="!text-[length:var(--vds-font-body-lv1)]"
                      disabled={saving}
                      onClick={() => setEditingId(null)}
                      size="sm"
                      variant="ghost"
                    >
                      {t('remaining.cancel')}
                    </Button>
                    <Button
                      className="!text-[length:var(--vds-font-body-lv1)]"
                      disabled={saving}
                      onClick={() => void saveEdit()}
                      size="sm"
                      variant="primary"
                    >
                      {t('remaining.save')}
                    </Button>
                  </div>
                </div>
              ) : null}
              {statusLabel ? (
                <Badge className="mt-[var(--vds-space-2)]" size="sm" tone="warning">
                  {statusLabel}
                </Badge>
              ) : null}
            </div>
            <div className="flex items-center gap-[var(--vds-space-half)]">
              {onEdit && editingId !== annotation.id ? (
                <Tooltip content={t('remaining.editNoteTooltip')}>
                  <IconButton
                    className="!size-[var(--vds-space-5)] !min-h-0 !min-w-0 !p-0 !text-[var(--vds-icon-outline-default)]"
                    icon={<PencilLine size={12} strokeWidth={1.5} />}
                    label={t('remaining.editNote', { number })}
                    title={undefined}
                    onClick={() => beginEdit(annotation)}
                    size="xs"
                    variant="ghost"
                  />
                </Tooltip>
              ) : null}
              {onRemove ? (
                <Tooltip content={t('remaining.deleteNoteTooltip')}>
                  <IconButton
                    className="!size-[var(--vds-space-5)] !min-h-0 !min-w-0 !p-0 !text-[var(--vds-icon-outline-default)]"
                    icon={<Trash size={12} strokeWidth={1.5} />}
                    label={removeLabel ?? t('remaining.removeNote', { number })}
                    title={undefined}
                    onClick={() => onRemove(annotation.id)}
                    size="xs"
                    variant="ghost"
                  />
                </Tooltip>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function AnnotationSummary({
  presentation = 'draft',
  annotations = [],
  count = annotations.length,
  description = annotations[0]?.previewText,
  details,
  className,
  onClear,
  onEdit,
  onOpenOriginal,
  onRemove,
  location,
  numberForAnnotation,
  testId = 'answer-annotation-summary',
}: {
  presentation?: 'draft' | 'sent'
  annotations?: AnnotationDisplay[]
  count?: number
  description?: string
  details?: React.ReactNode
  className?: string
  onClear?: () => void
  onEdit?: (annotationId: string, comment: string) => Promise<boolean>
  onOpenOriginal?: (annotationId: string) => void
  onRemove?: (annotationId: string) => void
  location?: { annotationId: string; status: AnswerAnnotationLocation } | null
  numberForAnnotation?: (annotationId: string, index: number) => number
  testId?: string
}): React.JSX.Element | null {
  const { t } = useTranslation('assistant')
  if (count === 0) return null

  const summaryLabel = t('contextGroups.annotations', { count })
  if (presentation === 'sent')
    return (
      <SentReferenceAttachment
        data-testid={testId}
        className={className}
        variant="annotation"
        description={description}
        label={summaryLabel}
        details={
          details ?? (
            <AnnotationDetails
              annotations={annotations}
              location={location}
              numberForAnnotation={numberForAnnotation}
              onOpenOriginal={onOpenOriginal}
            />
          )
        }
      />
    )
  return (
    <HoverCard>
      <ReferenceAttachment
        className={className}
        closeLabel={t('remaining.removeAll')}
        data-testid={testId}
        variant="annotation"
        description={description}
        label={summaryLabel}
        previewTrigger
        onClose={onClear}
      />
      <HoverCardContent
        className="!w-[var(--vds-assistant-notes-width)] !max-w-[var(--vds-assistant-notes-max-width)] overflow-hidden !rounded-[var(--vds-radius-6)] !border-0 !bg-[var(--vds-surface-raised)] !p-0 !shadow-[var(--vds-shadow-2-center)]"
        side="top"
      >
        {details ?? (
          <AnnotationDetails
            annotations={annotations}
            location={location}
            numberForAnnotation={numberForAnnotation}
            onEdit={onEdit}
            onOpenOriginal={onOpenOriginal}
            onRemove={onRemove}
          />
        )}
      </HoverCardContent>
    </HoverCard>
  )
}
