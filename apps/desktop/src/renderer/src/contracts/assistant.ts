/**
 * assistant 域前端契约（开发 6 拥有）。
 *
 * 与 `service/platform/context.py` 对应，描述 Session 级上下文选择及其更新接口。
 *
 * 硬约定：`AssistantContextRef.source_id` **永远是稳定 ID 而非绝对路径**
 * （架构文档 §2.3）。FILE/DIR → 项目内相对路径；RESOURCE/LITERATURE →
 * 条目 id；SESSION → 会话 id。`preview_text` 仅供页面展示，模型材料由服务端
 * 在 Turn 准入时根据稳定 ID 和版本重新解析。
 */

import type { SelectionLocator } from './workbench'
import type { ResourceNode } from './resources'

export interface ArtifactLinkIdentity {
  link_id: string
  project_id: string
  session_id: string
  artifact_id: string
  source_sha256: string
  state: 'pending' | 'completed'
  target_ids: string[]
  error: string | null
}

export interface ArtifactResourceLink extends ArtifactLinkIdentity {
  destination: 'resources'
  node: ResourceNode | null
}

export interface ArtifactLiteratureLink extends ArtifactLinkIdentity {
  destination: 'literature'
  items: Array<{ id: string; title: string }>
  missing_ids: string[]
}

export type ArtifactLibraryLink = ArtifactResourceLink | ArtifactLiteratureLink
export type ArtifactLibraryLinksResult =
  | { ok: true; links: ArtifactLibraryLink[] }
  | ({ ok: false; error: string } & AssistantFailure)

export type ArtifactResourceLinksResult =
  | { ok: true; links: ArtifactResourceLink[] }
  | { ok: false; error: string }

/** 是否允许服务端自动引入当前项目上下文。 */
export type ProjectContextPolicy = 'auto_project' | 'explicit_only'

/** 问答的外部检索范围；项目上下文由 ProjectContextPolicy 独立控制。 */
export type SearchScope = 'disabled' | 'academic' | 'web'

/** 上下文附加项种类。 */
export type ContextRefKind =
  | 'file'
  | 'dir'
  | 'resource'
  | 'literature'
  | 'literature_collection'
  | 'session'
  | 'selection'
  | 'note'

export interface AssistantSelectionAnchor {
  /** 选区所属的来源域稳定文档 ID；文献选区使用附件 ID。 */
  document_id?: string | null
  /** 唯一坐标联合由 Workbench 定义；Assistant 不按文件类型解释它。 */
  locator: SelectionLocator
  /** 被选择原文的哈希，用于发现来源内容变化。 */
  selected_text_hash: string
  /** 仅供页面展示的安全预览，不直接作为模型事实源。 */
  preview_text: string
}

export type ContextLabelFallback = 'untitled_session' | 'new_session' | null

export function contextLabelFallback(kind: string | undefined, fallback: unknown): ContextLabelFallback {
  return kind === 'session' && (fallback === 'untitled_session' || fallback === 'new_session') ? fallback : null
}

export function candidateLabelFallback(item: Pick<AssistantContextCandidate, 'kind' | 'labelFallback'>): ContextLabelFallback {
  return item.kind === 'session'
    ? item.labelFallback === 'newSession' ? 'new_session' : item.labelFallback === 'untitledSession' ? 'untitled_session' : null
    : null
}

export type ContextRetention = 'session' | 'next_turn'
export type ContextOrigin = 'explicit' | 'current_document' | 'implicit_retrieval'
export type AssistantSourceFilter = 'all' | 'recent' | 'newest'

/** Session 选择中的一条结构化上下文引用。 */
export interface AssistantContextRef {
  /** Original source title, including empty strings; only selection/literature with an anchor. */
  selection_source_label?: string | null
  label_fallback?: ContextLabelFallback
  /** 当前选择内稳定且唯一的引用 id。 */
  ref_id: string
  kind: ContextRefKind
  /** 来源稳定标识；文件/目录必须是项目内相对路径。 */
  source_id: string
  /** 来源版本；存在时用于 Turn 准入阶段的陈旧性校验。 */
  source_revision?: string | null
  label: string
  anchor?: AssistantSelectionAnchor | null
  /** session 持续保留；next_turn 在确定受理后由服务端消费。 */
  retention: ContextRetention
  origin: ContextOrigin
}

/** 资料、文献与 Viewer 交给 AI 对话的页面安全候选。 */
export interface AssistantContextCandidate {
  /** Original source title, including empty strings; only selection/literature with an anchor. */
  selection_source_label?: string | null
  labelFallback?: 'untitledSession' | 'newSession'
  hintKey?: 'wholeSession'
  kind: ContextRefKind
  source_id: string
  source_revision?: string | null
  label: string
  retention?: ContextRetention
  origin: Extract<ContextOrigin, 'explicit' | 'current_document'>
  anchor?: AssistantSelectionAnchor | null
  hint?: string
  unavailable_reason?: string
  /** Picker-only creation timestamp used by the newest-first quick filter. */
  created_at?: number
  /** Picker-only user activity timestamp used by the recently-opened quick filter. */
  opened_at?: number
}

export interface AssistantContextMutationResult {
  session_id: string | null
  revision: number
  accepted_ref_ids: string[]
  rejected: Array<{ source_id: string; code: string; message: string }>
}

export type AssistantInvocationStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown'

export type AssistantTranslationLanguage = 'auto' | 'en' | 'zh-CN'
export type AssistantTranslationTarget = Exclude<AssistantTranslationLanguage, 'auto'>

