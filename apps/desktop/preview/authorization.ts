import { randomUUID } from 'node:crypto'

import type { ProductHilData } from '../src/renderer/src/api.ts'
import type { ConversationSearchResult } from '../src/renderer/src/contracts/literature.ts'

export type PreviewAuthorizationState = 'pending' | 'authorized' | 'rejected'
export type PreviewAuthorizationKind = 'precise' | 'review'

export const PREVIEW_AUTHORIZATION = Object.freeze({
  title: '全文操作确认 · 模拟文献会话',
  prompt: '请检索长上下文相关文献，先展示范围，经过全文授权后再继续。不要导入文献库。',
  introduction:
    '已整理 4 篇模拟候选文献，请确认本次全文读取范围。此场景不会联网、下载、调用模型或入库。',
  authorized: '模拟授权已记录；此处仅展示操作确认结果，没有实际下载、读取或入库。',
  rejected: '模拟全文授权已拒绝；保留候选结果，可从回执重新授权。没有执行全文读取或入库。',
  reviewRejected: '模拟全文授权已拒绝，流程已停止；保留候选结果，没有执行全文读取或入库。',
  allow: '一键授权',
  deny: '拒绝',
  decisionSource: 'user_explicit',
  cardType: 'literature-search',
  questionPrefix: 'precise-search-fulltext:',
  paperPrefix: 'paper:',
  papers: Object.freeze([
    '模拟文献 A：长上下文中的信息位置效应',
    '模拟文献 B：检索增强生成中的证据排序',
    '模拟文献 C：长文本问答与引用定位',
    '模拟文献 D：多文档检索的可复现评估与范围控制',
  ]),
})

const AUTHORIZATION_POLICIES = {
  precise: {
    prefix: PREVIEW_AUTHORIZATION.questionPrefix,
    header: '精准检索授权',
    question: '是否允许下载、读取并使用已展示文献的全文作为证据？',
    title: PREVIEW_AUTHORIZATION.title,
    prompt: PREVIEW_AUTHORIZATION.prompt,
    origin: 'precise-search' as const,
    subset: true,
  },
  review: {
    prefix: 'literature-review-fulltext:',
    header: '综述检索授权',
    question: '是否允许读取已展示文献的全文，用于继续生成文献综述？',
    title: '文献综述 · 全文读取授权 · 模拟会话',
    prompt:
      '请围绕长上下文与证据定位生成文献综述，先展示文献范围，经全文读取授权后再继续。不要导入文献库。',
    origin: 'literature-review' as const,
    subset: false,
  },
}

export class PreviewAuthorizationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}

export class PreviewAuthorization {
  readonly cardId = randomUUID()
  private readonly questions = new Map<string, ProductHilData>()
  private readonly renewals = new Map<string, string>()
  private currentId: string

  constructor(
    readonly sessionId: string,
    readonly kind: PreviewAuthorizationKind = 'precise'
  ) {
    this.currentId = this.createQuestion()
  }

  get policy() {
    return AUTHORIZATION_POLICIES[this.kind]
  }

  private createQuestion(): string {
    const requestId = this.policy.prefix + randomUUID()
    this.questions.set(requestId, {
      request_id: requestId,
      kind: 'question',
      method: 'user_input',
      lifetime: 'session',
      state: 'pending',
      requested_at: Date.now() / 1000,
      questions: [
        {
          id: requestId,
          header: this.policy.header,
          question: this.policy.question,
          result_card_id: this.cardId,
          options: [
            { label: PREVIEW_AUTHORIZATION.allow + ' (Recommended)' },
            { label: PREVIEW_AUTHORIZATION.deny },
          ],
          papers: this.papers().map((paper) => ({
            id: PREVIEW_AUTHORIZATION.paperPrefix + paper.id,
            label: paper.title,
            description: 'PDFE 模拟数据，不执行真实全文操作。',
          })),
        },
      ],
    })
    return requestId
  }

