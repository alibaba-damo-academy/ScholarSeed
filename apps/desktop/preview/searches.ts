import { randomUUID } from 'node:crypto'
import type { LiteratureSearchPaper, LiteratureSearchTask } from '../src/renderer/src/contracts/literature.ts'
import { WEB_SEARCH_CANDIDATE_LIMIT } from '../src/renderer/src/features/resources/search.ts'

export const PREVIEW_SEARCH = {
  hostname: 'example.invalid',
  literatureQuery: '模拟文献检索：可复现研究',
  literatureTitle: 'Mock paper: reproducible research workflows',
} as const

export class PreviewSearchError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class PreviewSearches {
  private readonly tasks: LiteratureSearchTask[]

  constructor({ literature = false }: { literature?: boolean } = {}) {
    if (!literature) {
      this.tasks = []
      return
    }
    const created = Date.now() / 1_000
    const papers: LiteratureSearchPaper[] = [
      { paper_id: randomUUID(), title: PREVIEW_SEARCH.literatureTitle, authors: ['Preview Research Team'], year: 2026, venue: 'Mock Research Collection', abstract: 'This is reviewed mock literature data for validating the real search result viewer. It is not a published scientific paper.', citation_count: 12, doi: '', arxiv_id: '', tier: null, reason: '模拟相关性说明：记录实验输入、方法与复现结果。', subtopics_covered: ['reproducibility'], access: 'open', source: 'preview', fulltext: 'abstract', url: `https://${PREVIEW_SEARCH.hostname}/paper/reproducibility` },
      { paper_id: randomUUID(), title: 'Mock paper: collaborative interface evaluation', authors: ['Preview Design Team'], year: 2025, venue: 'Mock Design Collection', abstract: 'An explicitly simulated abstract for shared interface evaluation. No literature retrieval or import has occurred.', citation_count: 3, doi: '', arxiv_id: '', tier: null, reason: '模拟相关性说明：在相同界面与受审数据上协作评估。', subtopics_covered: ['collaboration'], access: 'open', source: 'preview', fulltext: 'abstract', url: `https://${PREVIEW_SEARCH.hostname}/paper/collaboration` },
    ]
    const result = { search_summary: { query: PREVIEW_SEARCH.literatureQuery, total_rounds: 1, total_queries: 1, pool_size: papers.length, selected_count: papers.length, subtopics: ['reproducibility', 'collaboration'], coverage_assessment: '仅为受审模拟历史检索结果，不代表真实文献覆盖率。' }, papers }
    this.tasks = [{ id: randomUUID(), query: PREVIEW_SEARCH.literatureQuery, created_at: created, completed_at: created, status: 'completed', last_seq: 0, output: JSON.stringify(result), error: null, result }]
  }

  listLiterature(): { items: LiteratureSearchTask[] } {
    return { items: structuredClone(this.tasks) }
  }

  resultStatus(body: unknown): { items: Record<string, { library: 'absent' }> } {
    if (!record(body) || !Array.isArray(body.papers) || body.papers.length > WEB_SEARCH_CANDIDATE_LIMIT) throw new PreviewSearchError(422, 'preview_search_invalid')
    const known = new Set(this.tasks.flatMap(task => task.result?.papers.map(paper => paper.paper_id) ?? []))
    const items: Record<string, { library: 'absent' }> = {}
    for (const paper of body.papers) {
      if (!record(paper) || typeof paper.id !== 'string' || !known.has(paper.id)) throw new PreviewSearchError(422, 'preview_search_paper_unknown')
      items[paper.id] = { library: 'absent' }
    }
    return { items }
  }

}
