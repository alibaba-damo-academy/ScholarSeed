import type { TFunction } from 'i18next'
import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { LiteratureExcerptSelection, LiteratureExcerptSource } from '../../contracts/resources'
import {
  importLiteratureExcerpts,
  type LiteratureExcerptImportMutation
} from '../../features/resources/api'
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  ScrollArea
} from '../ui'

const DEFAULT_EXCERPT_PARENT = '文献摘录'
const PREVIEW_TEXT_LIMIT = 240

const IMPORT_ERROR_KEYS = {
  ambiguous_excerpt_resource: 'excerpts.errors.ambiguous_excerpt_resource',
  excerpt_too_large: 'excerpts.errors.excerpt_too_large',
  invalid_excerpt: 'excerpts.errors.invalid_excerpt',
  invalid_excerpt_resource: 'excerpts.errors.invalid_excerpt_resource',
  invalid_locator: 'excerpts.errors.invalid_locator',
  invalid_page: 'excerpts.errors.invalid_page',
  invalid_excerpt_response: 'excerpts.errors.invalid_excerpt_response',
  literature_not_found: 'excerpts.errors.literature_not_found',
  literature_pdf_missing: 'excerpts.errors.literature_pdf_missing',
  literature_revision_conflict: 'excerpts.errors.literature_revision_conflict',
  network_error: 'excerpts.errors.network_error',
  resource_excerpts_unavailable: 'excerpts.errors.resource_excerpts_unavailable',
  selections_required: 'excerpts.errors.selections_required',
  unsupported_excerpt_source: 'excerpts.errors.unsupported_excerpt_source'
} as const

type LiteratureExcerptImportSuccess = Extract<LiteratureExcerptImportMutation, { ok: true }>

export interface LiteratureExcerptImportProps {
  projectId: string
  source: LiteratureExcerptSource
  documentRevision?: string
  selections: readonly LiteratureExcerptSelection[]
  parent?: string
  defaultName?: string
  disabled?: boolean
  onImported?: (result: LiteratureExcerptImportSuccess) => void
  onError?: (error: string) => void
}

function previewText(text: string): string {
  const normalized = text.trim()
  if (normalized.length <= PREVIEW_TEXT_LIMIT) return normalized
  return `${normalized.slice(0, PREVIEW_TEXT_LIMIT)}…`
}

function successMessage(result: LiteratureExcerptImportSuccess, t: TFunction<'literature'>): string {
  if (!result.added) return t('excerpts.resultSkipped', { count: result.skipped })
  return t(result.operation === 'created' ? 'excerpts.resultCreatedSummary' : 'excerpts.resultAppendedSummary', {
    added: result.added, skipped: result.skipped, total: result.total
  })
}

function errorMessage(error: string, t: TFunction<'literature'>): string {
  const key = Object.prototype.hasOwnProperty.call(IMPORT_ERROR_KEYS, error)
    ? IMPORT_ERROR_KEYS[error as keyof typeof IMPORT_ERROR_KEYS] : null
  return key ? t(key) : t('excerpts.saveFailedWithError', { error })
}

/**
 * 文献 PDF 选区 → 资料库的可复用接入组件。
 *
 * 调用方只需提供项目、文献身份、PDF revision 和当前多段选区；组件负责确认、
 * 预览、请求状态、错误码解释与重复段落结果展示。
 */
