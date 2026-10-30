import React, { useState, type ButtonHTMLAttributes } from 'react'
import { useTranslation } from 'react-i18next'

import type { AnswerAnnotation } from '../../contracts/assistant'
import { Icon } from '../../icons'
import { ComposerRefChip } from '../../components/business/RefChip'
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
  HoverCardTrigger,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Textarea,
} from '../../components/ui'
import { ANSWER_ANNOTATION_LOCATION, type AnswerAnnotationLocation } from './anchors'

const COMMENT_MAX_LENGTH = 600

// 设计稿: 注释标识为蓝色圆形气泡 + 白色序号, 左下角带小尾巴;
const ANNOTATION_BADGE_CLASS =
  'relative inline-grid size-[var(--vds-badge-height-sm)] place-items-center rounded-[var(--vds-radius-circle)] border-0 bg-transparent p-0 text-[length:var(--vds-font-caption)] font-[var(--vds-fw-semibold)] text-[var(--vds-static-white)] shadow-none focus-visible:shadow-[var(--vds-focus-brand)]'

// 设计稿: hover 标识时为白色圆角气泡仅展示备注文本; 点击标识为可编辑弹窗,
// 两者共用 raised 卡片外壳, 编辑弹窗点击外部区域由 Popover 默认行为关闭。
const NOTE_TOOLTIP_CLASS =
  '!gap-0 !max-w-[var(--vds-assistant-floating-panel-width)] !rounded-[var(--vds-radius-3)] !border !border-solid !border-[var(--vds-border-default)] !bg-[var(--vds-surface-raised)] !p-0 shadow-[var(--vds-shadow-md)]'
const NOTE_TOOLTIP_CONTENT_CLASS =
  'whitespace-pre-wrap px-[calc(var(--vds-space-1)+var(--vds-space-half))] py-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)]'
