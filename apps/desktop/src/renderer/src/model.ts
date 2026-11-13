import type { PluginReference, PluginReport } from '../../plugins'
import type { SessionTitleFallback } from './session'
import type { ContextLabelFallback } from './contracts/assistant'
import type { ForegroundMessage } from './contracts/feedback'
// model.ts — domain + UI types for the workstation renderer.
// The "cognitive category" colors and session statuses are load-bearing across
// the conversation, project, task and status surfaces (single source here).

import type { PreferenceLanguage, PreferenceTheme } from '../../preferences'
import type { LiteratureDocumentSource, SessionFileSource } from './contracts/workbench'
import type { ActiveDocument, SubmissionMode, TurnInputItem } from './api'

/**
 * 外观与语言的取值以跨进程契约 `src/preferences.ts` 为单一来源（主进程要读同一份），
 * 这里只保留 renderer 侧既有的公开名，不再重复声明字面量。
 */
export type Theme = PreferenceTheme
export type Lang = PreferenceLanguage

export type Cognitive = 'fact' | 'inference' | 'opinion' | 'experience' | 'tension'
export type EvidencePriority = 'supported' | 'mixed' | 'limited' | 'unverified'

/** PRD 2.1.1: manually edited conversation titles accept at most 150 characters. */
export const SESSION_TITLE_MAX_LENGTH = 150

/** A server-verified exact response span linked to a durable research claim. */
export interface EvidenceAnnotation {
  claim_ref: string
  start_utf16: number
  end_utf16: number
  span_text_hash: string
  priority: EvidencePriority
  source_refs: string[]
  /** Session-stable citation number for each corresponding source reference. */
  citation_nums: number[]
}

/** session-tree leaf run status (drives dots + the desktop pet) */
export type SessionStatus =
  | 'running'
  | 'waiting' // waiting for input (HIL)
  | 'fold' // 待 fold
  | 'abandon'
  | 'failed'
  | 'done'
  | 'dormant'

export interface SessionNode {
  id: string
  title: string
  title_fallback?: SessionTitleFallback
  /** grouping row only; not a serve session and must not open as conversation */
  container?: boolean
  /** A scheduled run is visible immediately but only reopenable after its final snapshot. */
  openable?: boolean
  status: SessionStatus
  /** dot color category */
  tone?: Cognitive
  /** trailing status label / metric */
  meta?: string
  /** 最近 list timestamp, formatted from the registry's durable created_at. */
  timeLabel?: string
  /** Durable Unix creation timestamp used for newest-first ordering. */
  createdAt?: number
  /** Last durable session activity, used to distinguish unread completion from idle. */
  activityAt?: number
  /** 会话所属工作目录（PRD 2.1.8: 用于区分「最近」= 未归入项目 vs 项目下）。 */
  workdir?: string
  /** Explicit product assignment; null/undefined means the Recent section. */
  projectPath?: string | null
  /** Product runtime identity is frozen when the session is created. */
  runtimeId?: string
  /** softPulse seconds; set for running(1.6)/waiting(1.2) */
  pulse?: number
  current?: boolean
  /** the originating task/question this (sub-)session was spawned with */
  prompt?: string
  parentSessionId?: string | null
  worktreePath?: string
  children?: SessionNode[]
}

export interface RecallEntry {
  id: string
  cls: Cognitive
  score: number
  conf: number
  text: string
  provenance: string
  superseded?: boolean
  note?: string
}

export interface MemoryFile {
  id: string
  cls: Cognitive
  confidence: number
  provenance: string
  status: string
  scope: string
  body: string
  supersededFrom?: string
  supersededBy?: string
}

export interface GalleryCard {
  id: string
  name: string
  tag: string
  meta: string
  enabled?: boolean
  detail?: string
  /** Background-run transcript that a capability card can reopen. */
  sessionId?: string
  /** Scheduler-only state; keeps a queued/running action from being submitted twice. */
  busy?: boolean
  prompt?: string
  runHistory?: GalleryRun[]
  scheduleState?: GalleryScheduleState
}

export interface GalleryRun {
  runId: string
  startedAt: string
  ok: boolean
  running?: boolean
  error?: string
  finalText?: string
  sessionId?: string
}

export interface GalleryScheduleState {
  status: string
  schedule: string
  nextRunAt?: string
  activeRunStartedAt?: string
  queuedAt?: string
  lastError?: string
}