export function LiteratureExcerptImport({
  projectId,
  source,
  documentRevision,
  selections,
  parent = DEFAULT_EXCERPT_PARENT,
  defaultName,
  disabled = false,
  onImported,
  onError
}: LiteratureExcerptImportProps): React.JSX.Element {
  const { t } = useTranslation('literature')
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(defaultName ?? source.title)
  const [pendingSelections, setPendingSelections] = useState<readonly LiteratureExcerptSelection[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [outcome, setOutcome] = useState<LiteratureExcerptImportMutation | null>(null)
  const pages = useMemo(
    () => Array.from(new Set(pendingSelections.map((selection) => selection.locator.page))).sort((a, b) => a - b),
    [pendingSelections]
  )

  const changeOpen = (next: boolean): void => {
    if (submitting) return
    setOpen(next)
    if (next) {
      setName(defaultName ?? source.title)
      setPendingSelections(selections)
      setOutcome(null)
    }
  }

  const submit = async (): Promise<void> => {
    if (submitting || !projectId || !source.literatureId || !pendingSelections.length) return
    setSubmitting(true)
    setOutcome(null)
    const result = await importLiteratureExcerpts({
      project: projectId,
      literatureId: source.literatureId,
      documentRevision,
      selections: pendingSelections,
      parent,
      name: name.trim() || undefined
    })
    setSubmitting(false)
    setOutcome(result)
    if (result.ok) onImported?.(result)
    else onError?.(result.error)
  }

  const triggerUnavailable = disabled || !projectId || !source.literatureId || !selections.length
  const submitUnavailable = disabled || !projectId || !source.literatureId || !pendingSelections.length

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button
          data-testid="pdf-import-excerpts"
          disabled={triggerUnavailable}
          size="sm"
          variant="secondary"
        >
          {selections.length ? t('excerpts.saveSelection', { count: selections.length }) : t('excerpts.save')}
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-label={t('excerpts.dialogLabel')}
        className="w-[min(640px,calc(100vw-32px))] max-w-none"
        data-testid="literature-excerpt-import-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('excerpts.saveTitle')}</DialogTitle>
          <DialogDescription>
            {t('excerpts.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2 rounded-[var(--vds-radius-3)] border border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] p-3">
            <div className="min-w-0 text-sm font-medium text-[var(--vds-text-primary)]">
              {source.title}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge size="sm" tone="brand">{t('excerpts.count', { count: pendingSelections.length })}</Badge>
              {pages.map((page) => <Badge key={page} size="sm" tone="neutral">{t('excerpts.page', { page })}</Badge>)}
              <span className="text-xs text-[var(--vds-text-tertiary)]">{t('excerpts.libraryPath', { parent })}</span>
            </div>
          </div>

          <div className="grid gap-1">
            <Input
              data-testid="literature-excerpt-name"
              label={t('excerpts.nameLabel')}
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
            <p className="m-0 text-xs leading-5 text-[var(--vds-text-tertiary)]">
              {t('excerpts.nameHint')}
            </p>
          </div>

          <ScrollArea
            aria-label={t('excerpts.previewLabel')}
            className="max-h-60 rounded-[var(--vds-radius-3)] border border-[var(--vds-border-default)]"
            viewportClassName="grid gap-2 p-3"
          >
            {pendingSelections.map((selection, index) => (
              <div
                className="grid gap-1 border-b border-[var(--vds-border-default)] pb-2 last:border-b-0 last:pb-0"
                key={`${selection.locator.page}:${index}`}
              >
                <span className="text-xs font-medium text-[var(--vds-text-secondary)]">
                  {t('excerpts.page', { page: selection.locator.page })}
                </span>
                <p className="m-0 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--vds-text-primary)]">
                  {previewText(selection.text)}
                </p>
              </div>
            ))}
          </ScrollArea>

          {outcome?.ok ? (
            <Alert
              data-testid="literature-excerpt-import-success"
              description={successMessage(outcome, t)}
              title={t('excerpts.saved')}
              tone="success"
            />
          ) : outcome ? (
            <Alert
              data-testid="literature-excerpt-import-error"
              description={errorMessage(outcome.error, t)}
              title={t('excerpts.saveFailed')}
              tone="error"
            />
          ) : null}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button disabled={submitting} variant="ghost">{outcome?.ok ? t('excerpts.done') : t('excerpts.cancel')}</Button>
          </DialogClose>
          {!outcome?.ok ? (
            <Button
              data-testid="literature-excerpt-import-submit"
              disabled={submitUnavailable}
              loading={submitting}
              onClick={() => void submit()}
            >
              {submitting ? t('excerpts.saving') : t('excerpts.confirm')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
