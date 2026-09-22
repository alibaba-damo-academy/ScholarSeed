import type { ForegroundMessage } from '../../contracts/feedback'
/**
 * AI 对话面板领域状态切片（MVP 0.2）。
 *
 * 归属：AI 面板负责人。会话/线程状态仍由 store 顶层的 sessions / threads
 * 持有；本切片承载 Session 上下文的服务端投影和面板瞬态状态。服务端 selection
 * 是上下文队列的权威状态；来源 Feature 只贡献候选并调用 AssistantIngress。
 */

import { candidateLabelFallback } from '../../contracts/assistant.ts'
import type {
  ArtifactLibraryLink,
  AssistantCapability,
  AnswerAnnotation,
  AssistantContextCandidate,
  AssistantContextRef,
  AssistantInvocationResult,
  AssistantTranslationInput,
  AssistantTranslationLanguage,
  AssistantTranslationTarget,
  ProjectContextPolicy,
  SearchScope
} from '../../contracts/assistant'
import type { IconName } from '../../icons'
import type { AnswerAnnotationLocation } from './anchors'

export type AssistantContextError = { key: 'contextErrors.loading' | 'contextErrors.updated' | 'contextErrors.saveFailed' | 'contextErrors.syncFailed' | 'contextErrors.loadFailed' | 'contextErrors.initializeFailed' | 'contextErrors.newSaveFailed' | 'contextErrors.wrongProject' | 'contextErrors.annotationFailed' | 'contextErrors.removeFailed' | 'contextErrors.saveRetry' | 'contextErrors.projectLoading' | 'contextErrors.sourceUnavailable' | 'contextErrors.sourcePending'; detail?: string } | { raw: string }

export type AssistantContextLoadState = 'idle' | 'loading' | 'ready' | 'saving' | 'error'

/** 原型 `+` 两栏菜单中的业务来源；Skill/本机附件仍由 Composer 自己拥有。 */
export type AiContextSource = string

export interface AiContextSourceOption {
  id: AiContextSource
  label: ForegroundMessage
  icon: IconName
  emptyLabel: ForegroundMessage
  requiresProject: boolean
}

export interface AssistantTranslationView {
  input: AssistantTranslationInput
  clientActionId: string
  clientAttemptId: string
  sourceLanguage: AssistantTranslationLanguage
  targetLanguage: AssistantTranslationTarget
  loading: boolean
  invocation: AssistantInvocationResult | null
  error: string | null
}

export interface AnswerAnnotationFocus {
  annotationId: string
  answerId: string
  sequence: number
  status: AnswerAnnotationLocation
}

export interface AiPanelState {
  /** 面板是否展开（顶栏「AI 助手」按钮控制）。 */
  open: boolean
  /** 停靠 or 浮动；原型中的图钉在两种布局间切换。 */
  docked: boolean
  /** 放大对话时覆盖中间工作区；只在停靠态生效。 */
  cover: boolean
  /** 会话下拉菜单开合。 */
  sessionMenuOpen: boolean
  /** 会话搜索命中后，等待历史恢复完成再定位的消息。 */
  messageFocus: {
    sessionId: string
    turnId?: string | null
    itemId?: string | null
    sourceRange?: { unit: string; start: number; end: number } | null
  } | null
  /** 当前投影对应的 Session；切换 Session 时先清空，避免上下文串线。 */
  sessionId: string | null
  contextState: AssistantContextLoadState
  revision: number
  projectPolicy: ProjectContextPolicy
  searchScope: SearchScope
  refs: AssistantContextRef[]
  /** 已被后端受理、等待回合终态消费的 next_turn 引用；仅控制输入区显示。 */
  submittedRefIds: string[]
  capabilities: AssistantCapability[]
  contextError: AssistantContextError | null
  /** 资料上下文选择器是否展开；实际选择仍以服务端 refs 为唯一真源。 */
  contextPickerOpen: boolean
  contextPickerSource: AiContextSource
  contextSources: AiContextSourceOption[]
  contextCandidates: AssistantContextCandidate[]
  contextCandidatesLoading: boolean
  /** 服务端持久化的 AI 回答批注；按当前 Session 加载。 */
  annotations: AnswerAnnotation[]
  artifactLinks: ArtifactLibraryLink[]
  artifactLinksState: 'idle' | 'loading' | 'ready' | 'error'
  /** 历史批注的严格定位结果；可定位项由回答组件消费并短暂高亮。 */
  answerAnnotationFocus: AnswerAnnotationFocus | null
  /** 存入资料库/文献库弹窗；null = 关闭。 */
  saveTarget: { kind: 'resource' | 'literature'; text: string } | null
  /** AI 域拥有的非会话翻译结果；不进入 Stream 或会话列表。 */
  translation: AssistantTranslationView | null
}

export const INITIAL_AI_PANEL_STATE: AiPanelState = {
  open: false,
  docked: true,
  cover: false,
  sessionMenuOpen: false,
  messageFocus: null,
  sessionId: null,
  contextState: 'idle',
  revision: 0,
  projectPolicy: 'explicit_only',
  searchScope: 'web',
  refs: [],
  submittedRefIds: [],
  capabilities: [],
  contextError: null,
  contextPickerOpen: false,
  contextPickerSource: '',
  contextSources: [],
  contextCandidates: [],
  contextCandidatesLoading: false,
  annotations: [],
  artifactLinks: [],
  artifactLinksState: 'idle',
  answerAnnotationFocus: null,
  saveTarget: null,
  translation: null
}