export interface FileNode {
  id: string
  name: string
  kind: 'py' | 'md' | 'ppt' | 'pt' | 'png' | 'yml' | 'zip'
  group: string
}

export interface SlashCmd {
  cmd: string
  desc: string
}

export interface ModelOption {
  id: string
  name: string
  provider: string
  group: 'remote' | 'local'
  current?: boolean
}

/**
 * A transcript/file-browser preview may carry an immutable transcript
 * snapshot, or only a project path which is read when the user opens it.
 */
export interface FilePreviewTarget {
  titleFallback?: 'untitledArtifact'
  path: string
  /** Canonical path used only for the Electron reveal/open boundary. */
  absolutePath?: string
  /** Present together when content belongs to a structured session artifact. */
  sessionId?: string
  artifactId?: string
  title?: string
  revisionId?: string
  mediaType?: string
  renderKind?: 'markdown' | 'html' | 'text' | 'json' | 'code' | 'image'
  size?: number
  content?: string
  source?: LiteratureDocumentSource | SessionFileSource
}

export interface RuntimeReadiness {
  ready: boolean
  code?: string
  message?: string
  action?: 'install' | 'login' | 'upgrade' | 'configure' | 'retry' | null
  executable?: string
  version?: string
  authenticated?: boolean
  process_state?: string
  process_generation?: number
  recovery_attempt?: number
  max_recovery_attempts?: number
}

export interface RuntimeCapabilities {
  exact_resume: boolean
  interrupt: boolean
  hil: boolean
  todo: boolean
  artifacts: boolean
  skills: boolean
  attachments: boolean
  collaboration_modes: boolean
  steer: boolean
  web_search: boolean
  subagent_lifecycle: boolean
  subagent_content: boolean
  subagent_control: boolean
  terminate_session: boolean
}

export type RuntimeCapabilityRequirement = 'web_search'

export interface RuntimeSnapshot {
  name: 'codex'
  version?: string
  model_id?: string
  reasoning_effort?: string
  active_reasoning_effort?: string
}

/** A durable file attributable to exactly one product session and Codex item. */
export interface SessionArtifact {
  artifact_id: string
  publication_id?: string | null
  title?: string
  path: string
  absolute_path?: string
  name: string
  media_type?: string
  size?: number
  sha256?: string
  role?: 'intermediate' | 'final' | 'supporting'
  /** Project-relative resource path once the artifact already belongs to the resource library. */
  saved_to?: string
  change?: 'add' | 'update' | 'delete'
  status?: 'available' | 'deleted' | 'failed'
  source_event_id?: string
  /** Monotonic product-event order; never derive ordering from filesystem mtime. */
  source_event_seq?: number
  vendor_turn_id?: string
  vendor_item_id?: string
  updated_at?: number
}

const DELIVERABLE_ARTIFACT_ROLES: ReadonlySet<SessionArtifact['role']> = new Set([
  'final',
  'intermediate',
  'supporting',
])

export function artifactIsDeliverable(artifact: SessionArtifact): boolean {
  return (
    Boolean(artifact.publication_id) &&
    DELIVERABLE_ARTIFACT_ROLES.has(artifact.role) &&
    artifact.status !== 'deleted' &&
    artifact.change !== 'delete'
  )
}

export function artifactIsOutput(artifact: SessionArtifact): boolean {
  return artifactIsDeliverable(artifact) && artifact.role !== 'intermediate'
}

export function overviewArtifacts(
  artifacts: SessionArtifact[],
  workdir?: string
): {
  outputs: SessionArtifact[]
  process: Array<{ path: string; artifacts: SessionArtifact[] }>
} {
  const outputs: SessionArtifact[] = []
  const directories = new Map<string, SessionArtifact[]>()
  const current = new Map<string, SessionArtifact>()
  for (const artifact of artifacts) {
    if (artifact.status === 'deleted' || artifact.change === 'delete') continue
    const key = artifact.absolute_path ?? artifact.path
    const previous = current.get(key)
    if (!previous || artifactIsDeliverable(artifact) || !artifactIsDeliverable(previous))
      current.set(key, artifact)
  }
  for (const artifact of current.values()) {
    if (artifactIsOutput(artifact)) {
      outputs.push(artifact)
      continue
    }
    const directoryPrefix = workdir?.replace(/\\/g, '/').replace(/\/$/, '')
    const absolute = artifact.absolute_path?.replace(/\\/g, '/')
    const displayPath =
      directoryPrefix && absolute?.startsWith(`${directoryPrefix}/`)
        ? absolute.slice(directoryPrefix.length + 1)
        : artifact.path.replace(/\\/g, '/')
    const segments = displayPath.split('/')
    segments.pop()
    const directory = segments.join('/')
    const group = directories.get(directory) ?? []
    group.push(artifact)
    directories.set(directory, group)
  }
  return {
    outputs,
    process: [...directories].map(([path, items]) => ({ path, artifacts: items })),
  }
}