const NOTE_EDITOR_POPOVER_CLASS =
  '!w-[var(--vds-assistant-floating-panel-width)] !max-w-none !gap-0 overflow-hidden !rounded-[var(--vds-radius-6)] !border !border-solid !border-[var(--vds-border-default)] !bg-[var(--vds-surface-raised)] !p-0 !shadow-[var(--vds-shadow-2-down)]'

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
      {/* 设计稿角标为带左下弯尾的对话气泡: 圆形主体 + 同色弯尾路径拼合, 数字按圆心微调居中 */}
      <svg aria-hidden="true" className="absolute inset-0 h-full w-full" viewBox="0 0 20 20">
        <circle cx="11" cy="9" r="8" fill="var(--vds-notice-5)" />
        <path
          d="M5.6 14.2C5.1 15.4 4.3 16.5 3.1 17.5c2.8-.4 5.1-1.3 6.8-2.7z"
          fill="var(--vds-notice-5)"
        />
      </svg>
      <span className="relative translate-x-[1px] -translate-y-[1px]">{number}</span>
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
  const save = async (): Promise<void> => {
    setSaving(true)
    const ok = await onSave(annotation.id, draft)
    setSaving(false)
    if (ok) onClose()
  }
  return (
    <div className="flex flex-col gap-[var(--vds-space-3)] p-[var(--vds-space-4)]">
      <Textarea
        aria-label={inputLabel}
        autoFocus
        className="w-full resize-none border border-solid border-transparent !bg-transparent p-0 text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] !shadow-none focus:outline-none focus-visible:border-[var(--vds-border-brand)] focus-visible:!shadow-none"
        disabled={saving}
        maxLength={COMMENT_MAX_LENGTH}
        onChange={(event) => setDraft(event.target.value)}
        rows={3}
        unstyled
        value={draft}
      />
      <div className="flex items-center justify-between">
        {onRemove ? (
          <IconButton
            className="text-[var(--vds-text-secondary)]"
            icon={<Icon name="trash" size={14} />}
            label={t('remaining.deleteAnnotation')}
            onClick={onRemove}
            variant="ghost"
          />
        ) : (
          <span />
        )}
        <div className="flex items-center gap-[var(--vds-space-2)]">
          <Button disabled={saving} onClick={onClose} size="sm" variant="outline">
            {t('remaining.cancel')}
          </Button>
          <Button
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
}: {
  annotation: AnnotationDisplay | null
  ariaLabel: string
  noteText: string
  number: number
  onRemove?: (annotationId: string) => Promise<boolean> | boolean
  onSave?: (annotationId: string, comment: string) => Promise<boolean>
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const [editOpen, setEditOpen] = useState(false)
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
  const hoverCard = (
    <HoverCard>
      <HoverCardTrigger asChild>
        <AnnotationBadge aria-label={ariaLabel} number={number} />
      </HoverCardTrigger>
      {editOpen ? null : (
        <HoverCardContent className={NOTE_TOOLTIP_CLASS} side="top">
          <div className={NOTE_TOOLTIP_CONTENT_CLASS}>{noteText}</div>
        </HoverCardContent>
      )}
    </HoverCard>
  )
  if (!annotation || !onSave) return hoverCard
  return (
    <>
      <Popover open={editOpen} onOpenChange={setEditOpen}>
        <PopoverTrigger asChild>
          <span className="inline-flex">{hoverCard}</span>
        </PopoverTrigger>
        <PopoverContent className={NOTE_EDITOR_POPOVER_CLASS}>
          <AnnotationCommentEditor
            annotation={annotation}
            inputLabel={t('remaining.editNote', { number })}
            onClose={() => setEditOpen(false)}
            onRemove={
              onRemove
                ? () => {
                    setEditOpen(false)
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
    <div className="max-h-[var(--vds-assistant-notes-max-height)] overflow-auto px-[var(--vds-space-4)] py-[var(--vds-space-3)]">
      {annotations.map((annotation, index) => {
        const number = numberForAnnotation?.(annotation.id, index) ?? index + 1
        const statusLabel = locationLabel(annotation.id)
        return (
          <div
            className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-[var(--vds-space-2)] border-0 border-b border-solid border-[var(--vds-divider-color)] py-[var(--vds-space-3)] first:pt-0 last:border-b-0 last:pb-0"
            data-testid={`answer-annotation-details-${annotation.id}`}
            key={annotation.id}
          >
            <span className="pt-[var(--vds-border-width-1)] text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] text-[var(--vds-text-secondary)]">
              {number}.
            </span>
            <div className="min-w-0">
              <div className="text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-control-label-line-height)] text-[var(--vds-text-tertiary)]">
                {t('annotation.selectedText')}
              </div>
              {onOpenOriginal ? (
                <Button
                  className="h-auto min-h-0 w-full justify-start whitespace-pre-wrap p-0 text-left text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-subhead)] !text-[var(--vds-text-primary)] hover:underline"
                  data-testid={`answer-annotation-open-${annotation.id}`}
                  onClick={() => onOpenOriginal(annotation.id)}
                  unstyled
                >
                  {annotation.previewText}
                </Button>
              ) : (
                <div className="whitespace-pre-wrap text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-subhead)] font-[var(--vds-fw-medium)] text-[var(--vds-text-primary)]">
                  {annotation.previewText}
                </div>
              )}
              {annotation.comment ? (
                <div className="mt-[var(--vds-space-2)]">
                  <div className="text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-control-label-line-height)] text-[var(--vds-text-tertiary)]">
                    {t('annotation.userComment')}
                  </div>
                  <div className="whitespace-pre-wrap text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
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
                      disabled={saving}
                      onClick={() => setEditingId(null)}
                      size="sm"
                      variant="ghost"
                    >
                      {t('remaining.cancel')}
                    </Button>
                    <Button
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
            <div className="flex items-center gap-[var(--vds-space-1)]">
              {onEdit && editingId !== annotation.id ? (
                <IconButton
                  className="text-[var(--vds-text-placeholder)]"
                  icon={<Icon name="edit-square" size={12} />}
                  label={t('remaining.editNote', { number })}
                  onClick={() => beginEdit(annotation)}
                  size="sm"
                  variant="ghost"
                />
              ) : null}
              {onRemove ? (
                <IconButton
                  className="text-[var(--vds-text-placeholder)]"
                  icon={<Icon name="trash" size={12} />}
                  label={removeLabel ?? t('remaining.removeNote', { number })}
                  onClick={() => onRemove(annotation.id)}
                  size="sm"
                  variant="ghost"
                />
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function AnnotationSummary({
  annotations,
  className,
  onClear,
  onEdit,
  onOpenOriginal,
  onRemove,
  location,
  numberForAnnotation,
  testId = 'answer-annotation-summary',
}: {
  annotations: AnnotationDisplay[]
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
  if (annotations.length === 0) return null

  const summaryLabel = `${annotations.length} ${t('annotation.count')}`
  return (
    <ComposerRefChip
      className={`w-fit${className ? ` ${className}` : ''}`}
      closeLabel={t('remaining.removeAll')}
      data-testid={testId}
      icon={<Icon name="quote" size={12} />}
      label={
        <HoverCard>
          <HoverCardTrigger asChild>
            <Button
              className="inline-flex min-w-0 max-w-full items-center text-left focus-visible:shadow-[var(--vds-focus-brand)]"
              unstyled
            >
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                {summaryLabel}
              </span>
            </Button>
          </HoverCardTrigger>
          <HoverCardContent
            className="!w-[380px] !max-w-[calc(100vw-32px)] overflow-hidden !rounded-[var(--vds-radius-6)] !border !border-solid !border-[var(--vds-border-default)] !bg-[var(--vds-surface-raised)] p-0 shadow-[var(--vds-shadow-lg)] ml-[calc(var(--vds-space-1)*-1)] mt-[calc(var(--vds-space-1)*-1)]"
            side="top"
          >
            <AnnotationDetails
              annotations={annotations}
              location={location}
              numberForAnnotation={numberForAnnotation}
              onEdit={onEdit}
              onOpenOriginal={onOpenOriginal}
              onRemove={onRemove}
            />
          </HoverCardContent>
        </HoverCard>
      }
      onClose={onClear}
      title={summaryLabel}
    />
  )
}