/** 不进入会话列表的一次性 Agent 调用。 */
export interface AssistantOneShotInput {
  input_text: string
  instructions?: string
  model_key?: string
}

/** Viewer/业务 Feature 发起翻译时提供的页面数据。 */
export interface AssistantTranslationInput {
  text: string
  source_language?: AssistantTranslationLanguage
  target_language?: AssistantTranslationTarget
  source_id?: string
  source_revision?: string | null
  label?: string
  model_key?: string
}

export interface AssistantInvocationResult {
  invocation_id: string
  client_action_id: string
  client_attempt_id: string
  retry_of_attempt_id: string | null
  kind: 'complete' | 'translate' | 'compiled'
  project_id: string
  source: { source_id: string; source_revision: string | null }
  prompt_version: string
  status: AssistantInvocationStatus
  detected_source_language: string | null
  target_language: string
  model_key: string | null
  output: { type: 'text'; text: string } | null
  usage: { input_tokens: number; output_tokens: number; receipt_id: string | null }
  error: { code: string; detail: string } | null
  created_at: number
  updated_at: number
}

/** Application-generated failure provenance; upstream error strings never imply this marker. */
export interface AssistantFailure {
  error?: string
  applicationFailure?: { code: 'request_failed'; detail?: string }
}

export interface AssistantInvocationMutationResult extends AssistantFailure {
  ok: boolean
  invocation?: AssistantInvocationResult
  error?: string
}

export type AssistantSelectionActionKind = 'interpret' | 'translate' | 'polish'

export interface AssistantSelectionEvent {
  type: 'accepted' | 'started' | 'output_delta' | 'output_completed'
  invocation_id: string
  text: string
  item_id: string
}

export interface AssistantSelectionStreamOptions {
  onEvent: (event: AssistantSelectionEvent) => void
  signal?: AbortSignal
}

/** Current editor text used only for one action when the open document is dirty. */
export interface AssistantSelectionDraft {
  change_version: number
  selected_text: string
  context_text: string
  selected_text_hash: string
}

/** Workbench 交给 AssistantIngress 的权威选区动作输入，不含项目或调用身份。 */
export interface AssistantSelectionActionInput {
  action: AssistantSelectionActionKind
  source_id: string
  source_revision: string
  selection: AssistantSelectionAnchor
  draft?: AssistantSelectionDraft
  question?: string
  target_language?: string
}

export interface AssistantSelectionActionResult {
  action: AssistantSelectionActionKind
  prompt_version: string
  output: string
  invocation_id: string
  client_action_id: string
  client_attempt_id: string
  retry_of_attempt_id: string | null
  status: AssistantInvocationStatus
  error_code: string
}

export type AssistantSelectionActionMutationResult =
  | { ok: true; result: AssistantSelectionActionResult }
  | { ok: false; error: string }

/** 其它前端 Feature 只能通过这个窄入口加入上下文。 */
export interface AssistantIngress {
  addContext(candidate: AssistantContextCandidate): Promise<AssistantContextMutationResult>
  addContexts(candidates: readonly AssistantContextCandidate[]): Promise<AssistantContextMutationResult>
  invokeOnce(input: AssistantOneShotInput): Promise<AssistantInvocationMutationResult>
  translate(input: AssistantTranslationInput): Promise<AssistantInvocationMutationResult>
  invokeSelection(
    input: AssistantSelectionActionInput,
    retry?: boolean,
    stream?: AssistantSelectionStreamOptions
  ): Promise<AssistantSelectionActionMutationResult>
  stopSelection(invocationId: string): Promise<boolean>
  openPanel(reason: 'context_added' | 'selection_action' | 'user_request'): void
}

/** 服务端对一个来源或策略能力的可用性声明。 */
export interface AssistantCapability {
  name: string
  available: boolean
  reason: string
}

/** 服务端持有的 Session 当前上下文选择。 */
export interface AssistantContextSelection {
  session_id: string
  revision: number
  project_policy: ProjectContextPolicy
  search_scope: SearchScope
  refs: AssistantContextRef[]
  updated_at: number
  capabilities: AssistantCapability[]
}

/** 以 expected_revision 进行 CAS 替换的完整选择载荷。 */
export interface AssistantContextPatch {
  expected_revision: number
  project_policy: ProjectContextPolicy
  search_scope: SearchScope
  refs: AssistantContextRef[]
}

/** A persisted note anchored to one immutable, completed AI answer. */
export interface AnswerAnnotation {
  annotation_id: string
  client_annotation_id: string
  session_id: string
  answer_id: string
  source_product_seq: number
  source_turn_id: string
  source_item_id: string | null
  answer_revision: string
  start_utf16: number
  end_utf16: number
  selected_text_hash: string
  preview_text: string
  comment: string
  revision: number
  created_at: number
  updated_at: number
}

export interface AnswerAnnotationCreate {
  client_annotation_id: string
  expected_context_revision: number
  answer_revision: string
  start_utf16: number
  end_utf16: number
  selected_text_hash: string
  preview_text: string
  comment: string
  enqueue: boolean
}

export interface AnswerAnnotationUpdate {
  expected_annotation_revision: number
  expected_context_revision: number
  comment: string
}

export interface AnswerAnnotationBatchDeleteItem {
  annotation_id: string
  expected_annotation_revision: number
}

export interface AnswerAnnotationBatchDelete {
  expected_context_revision: number
  annotations: AnswerAnnotationBatchDeleteItem[]
}

export interface AnswerAnnotationMutation {
  annotation: AnswerAnnotation
  selection: AssistantContextSelection
}