export function submittedReferences(conversation: ConvItem[]): MessageReference[] {
  const references = new Map<string, MessageReference>()
  for (const item of conversation) {
    if (item.kind !== 'user' || item.cancelled) continue
    for (const reference of item.refs ?? []) {
      if (reference.type === 'skill') continue
      const identity = JSON.stringify([
        reference.type,
        reference.kind,
        reference.sourceId ?? reference.path ?? reference.id,
      ])
      references.set(identity, reference)
    }
  }
  return [...references.values()]
}

/**
 * Whether an artifact change means the resource library changed.
 *
 * `saved_to` is populated only once the artifact actually lands under
 * `resources/`. Artifacts that stay in a session's private output dir belong to
 * the conversation view, so invalidating the resource ledger on them reloads the
 * tree for writes that never touch it.
 */
export function artifactBelongsToResources(
  artifact: Pick<SessionArtifact, 'saved_to'> | null | undefined
): boolean {
  return Boolean(artifact?.saved_to)
}

export interface DeliveryCardMember {
  titleFallback?: true
  materialId: string
  title: string
  workspacePath: string
  mediaType: string
  previewAvailable: boolean
  /** Service-issued deep link to this immutable Material revision. */
  previewUrl?: string
  revision: string
  versionId: string
  previousRevision?: string | null
  primary: boolean
}

export interface DeliveryCard {
  labelFallback?: 'current' | 'legacy'
  deliveryId: string
  label: string
  status: string
  previousDeliveryId?: string | null
  members: DeliveryCardMember[]
}

export interface MessageReference {
  selection_source_label?: string | null
  label_fallback?: ContextLabelFallback
  type: string
  id: string
  title: string
  status?: string
  previewUrl?: string
  path?: string
  mediaType?: string
  sha256?: string
  size?: number
  kind?: string
  sourceId?: string
  snapshotId?: string
  sourceRevision?: string | null
  estimate?: SkillDurationEstimate
  anchor?: {
    documentId?: string
    previewText?: string
    locator?: Record<string, unknown>
  } | null
}

export interface ModelRun {
  provider_preset_id?: string
  provider_id: string
  provider_label: string
  model_id: string
  actual_model_id: string
}

export interface TurnOwned {
  /** Stable Codex turn ownership. Turnless legacy rows remain unowned. */
  turnId?: string
  itemId?: string
  /** Durable product-event order used only to rebuild an exact resume timeline. */
  eventSeq?: number
  /** Product-event wall clock, in milliseconds, for durable activity timing. */
  startedAt?: number
  completedAt?: number
}

export type TurnOutcome = 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown'

export interface TurnTiming {
  startedAt: number
  completedAt?: number
}

export interface SkillDurationEstimate {
  lowerSeconds: number
  upperSeconds: number
  sampleCount: number
  confidence: 'low' | 'medium' | 'high'
  basis: 'historical_skill_turns' | 'product_baseline'
  modelId?: string
  reasoningEffort?: string
}

export interface WebSearchAction extends Record<string, unknown> {
  type?: string
  query?: string
  queries?: string[]
  url?: string
  pattern?: string
}

export interface WebSearchResult extends Record<string, unknown> {
  title?: string
  url?: string
}

export type SearchSource = {
  url: string
  title: string
  search_kind: 'web' | 'paper'
  search_id: string
  origin?: 'tool_declared'
}
export type AnswerCoverage = {
  status: 'pending' | 'reviewing' | 'reviewed' | 'partial' | 'unavailable' | 'interrupted'
  unresolved?: string[]
  unread_sources?: number
}

export type AnswerSource =
  | {
      number: number
      kind: 'searched'
      url: string
      title: string
      search_kind: 'web' | 'paper'
      search_id: string
      citation_urls: string[]
      origin?: 'tool_declared'
      evidence?: { origin: string }[]
      reference_labels?: string[]
      occurrences?: { start_utf16: number; end_utf16: number }[]
    }
  | { number: number; kind: 'receipt'; handle: string; citation_urls: string[] }