export const ASSISTANT_CONTEXT_FAILURE = {
  PROJECT_LOADING: 'assistant_project_loading',
  SOURCE_UNAVAILABLE: 'assistant_source_unavailable',
  SOURCE_PENDING: 'assistant_source_pending'
} as const

export function beginContextCandidateLoad(
  current: AiPanelState,
  source: AiContextSource
): AiPanelState {
  const keepVisibleCandidates =
    current.contextPickerOpen && current.contextPickerSource === source
  return {
    ...current,
    open: true,
    contextPickerOpen: true,
    contextPickerSource: source,
    contextCandidates: keepVisibleCandidates ? current.contextCandidates : [],
    contextCandidatesLoading: true,
    contextError: null
  }
}

export function replaceCurrentDocumentRefs(
  refs: readonly AssistantContextRef[],
  submittedRefIds: readonly string[]
): AssistantContextRef[] {
  const submitted = new Set(submittedRefIds)
  return refs.filter(
    (ref) => ref.origin !== 'current_document' || submitted.has(ref.ref_id)
  )
}

export function contextRefMatchesCandidate(
  ref: AssistantContextRef,
  candidate: AssistantContextCandidate
): boolean {
  if (
    ref.kind !== candidate.kind
    || ref.source_id !== candidate.source_id
    || JSON.stringify(ref.anchor ?? null) !== JSON.stringify(candidate.anchor ?? null)
  ) {
    return false
  }
  if (candidate.kind === 'file' && candidate.origin === 'explicit' && ref.anchor == null) {
    return true
  }
  return (
    candidate.origin === 'current_document' && ref.origin === 'explicit'
  ) || ref.source_revision === (candidate.source_revision ?? null)
}

export function mergeContextCandidates(
  refs: readonly AssistantContextRef[],
  candidates: readonly AssistantContextCandidate[],
  submittedRefIds: readonly string[],
  createRefId: (candidate: AssistantContextCandidate) => string
): { refs: AssistantContextRef[]; acceptedRefIds: string[]; changed: boolean } {
  const submitted = new Set(submittedRefIds)
  const acceptedRefIds: string[] = []
  let nextRefs = [...refs]
  let changed = false
  for (const candidate of candidates) {
    if (candidate.origin === 'current_document') {
      const retained = replaceCurrentDocumentRefs(nextRefs, submittedRefIds)
      changed ||= retained.length !== nextRefs.length
      nextRefs = retained
    }
    const matches = nextRefs.filter((ref) =>
      !submitted.has(ref.ref_id) && contextRefMatchesCandidate(ref, candidate)
    )
    if (matches.length > 0) {
      const preferred = matches.find((ref) => ref.origin === 'explicit') ?? matches[0]
      if (matches.length > 1) {
        nextRefs = nextRefs.filter((ref) => ref === preferred || !matches.includes(ref))
        changed = true
      }
      const updated = candidate.origin === 'explicit'
        ? {
            ...preferred,
            origin: 'explicit' as const,
            retention: candidate.retention ?? preferred.retention,
            source_revision: candidate.kind === 'file'
              ? candidate.source_revision ?? null
              : preferred.source_revision
          }
        : preferred
      if (
        updated.origin !== preferred.origin
        || updated.retention !== preferred.retention
        || updated.source_revision !== preferred.source_revision
      ) {
        nextRefs = nextRefs.map((ref) => ref === preferred ? updated : ref)
        changed = true
      }
      acceptedRefIds.push(preferred.ref_id)
      continue
    }
    const labelFallback = candidateLabelFallback(candidate)
    nextRefs.push({
      ref_id: createRefId(candidate),
      kind: candidate.kind,
      source_id: candidate.source_id,
      source_revision: candidate.source_revision ?? null,
      label: candidate.label,
      ...((candidate.kind === 'selection' || candidate.kind === 'literature') && candidate.anchor && typeof candidate.selection_source_label === 'string' ? { selection_source_label: candidate.selection_source_label } : {}),
      ...(labelFallback ? { label_fallback: labelFallback } : {}),
      anchor: candidate.anchor ?? null,
      retention: candidate.retention ?? 'next_turn',
      origin: candidate.origin
    })
    changed = true
    acceptedRefIds.push(nextRefs[nextRefs.length - 1].ref_id)
  }
  return { refs: nextRefs, acceptedRefIds, changed }
}

const CONTEXT_FAILURE_KEYS = {
  [ASSISTANT_CONTEXT_FAILURE.PROJECT_LOADING]: 'contextErrors.projectLoading',
  [ASSISTANT_CONTEXT_FAILURE.SOURCE_UNAVAILABLE]: 'contextErrors.sourceUnavailable',
  [ASSISTANT_CONTEXT_FAILURE.SOURCE_PENDING]: 'contextErrors.sourcePending'
} as const

export function assistantContextFailure(message: string): AssistantContextError {
  return Object.prototype.hasOwnProperty.call(CONTEXT_FAILURE_KEYS, message)
    ? { key: CONTEXT_FAILURE_KEYS[message as keyof typeof CONTEXT_FAILURE_KEYS] }
    : { raw: message }
}
