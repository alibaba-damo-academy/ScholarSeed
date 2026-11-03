import type { LiteratureDownloadCard } from '../../contracts/literature'

export function conversationProject<Project extends { id: string; path: string }>(
  projects: readonly Project[],
  projectPath: string | null | undefined
): Project | undefined {
  return projectPath ? projects.find((project) => project.path === projectPath) : undefined
}

interface DownloadActions {
  openLiteratureItem: (id: string, projectId: string) => Promise<boolean>
  openLiteratureAttachment: (
    id: string,
    attachmentId?: string,
    page?: number,
    options?: { projectId?: string | null }
  ) => Promise<boolean>
}

export async function openDownloadedFulltext(
  actions: DownloadActions,
  card: LiteratureDownloadCard,
  paper: LiteratureDownloadCard['papers'][number],
  resolve?: (
    sessionId: string,
    operationId: string
  ) => Promise<{ literature_id: string; attachment_id: string }>
): Promise<boolean> {
  const current =
    paper.operation_id && resolve ? await resolve(card.session_id, paper.operation_id) : paper
  if (!(await actions.openLiteratureItem(current.literature_id, card.project_id))) return false
  return actions.openLiteratureAttachment(current.literature_id, current.attachment_id, undefined, {
    projectId: card.project_id,
  })
}

const DOWNLOAD_CARD_VERSION = '1.0'
export const DOWNLOAD_REFRESH_CACHE_LIMIT = 256
const refreshedDownloads = new Set<string>()

export function downloadRefreshKey(cardId: string, card: LiteratureDownloadCard | null): string {
  if (!card || card.papers.length + (card.omitted_papers ?? 0) === 0) return ''
  return JSON.stringify([
    cardId,
    card.session_id,
    card.run,
    card.project_id,
    card.papers.map((paper) => [paper.literature_id, paper.attachment_id, paper.revision]),
    card.omitted_papers ?? 0,
  ])
}

export function claimDownloadRefresh(key: string): boolean {
  if (!key || refreshedDownloads.has(key)) return false
  refreshedDownloads.add(key)
  if (refreshedDownloads.size > DOWNLOAD_REFRESH_CACHE_LIMIT) {
    const oldest = refreshedDownloads.values().next().value
    if (oldest !== undefined) refreshedDownloads.delete(oldest)
  }
  return true
}

const isString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value)

export function parseDownloadCard(value: Record<string, unknown>): LiteratureDownloadCard | null {
  if (
    value.schema_version !== DOWNLOAD_CARD_VERSION ||
    !isString(value.session_id) ||
    !isString(value.run) ||
    typeof value.project_id !== 'string' ||
    !Array.isArray(value.papers) ||
    !Array.isArray(value.failures)
  )
    return null
  const papers: LiteratureDownloadCard['papers'] = []
  for (const paper of value.papers) {
    if (
      !isRecord(paper) ||
      !isString(paper.paper_id) ||
      !isString(paper.literature_id) ||
      !isString(paper.attachment_id) ||
      !isString(paper.title) ||
      !isString(paper.revision) ||
      (paper.operation_id !== undefined && !isString(paper.operation_id))
    )
      return null
    papers.push({
      paper_id: paper.paper_id,
      literature_id: paper.literature_id,
      attachment_id: paper.attachment_id,
      title: paper.title,
      revision: paper.revision,
      ...(paper.operation_id ? { operation_id: paper.operation_id } : {}),
    })
  }
  const failures: LiteratureDownloadCard['failures'] = []
  for (const failure of value.failures) {
    if (!isRecord(failure) || !isString(failure.paper_id) || !isString(failure.code)) return null
    failures.push({ paper_id: failure.paper_id, code: failure.code })
  }
  if (new Set(papers.map((paper) => paper.paper_id)).size !== papers.length) return null
  const omittedPapers = value.omitted_papers
  const omittedFailures = value.omitted_failures
  if (
    omittedPapers !== undefined &&
    (typeof omittedPapers !== 'number' || !Number.isSafeInteger(omittedPapers) || omittedPapers < 0)
  )
    return null
  if (
    omittedFailures !== undefined &&
    (typeof omittedFailures !== 'number' ||
      !Number.isSafeInteger(omittedFailures) ||
      omittedFailures < 0)
  )
    return null
  return {
    schema_version: value.schema_version,
    session_id: value.session_id,
    run: value.run,
    project_id: value.project_id,
    papers,
    failures,
    ...(omittedPapers !== undefined && { omitted_papers: omittedPapers }),
    ...(omittedFailures !== undefined && { omitted_failures: omittedFailures }),
  }
}

export function downloadOutcome(card: LiteratureDownloadCard) {
  const saved = card.papers.length + (card.omitted_papers ?? 0)
  const failed = card.failures.length + (card.omitted_failures ?? 0)
  if (saved > 0 && failed > 0)
    return {
      saved,
      failed,
      heading: 'downloads.partialHeading',
      descriptionKey: 'downloads.partialSaved',
    } as const
  if (saved > 0)
    return {
      saved,
      failed,
      heading: 'downloads.heading',
      descriptionKey: card.project_id ? 'downloads.projectLinked' : 'downloads.globalSaved',
    } as const
  if (failed > 0)
    return {
      saved,
      failed,
      heading: 'downloads.failedHeading',
      descriptionKey: 'downloads.noneSaved',
    } as const
  return {
    saved,
    failed,
    heading: 'downloads.emptyHeading',
    descriptionKey: 'downloads.empty',
  } as const
}

export function downloadSupersessionKey(value: Record<string, unknown>): string | null {
  const card = parseDownloadCard(value)
  return card ? JSON.stringify([card.session_id, card.run, card.project_id]) : null
}