export interface DisplayCardData {
  component?: PluginReference
  cardId: string
  type: string
  content: Record<string, unknown>
  presentationSource?: 'live' | 'history'
}

export interface ReviewReadyCard {
  batchId: string
  projectId: string
  fileIds: string[]
  reviewIds: string[]
  paths: string[]
}

export type NativeActivityCategory = 'collaboration' | 'media' | 'wait' | 'mode' | 'other'

export interface SubagentProgress {
  itemId: string
  activity: string
  phase: string
  summary?: string
  tool?: {
    name: string
    input?: unknown
    output?: string
    ok?: boolean
    status?: string
  }
  startedAt?: number
  completedAt?: number
  observedAt: number
  eventSeq: number
}

export type ApplicationRequestFailure = {
  key:
    | 'request.historyUnavailable'
    | 'request.timeout'
    | 'request.unavailable'
    | 'request.invalidRecovery'
    | 'request.failed'
    | 'request.authentication'
    | 'request.httpFailure'
    | 'retry.continueUnconfirmed'
  status?: number
  statusText?: string
  diagnostic?: string
}

export type RuntimeStatusMessage = (
  | {
      key:
        | 'runtime.closed'
        | 'context.compacting'
        | 'context.compacted'
        | 'artifactFailure.missing'
        | 'artifactFailure.changed'
        | 'artifactFailure.conflict'
        | 'artifactFailure.invalid'
        | 'resume.reconnected'
        | 'resume.reconnect'
        | 'resume.stopped'
        | 'runtime.retrying'
        | 'runtime.providerRetrying'
        | 'runtime.recovered'
        | 'runtime.recoveryFailed'
        | 'runtime.failed'
        | 'runtime.detected'
        | 'runtime.transportRetrying'
        | 'runtime.transportRecovered'
    }
  | { key: 'runtime.retryingCount' | 'resume.retrying'; attempt: number; maximum: number }
) & { reason?: string | ApplicationRequestFailure }

