import type { TFunction } from 'i18next'
import type { createFormatters } from '../../../../localization/format'
import { candidateLabelFallback, contextLabelFallback } from '../../contracts/assistant.ts'
import type { AssistantContextCandidate } from '../../contracts/assistant.ts'
import { useTranslation } from 'react-i18next'
import { assistantContextFailure } from './state.ts'

export function useAssistantContextText(): (message: string) => string {
  const { t } = useTranslation('assistant')
  return (message) => {
    const failure = assistantContextFailure(message)
    return 'raw' in failure ? failure.raw : t(failure.key, { detail: failure.detail ?? '' })
  }
}

export function candidateLabel(item: AssistantContextCandidate, t: TFunction<'assistant'>): string {
  return referenceLabel({ ...item, label_fallback: candidateLabelFallback(item) }, t)
}

export function candidateHint(item: AssistantContextCandidate, t: TFunction<'assistant'>): string {
  return item.hintKey === 'wholeSession' ? t('sources.wholeSession') : item.hint ?? ''
}

/** Explicit provenance separates original source titles from localized display labels. */
export interface ReferencePresentation {
  kind?: string
  label_fallback?: unknown
  selection_source_label?: string | null
  anchor?: unknown
  label?: string
  title?: string
}

export function referenceBaseLabel(item: ReferencePresentation, t: TFunction<'assistant'>): string {
  if ((item.kind === 'selection' || item.kind === 'literature') && item.anchor && typeof item.selection_source_label === 'string') return item.selection_source_label
  const fallback = contextLabelFallback(item.kind, item.label_fallback)
  return fallback === 'new_session' ? t('panel.new')
    : fallback === 'untitled_session' ? t('sources.untitledSession') : item.title ?? item.label ?? ''
}

export function referenceLabel(item: ReferencePresentation, t: TFunction<'assistant'>): string {
  return (item.kind === 'selection' || item.kind === 'literature') && item.anchor && typeof item.selection_source_label === 'string'
    ? t('sources.selectionLabel', { name: item.selection_source_label }) : referenceBaseLabel(item, t)
}

/** Preview title follows the current source; preview provenance is authoritative, including null. */
export function previewReferenceLabel(reference: { title: string }, preview: { title: string; label_fallback?: unknown }, t: TFunction<'assistant'>): string {
  return referenceLabel({ kind: 'session', title: preview.title || reference.title, label_fallback: preview.label_fallback }, t)
}

/**
 * 历史对话浮层右侧的更新时间（Unix 秒）。
 *
 * 接口没给 mtime 就返回空串，调用方整列不渲染 —— 不拿占位符冒充时间。
 * 日期格式走本地化统一入口 createFormatters，不在页面里自己拼 locale。
 */
export function sessionTimeLabel(timestamp: number | undefined, format: ReturnType<typeof createFormatters>): string {
  if (!timestamp) return ''
  return format.date(timestamp * 1_000, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}
