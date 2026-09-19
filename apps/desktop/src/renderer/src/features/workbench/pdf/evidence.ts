/** Page navigation is page-scoped; retain every supporting quote in its tooltip. */
export function evidencePages(evidence: { page: number; quote: string }[] = []): { page: number; quote: string }[] {
  const pages = new Map<number, Set<string>>()
  for (const anchor of evidence) {
    const quotes = pages.get(anchor.page) ?? new Set<string>()
    quotes.add(anchor.quote)
    pages.set(anchor.page, quotes)
  }
  return [...pages].sort(([left], [right]) => left - right)
    .map(([page, quotes]) => ({ page, quote: [...quotes].join('\n\n') }))
}