export type ConvItem = TurnOwned &
  (
    | { kind: 'day'; text: string }
    | { kind: 'prompt'; text: string } // gray task-prompt at the top of a (sub-)session stream
    | { kind: 'reentry'; topic: string; sub: string; rows: [string, string, Cognitive?][] }
    // refs = 该消息携带的 @ 引用资源 (proposal 13: 气泡上以 chips 展示, wire 前缀不进正文)
    | {
        kind: 'user'
        text: string
        rewindAnchor?: number
        steer?: boolean
        steerLabel?: string
        cancelled?: boolean
        refs?: MessageReference[]
      }
    | {
        kind: 'interaction_reply'
        requestId: string
        questions: HilQuestion[]
        answers: Record<string, string>
      }
    // who = 说话人 (team 群聊: 成员名; 空/undefined = lead/单 agent) → 多说话人气泡归属
    | {
        kind: 'agent'
        modelRun?: ModelRun
        text: string
        card?: ConvCard
        who?: string
        evidence?: EvidenceAnnotation[]
        evidenceNotice?: string
        answerSources?: AnswerSource[]
        searchSources?: SearchSource[]
        answerCoverage?: AnswerCoverage
      }
    | { kind: 'delivery'; delivery: DeliveryCard }
    | { kind: 'artifact'; artifact: SessionArtifact }
    | { kind: 'review'; review: ReviewReadyCard }
    | { kind: 'display_card'; card: DisplayCardData }
    | {
        kind: 'thinking'
        text: string
        commentary?: true
        completed?: boolean
        summaryIndex?: number
        reasoningSeq?: number
      }
    | {
        kind: 'status'
        text: string | RuntimeStatusMessage
        tone?: Cognitive
        runtimeNotice?: { diagnostic?: string }
        displayMessage?: ForegroundMessage
        incidentId?: string
        turnBoundary?: true
        bindingSeq?: number
        runtimeAction?: 'retry_session_resume'
        actionSessionId?: string
        hideIcon?: boolean
        /** Terminal live-only outcome that must survive a durable history refresh. */
        retainOnHistoryRefresh?: boolean
      }
    | {
        kind: 'notice'
        text: string
        message?: { key: 'hil.invalidRequest' }
        displayMessage?: ForegroundMessage
        undoable?: boolean
      }
    | {
        kind: 'error'
        applicationFailure?: ApplicationRequestFailure
        failure?: {
          kind:
            | 'capability'
            | 'subscription_limit'
            | 'quota'
            | 'credits'
            | 'rate_limit'
            | 'auth'
            | 'request'
            | 'model_config'
            | 'unavailable'
            | 'overloaded'
            | 'content_policy'
            | 'unknown'
          fallback: 'frame' | 'runtime' | 'raw'
          authentication?: 'account' | 'model'
          automaticRetryAttempts?: number
        }
        title: string
        message: string
        action: string
        turnUnknown?: { reason?: 'timeout' | 'transportLost' | 'processExit' | 'unconfirmed' }
        incidentId?: string
        runtimeAction?: 'confirm_turn_unknown' | 'continue_turn'
        actionSessionId?: string
        actionTurnId?: string
        actionState?: 'idle' | 'submitting' | 'confirmed' | 'failed' | 'outcome_unknown'
        actionError?: ForegroundMessage
        actionErrorMessage?: ApplicationRequestFailure
      }
    | {
        kind: 'tool'
        toolId: string
        name: string
        status: 'running' | 'done' | 'error' | 'cancelled'
        input?: unknown
        result?: string
        exitCode?: number | null
        who?: string
      }
    | {
        kind: 'web_search'
        searchId: string
        status: 'running' | 'done'
        query: string
        action: WebSearchAction
        results: WebSearchResult[]
        resultCount?: number
      }
    | {
        kind: 'paper_search'
        searchId: string
        status: 'running' | 'done'
        query: string
      }
    | {
        kind: 'skill'
        skillId: string
        name: string
        path: string
        status: 'running' | 'done' | 'error'
        nativeStatus: string
        estimate?: SkillDurationEstimate
      }
    | {
        kind: 'native_activity'
        activityId: string
        activityType: string
        category: NativeActivityCategory
        status: 'running' | 'done' | 'error'
        nativeStatus: string
        details: Record<string, unknown>
        progress?: SubagentProgress[]
      }
    | {
        kind: 'hil'
        sessionId?: string
        requestId: string
        hilKind: string
        browserApproval?: {
          tabId: string
          proofId: string
          targetInstanceId: string
          targetGeneration: number
          tabTitle?: string
          tabUrl?: string
          origin: string
          sourceOrigin?: string | null
          destinationUrl?: string
          destinationOrigin?: string
          preparedId?: string
          snapshotId?: string
          elementRef?: string
          browserAction?: 'click' | 'fill' | 'submit'
          element?: { role: string; name: string }
          action: string
          intent: string
          expiresAt: number
        }
        browserHistoryApproval?: {
          proofId: string
          queryDigest: string
          historyRevision: number
          search: string
          offset: number
          limit: number
          intent: string
          expiresAt: number
        }
        toolName?: string
        title?: string
        body?: string
        questions?: HilQuestion[]
        options?: HilOption[]
        allowFreeText?: boolean
        resolved?: string
        resolvedMessage?: HilResolvedMessage
        // question 卡已答内容 (key = q.name/header || question, value = 选项 label 逗号串或自由文本);
        // 存进会话项而非组件 state, 使已答态在卡片上持久可见 (勾选/文本回显)。
        answers?: Record<string, string>
        // permission detail lifted from the POLICY_ASK metadata (native path) so the card can
        // render a clean command block + scope-aware Allow instead of a raw `body` dump.
        command?: string
        toolInput?: Record<string, unknown>
        workdir?: string
        safetyTags?: string[]
        reason?: string
        suggestedPrefix?: string
        prefixKind?: string // shell_prefix | file_dir | web_host
        path?: string
        diff?: string
        networkTarget?: string
        permissions?: Record<string, unknown>
        decisionScope?: string
        requestedAt?: number
        resolvedAt?: number
        hilState?:
          'pending' | 'submitting' | 'failed' | 'resolved' | 'cancelled' | 'stale' | 'unknown'
        lifetime?: 'turn' | 'session'
        blocking?: boolean
        submissionError?: string
        submissionErrorMessage?: HilSubmissionMessage
        submissionRequestFailure?: ApplicationRequestFailure
      }
  )

export function isTurnBoundary(item: ConvItem): boolean {
  return item.kind === 'user' || (item.kind === 'status' && item.turnBoundary === true)
}