  current(): ProductHilData {
    return structuredClone(this.questions.get(this.currentId)!)
  }

  resolve(
    requestId: string,
    body: Record<string, unknown>
  ): ProductHilData & { state: 'resolved' } {
    const question = this.questions.get(requestId)
    if (!question || requestId !== this.currentId || question.state !== 'pending')
      throw new PreviewAuthorizationError(409, 'interaction_not_pending')
    const answers = body.answers as Record<string, unknown> | undefined
    const answer = answers?.[requestId]
    if (answer !== PREVIEW_AUTHORIZATION.allow && answer !== PREVIEW_AUTHORIZATION.deny)
      throw new PreviewAuthorizationError(400, 'preview_invalid_answer')
    const values = body.values as Record<string, unknown> | undefined
    const selected =
      values?.selected_paper_ids ?? question.questions![0].papers!.map((paper) => paper.id)
    const allowed = new Set(question.questions![0].papers!.map((paper) => paper.id))
    if (
      !Array.isArray(selected) ||
      selected.some((id) => typeof id !== 'string' || !allowed.has(id)) ||
      new Set(selected).size !== selected.length
    )
      throw new PreviewAuthorizationError(400, 'preview_invalid_selection')
    if (!this.policy.subset && selected.length !== allowed.size)
      throw new PreviewAuthorizationError(400, 'preview_invalid_selection')
    const resolved = {
      ...question,
      state: 'resolved' as const,
      decision_source: PREVIEW_AUTHORIZATION.decisionSource,
      answers: { [requestId]: answer },
      selected_paper_ids: answer === PREVIEW_AUTHORIZATION.allow ? (selected as string[]) : [],
      resolved_at: Date.now() / 1000,
    }
    this.questions.set(requestId, resolved)
    return structuredClone(resolved)
  }

  retry(requestId: string, readOnly = false): { ok: true; request_id: string } {
    const existing = this.renewals.get(requestId)
    if (existing) return { ok: true, request_id: existing }
    const question = this.questions.get(requestId)
    if (
      readOnly ||
      !question ||
      requestId !== this.currentId ||
      question.answers?.[requestId] !== PREVIEW_AUTHORIZATION.deny
    )
      throw new PreviewAuthorizationError(
        readOnly ? 404 : 409,
        'preview_reauthorization_unavailable'
      )
    this.currentId = this.createQuestion()
    this.renewals.set(requestId, this.currentId)
    return { ok: true, request_id: this.currentId }
  }

  private papers() {
    return PREVIEW_AUTHORIZATION.papers.map((title, index) => ({
      id: `preview-paper-${index + 1}`,
      title,
      authors: ['PDFE Mock'],
      year: 2026,
      venue: '模拟文献集合',
      doi: null,
      url: null,
      abstract: '用于核对授权范围与界面布局的模拟文献，不对应真实检索或全文内容。',
      reasons: ['模拟候选范围'],
      access: 'unknown',
      sources: ['PDFE Mock'],
    }))
  }

  result(): Record<string, unknown> {
    const papers = this.papers()
    const result: ConversationSearchResult = {
      schema_version: '1.0',
      session_id: this.sessionId,
      run_id: this.cardId,
      round: 1,
      status: 'success',
      criteria: ['模拟检索：长上下文与证据定位'],
      sources: [{ name: 'PDFE Mock', status: 'success', queries: 1, candidates: papers.length }],
      candidates: papers.length,
      deduplicated: papers.length,
      retained: papers.length,
      papers,
      warnings: [],
      origin: this.policy.origin,
      selection: { artifact_id: 'preview-selection' },
      metadata: { artifact_id: 'preview-metadata' },
      report: {
        artifact_id: 'preview-report',
        path: 'preview-report.json',
        name: 'preview-report.json',
        media_type: 'application/json',
        size: 0,
      },
    }
    return { ...result }
  }
}
