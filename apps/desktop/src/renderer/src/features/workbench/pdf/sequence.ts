import type { PdfAiResult } from './analysis'

export function translationOrder(startPage: number, pageCount: number): number[] {
  if (pageCount < 1) return []
  const start = Math.max(1, Math.min(pageCount, startPage))
  return [
    ...Array.from({ length: pageCount - start + 1 }, (_, index) => start + index),
    ...Array.from({ length: start - 1 }, (_, index) => index + 1),
  ]
}

export function nextTranslationPage(
  startPage: number,
  pageCount: number,
  completedPages: readonly number[]
): number | undefined {
  const completed = new Set(completedPages)
  return translationOrder(startPage, pageCount).find(page => !completed.has(page))
}

export function mergeTranslationResult(
  current: PdfAiResult | undefined,
  incoming: PdfAiResult
): PdfAiResult {
  if (!current || current.target_language !== incoming.target_language) return incoming
  const pages = new Map((current.pages ?? []).map(page => [page.page, page]))
  for (const page of incoming.pages ?? []) pages.set(page.page, page)
  return { ...current, ...incoming, pages: [...pages.values()].sort((left, right) => left.page - right.page) }
}