/** Explicit application-owned display provenance; raw answers and diagnostics have no descriptor. */
export type HilPermissionScope =
  | { kind: 'once' | 'commandPrefix' | 'directory' | 'site' | 'always' | 'session' | 'edits' }
  | { kind: 'raw'; label: string }

export type HilResolvedMessage =
  | {
      kind:
        | 'stale'
        | 'cancelled'
        | 'handled'
        | 'answered'
        | 'allowedOnce'
        | 'denied'
        | 'browserExpired'
        | 'browserInactive'
        | 'browserUnknown'
        | 'historyExpired'
        | 'historyInactive'
        | 'historyUnknown'
    }
  | { kind: 'allowedScope'; scope: HilPermissionScope }

export type HilSubmissionMessage = 'outcomeUnknown' | 'cancelUnconfirmed' | 'answerUnconfirmed'

export interface HilOption {
  id: string
  label: string
  description?: string
}
export interface HilQuestion {
  presentation?: Record<string, unknown>
  installation?: PluginReport
  component?: PluginReference
  componentData?: Record<string, unknown>
  id?: string
  header?: string
  question: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
  papers?: { id: string; label: string; description?: string }[]
}

/** one conversation thread = main session OR a parallel sub-session, each a real
 *  backend serve session. The UI renders all threads identically. */
/** 一个后台任务的实时生命周期态 (background_task_event 帧驱动)。每 thread(session)一份, 不串。 */
export interface BgTask {
  id: string
  kind: string // bash / task / shell / subagent / workflow / monitor / …
  label: string
  status: string // pending / running / succeeded / failed / cancelled / lost / timed_out
  event: string // started / done / failed / cancelled / lost / timeout / monitor_event
  terminal: boolean
  ts: number
}

export const RELEASED_PLAN_SOURCE = 'released'
export const PLAN_EXECUTION_TIMING_POLICY = 'leaf-execution-v1'

/** 显式计划树或原生平铺快照中的一步；每次快照整列替换。 */
export interface PlanSnapshotUI {
  sequence: number
  turnId?: string
  timestamp: number
  planId?: string
  timingPolicy?: string
  released: boolean
  items: TodoItemUI[]
}

export interface TodoItemUI {
  content: string
  kind?: 'group' | 'step'
  /** 进行时描述: status=in_progress 时展示这个 (CC activeForm), 否则展示 content */
  activeForm?: string | null
  status:
    | 'pending'
    | 'in_progress'
    | 'needs_confirmation'
    | 'completed'
    | 'partial'
    | 'blocked'
    | 'failed'
  /** 稳定 id (被 dependsOn 引用) */
  id?: string
  /** 显式计划层级；缺省为主阶段，不能由标题或 dependsOn 推断。 */
  parent_id?: string | null
  /** 依赖: 必须先完成的 item id; 有未完成依赖的 pending item = blocked (面板暗显+锁标) */
  dependsOn?: string[]
}

// ── context channel 透出 (proposal 64 P3): 通用 channel UI 状态 ──
export interface ContextSurface {
  kind: string // list | constraints | timeline
  label: string
  editable: boolean
  command: string | null // recall | constraints | null
  render_hint: string
  priority: number
}

export interface ContextEntry {
  id: string
  text: string
  cls: string
  confidence: number | null
  provenance: string
  why: string
  entities: string[] // type:id — 渲成可点 chip → 跳全局图
  status: string
  fresh?: boolean // 本帧 delta.added → 淡入高亮
}

export interface ContextChannelState {
  name: string
  surface: ContextSurface | null
  entries: ContextEntry[]
  lastDelta: { added: string[]; superseded: string[]; evicted: string[] } | null
  changedAt: number // 最近一次变更时刻 (ms) — 驱动"上下文已更新"脉冲
}

/** Product surface that owns a live thread's presentation. */
export type ThreadSurface = 'conversation' | 'workbench'

export interface Thread {
  id: string
  title: string
  title_fallback?: SessionTitleFallback
  conversation: ConvItem[]
  /** Workbench threads are transient task sessions and never become the AI panel conversation. */
  surface?: ThreadSurface
  /** real backend serve session id (null until opened/attached) */
  sessionId: string | null
  /** Runtime directory and explicit project assignment frozen with this session. */
  workdir?: string
  projectPath?: string | null
  runtimeId?: string
  runtime?: RuntimeSnapshot
  readiness?: RuntimeReadiness
  capabilities?: RuntimeCapabilities
  /** Frozen server-side connection ownership for the opened session. */
  billingMode?: 'managed' | 'personal'
  lastSeq: number
  /** UI-visible activation state while the native runtime and durable history resume. */
  resumeState?: 'pending' | 'ready' | 'failed'
  resumeServiceInstanceId?: string
  recoveryBlocked?: boolean
  recoveryIncidentId?: string | null
  recoverySourceSeq?: number
  recoveryPending?: boolean
  resumeMessage?:
    | { key: 'resume.codex' | 'resume.agent' | 'resume.reconnect' | 'resume.runtimeSwitchBlocked' }
    | { key: 'resume.runtimeSwitch'; serviceInstanceId: string | null }
    | { key: 'resume.retry'; attempt: number; maximum: number }
  running?: boolean
  activeTurnId?: string | null
  /** The server has accepted an interrupt but has not released turn admission yet. */
  interrupting?: boolean
  /** Native runtime session was explicitly closed; history remains read-only. */
  terminated?: boolean
  readOnly?: boolean
  queuedMessages?: QueuedMessage[]
  /** 本会话的后台任务生命周期态 (background_task_event 帧; StatusStrip 读 activeThread) — 每会话独立 */
  backgroundTasks?: Record<string, BgTask>
  /** 本会话最后一份完整 Codex plan snapshot。 */
  todos?: TodoItemUI[]
  /** `todos` 全量快照所属 turn；null 表示当前没有计划。 */
  todoTurnId?: string | null
  planSnapshots?: PlanSnapshotUI[]
  /** Terminal state is turn-scoped so a later plan cannot inherit an earlier turn failure. */
  turnOutcomes?: Record<string, TurnOutcome>
  /** Durable execution clock projected from product events for each turn. */
  turnTimings?: Record<string, TurnTiming>
  /** Local Service SSE transport is independent from Codex process/thread health. */
  transportState?: 'connecting' | 'live' | 'retrying' | 'offline'
  /** Durable, source-attributed artifacts. Workspace Files remains a separate full-project view. */
  artifacts?: SessionArtifact[]
  /** 本会话的上下文通道 (goal / constraints / memory 等 SSE context:* 帧) — 每会话独立 */
  contextChannels?: Record<string, ContextChannelState>
  /** 本会话的记忆召回结果（memory channel 帧）— 每会话独立。 */
  recall?: RecallEntry[]
  recallQuery?: string | null
  /** breadcrumb / status for the sub-session header */
  status?: SessionStatus
  meta?: string
}

export interface QueuedMessage {
  queuedMessageId: string
  enqueueSeq: number
  operationSeq?: number
  state: 'queued' | 'waiting_resources' | 'submitting' | 'failed' | 'outcome_unknown'
  submissionMode: SubmissionMode
  deadline?: number
  purpose?: string
  text: string
  input: TurnInputItem[]
  assistantReferences: Array<{
    selection_source_label?: string | null
    label_fallback?: ContextLabelFallback
    type?: string
    id?: string
    title?: string
    label?: string
    kind?: string
    ref_id?: string
    status?: string
    state?: string
    source_id?: string
    origin?: string
    anchor?: Record<string, unknown> | null
    surface?: {
      answer_id?: string
      selected_text?: string
      preview_text?: string
      comment?: string
      start_utf16?: number
      end_utf16?: number
      [key: string]: unknown
    }
  }>
  safeErrorCode?: string
  safeErrorDetails?: Record<string, string>
  /** Local outbox rows have not yet been confirmed in the server queue. */
  serverPresent?: boolean
  assistantContextRevision?: number
  activeDocument?: ActiveDocument
  selectedLiteratureIds?: string[]
  /** Uncertainty correlation handle required by the turn confirm endpoint. */
  nativeTurnId?: string
}

export type ConvCard =
  | { type: 'recall'; head: string; meta: string; entries: RecallEntry[] }
  | { type: 'tension'; label: string; text: string }
  | { type: 'judgment'; action: string; judgment: string }
  | { type: 'thread'; head: string; meta: string; text: string; artifact: string }

/** desktop-pet behavioral state, derived from live session status */
export type PetState = 'idle' | 'running' | 'waiting' | 'recall' | 'done' | 'error'
