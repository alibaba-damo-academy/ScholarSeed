import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { posix } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defaultRendererPreferences, sanitizeRendererPreferences } from '../src/preferences.ts'
import { PREFERENCE_FIELDS } from '../src/preference-diagnostics.ts'
import { ONBOARDING_GROUPS } from '../src/onboarding.ts'
import { NOTIFICATION_PATH } from '../src/notifications.ts'
import { DEFAULT_PROJECT_LAYOUT } from '../src/layout.ts'
import type { RendererPreferences } from '../src/preferences.ts'
import type {
  HealthResp,
  FilesResp,
  RuntimePreparation,
  HistoryResult,
  ModelsResp,
  OpenResp,
  ProductEvent,
  ProductHilData,
  ServeSession,
  SkillInfo,
} from '../src/renderer/src/api.ts'
import { SKILLS_PATH, SKILL_SURFACE_CONVERSATION, SKILL_SURFACE_SETTINGS } from '../src/skills.ts'
import { ASSISTANT_CONTEXT_REVISION_CONFLICT } from '../src/renderer/src/contracts/assistant.ts'
import type { AnswerAnnotation, AssistantContextSelection } from '../src/renderer/src/contracts/assistant.ts'
import type {
  OpenDocumentResult,
  PdfRecordSnapshot,
} from '../src/renderer/src/contracts/workbench.ts'
import type { ProjectTreePage } from '../src/renderer/src/features/project/api.ts'
import type { FileEvent } from '../src/renderer/src/contracts/content.ts'
import { PREVIEW_CATALOG } from './catalog.ts'
import {
  PREVIEW_REFERENCE_FILES,
  PREVIEW_REFERENCE_SESSION,
  previewContextReferences,
  previewDraftReferences,
  previewSubmittedReferences,
  previewMixedReferences,
  previewReferenceAnnotations,
} from './references.ts'
import {
  homeSeed,
  homeSessionPage,
  PreviewHomeRead,
  PreviewHomeError,
  PREVIEW_HOME,
} from './home.ts'
import {
  PREVIEW_PROJECT_ID,
  PREVIEW_INSTANCE_PATTERN,
  PREVIEW_RUNTIME_RECONFIGURATION,
} from './constants.ts'
import { PreviewFileError, PREVIEW_FILE_ERROR } from './files.ts'
import type { PreviewFileEntry, PreviewFileContent, PreviewFileSeed } from './files.ts'
import { previewDocumentFormat, loadReviewedRevisions } from './samples.ts'
import { PREVIEW_DOCUMENTS, PREVIEW_PDF_TRANSLATION } from './documents.ts'
import { PreviewVersions, PreviewVersionError, previewVersionRange } from './versions.ts'
import { PreviewReviews } from './reviews.ts'
import { ProjectSimulation, PreviewProjectError } from './project.ts'
import type { PreviewProject } from './project.ts'
import { PreviewDiagnostics, PREVIEW_DIAGNOSTIC_LIMIT } from './diagnostics.ts'
import type { PreviewDiagnosticSnapshot } from './diagnostics.ts'
import { PreviewSearches, PreviewSearchError } from './searches.ts'
import {
  PreviewAccount,
  previewAccountBase,
  PREVIEW_LOGIN,
  PREVIEW_CREDITS,
  isPreviewLoginMode,
} from './accounts.ts'
import type { PreviewLoginMode, PreviewAccountMode } from './accounts.ts'
import { PreviewContent, PreviewContentError, PREVIEW_CONTENT } from './content.ts'
import { previewPdfRegions, PreviewRegionError } from './regions.ts'
import { MCP_SETTINGS_PATH } from '../src/mcp-settings.ts'
import { PreviewMcp, PreviewMcpError, PREVIEW_MCP } from './mcp.ts'
import { PreviewModels, PreviewModelError, PREVIEW_MODELS } from './models.ts'
import { PreviewConfiguration, PreviewConfigurationError } from './configuration.ts'
import { PreviewStorage, PreviewStorageError, PREVIEW_STORAGE } from './storage.ts'
import { PreviewBrowsing, PreviewBrowsingError } from './browsing.ts'
import { PREVIEW_BROWSING } from './listing.ts'
import { PREVIEW_STORAGE_READ } from './directory.ts'
import { PreviewArchive, PreviewArchiveError, PREVIEW_ARCHIVE } from './archive.ts'
import { PreviewRoots, PREVIEW_ROOTS_PATH } from './roots.ts'
import { PreviewDeveloper, PreviewDeveloperError, PREVIEW_DEVELOPER } from './developer.ts'
import {
  PREVIEW_CONVERSATION,
  previewConversationPolicy,
  previewConversationStream,
  previewConversationTool,
} from './conversation.ts'
import type { PreviewConversationPolicy } from './conversation.ts'
import {
  PreviewAuthorization,
  PreviewAuthorizationError,
  PREVIEW_AUTHORIZATION,
} from './authorization.ts'
import type { PreviewAuthorizationKind, PreviewAuthorizationState } from './authorization.ts'
import { PreviewTransport, PreviewTransportError } from './transport.ts'
import {
  PreviewLiterature,
  PreviewLiteratureError,
  PREVIEW_LITERATURE,
  parsePreviewLiteratureQuery,
} from './literature.ts'
import { PreviewBrowser, PreviewBrowserError, PREVIEW_BROWSER } from './browser.ts'
import { BROWSER_ERROR } from '../src/browser.ts'
import { PreviewArtifacts, PreviewArtifactsError } from './artifacts.ts'
import { PREVIEW_ARTIFACTS } from './publications.ts'
import type { PreviewFiles } from './files.ts'

const CONFIG = {
  origin: 'http://preview.local',
  root: '/preview/workspace',
  project: PREVIEW_PROJECT_ID,
  session: 'preview-session',
  componentSession: 'composer-preview',
  sessionDirectoryUnavailable: 'preview_session_directory_unavailable',
  sessionFileUnavailable: 'preview_session_file_unavailable',
  sessionNotFound: { detail: 'session not found', code: 'session_not_found' },
  turnAnswerPrefix: 'turn:',
  projectRequired: 'project_path_required_for_project_scope',
  model: 'preview-model',
  scenes: ['chat', 'tools', 'approval', 'failure', 'streaming', 'empty'],
  tickMs: PREVIEW_CONVERSATION.tickMs,
  heartbeatMs: 15_000,
  maxBodyBytes: 1024 * 1024,
  maxInstances: 100,
  maxUnhandled: 100,
  statusSessionLimit: 200,
  statusQueueLimit: 500,
  analysisIdentityMaxChars: 128,
  pdfRevisionPrefix: 'sha256:',
  instancePattern: PREVIEW_INSTANCE_PATTERN,
  instanceParameter: 'previewInstance',
  instanceHeader: 'x-preview-instance',
} as const

const RESOURCE_LIST_SCOPE = {
  path: '/api/resource/list',
  searchPath: '/api/resource/list/search',
  validationStatus: 422,
  noProjectStatus: 400,
  unknownProjectStatus: 404,
  missing: {
    detail: [{ type: 'missing', loc: ['query', 'project'], msg: 'Field required', input: null }],
  },
  empty: {
    detail: [
      {
        type: 'string_too_short',
        loc: ['query', 'project'],
        msg: 'String should have at least 1 character',
        input: '',
        ctx: { min_length: 1 },
      },
    ],
  },
  noProject: { detail: 'no_project_selected' },
  unknownProject: { detail: 'unknown_project' },
} as const

const FEEDBACK = {
  path: '/api/serve/feedback',
  maxImages: 5,
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesBytes: 40 * 1024 * 1024,
  maxReportBytes: 2 * 1024 * 1024,
  maxBodyBytes: 45 * 1024 * 1024,
  maxDescription: 5000,
  maxReceipts: 100,
  schemaVersion: 1,
} as const

const TRASH = { defaultLimit: 50, minLimit: 1, maxLimit: 200 } as const
const CONTEXT_POLICY = {
  projects: ['auto_project', 'explicit_only'],
  searches: ['disabled', 'academic', 'web'],
  invalidAnnotationRevision: 'preview_annotation_context_revision_invalid',
} as const

interface FeedbackReceipt {
  id: string
  imageCount: number
  imageBytes: number
  recordingReportBytes: number
  rendererDiagnosticsBytes: number
  requestedLogs: boolean
  requestedTrace: boolean
  collectedLogs: false
  collectedTrace: false
}

const PREVIEW_SERVICE_INSTANCE = 'preview-simulation'

const HEALTH: HealthResp = {
  ok: true,
  product: 'ScholarSeed preview simulation',
  serve: false,
  runtime_id: 'codex',
  service_instance_id: PREVIEW_SERVICE_INSTANCE,
  workbench_ready: true,
  runtime: { name: 'codex', version: 'preview', model_id: CONFIG.model },
  readiness: { ready: true, authenticated: true, message: 'Simulated preview, no model execution' },
  capabilities: {
    exact_resume: true,
    interrupt: true,
    hil: true,
    todo: true,
    artifacts: false,
    skills: false,
    attachments: false,
    collaboration_modes: true,
    steer: false,
    web_search: false,
    subagent_lifecycle: false,
    subagent_content: false,
    subagent_control: false,
    terminate_session: true,
  },
}

const MODELS: ModelsResp = {
  service_instance_id: PREVIEW_SERVICE_INSTANCE,
  configured: true,
  current_model: CONFIG.model,
  available_models: [
    {
      key: CONFIG.model,
      label: '模拟模型 · 不调用真实服务',
      source: 'builtin',
      billing: 'api',
      reasoning_efforts: ['medium'],
      image_input: false,
    },
  ],
}

const PREVIEW_SKILLS: readonly SkillInfo[] = [
  {
    name: 'preview-notes',
    description: '隔离的模拟技能，仅供设置界面验证。',
    group: 'user',
    source: 'user',
    enabled: true,
    active: true,
    removable: true,
    toggleable: true,
    dependency_status: 'ready',
    icon: 'doc',
  },
  {
    name: 'preview-required',
    description: '模拟不可禁用的内置技能。',
    group: 'scholarseed',
    source: 'builtin',
    enabled: true,
    active: true,
    removable: false,
    toggleable: false,
    dependency_status: 'ready',
    icon: 'search',
  },
  {
    name: 'preview-unavailable',
    description: '模拟依赖缺失状态，不访问本机依赖。',
    group: 'user',
    source: 'user',
    enabled: true,
    active: false,
    removable: true,
    toggleable: true,
    dependency_status: 'missing',
    unavailable_reason: '模拟依赖尚未准备',
    dependencies: [
      {
        name: 'preview-dependency',
        kind: 'binary',
        status: 'missing',
        message: '只展示依赖缺失，不安装或执行程序。',
      },
    ],
    icon: 'play',
  },
]

interface Session {
  createdAt: number
  modifiedAt: number
  lastAgentReplyAt: number | null
  id: string
  title: string
  project: string | null
  events: ProductEvent[]
  history: HistoryResult
  activeTurn: string | null
  lastTurn: string | null
  lastStatus: OpenResp['last_turn_status']
  pending: ProductHilData[]
  turns: number
  archived: boolean
  pinned: boolean
  streams: Set<ServerResponse>
  timers: Set<ReturnType<typeof setTimeout>>
  submission?: { cancel: () => void }
  context: AssistantContextSelection
  annotations: AnswerAnnotation[]
  transport: PreviewTransport
  artifactEnabled?: boolean
  deliver?: () => void
  authorization?: PreviewAuthorization
}

interface Instance {
  homeRead: PreviewHomeRead
  homeProjectRead: PreviewHomeRead
  id: string
  scene: string
  projects: ProjectSimulation
  sessions: Map<string, Session>
  preparations: Map<string, { receipt: RuntimePreparation; persistDefault: boolean }>
  preferences: RendererPreferences
  settings: Record<string, unknown>
  fileEvents: FileEvent[]
  fileStreams: Map<ServerResponse, string>
  notificationStreams: Set<ServerResponse>
  epoch: string
  unhandled: string[]
  skills: Map<string, { info: SkillInfo; document: string }>
  skillRevision: number
  diagnostics: PreviewDiagnostics
  feedbackReceipts: FeedbackReceipt[]
  feedbackCount: number
  feedbackMode?: 'failed' | 'rate-limited'
  versions: Map<string, PreviewVersions>
  reviews: Map<string, PreviewReviews>
  searches: PreviewSearches
  account?: PreviewAccount
  accountControl: boolean
  login: PreviewLoginMode
  accountOverride?: PreviewAccountMode
  content?: PreviewContent
  mcp: PreviewMcp
  models: PreviewModels
  fileSettings: PreviewConfiguration
  storage: PreviewStorage
  browsing: Map<string, PreviewBrowsing>
  archive?: PreviewArchive
  roots: PreviewRoots
  developer?: PreviewDeveloper
  conversation: PreviewConversationPolicy
  literature: PreviewLiterature
  browser?: PreviewBrowser
  artifacts?: PreviewArtifacts
  artifactDelivery: boolean
}

const PREVIEW_RECOVERY = new Map<string, (instance: Instance) => void>([
  [PREVIEW_HOME.recoveryPath, (instance) => instance.homeProjectRead.recover()],
  [
    PREVIEW_CONTENT.recoveryPath,
    (instance) => {
      if (!instance.content) throw new PreviewContentError(PREVIEW_CONTENT.recoveryUnavailable, 409)
      instance.content.recover()
    },
  ],
  [
    PREVIEW_BROWSING.recoveryPath,
    (instance) => {
      const owner = instance.browsing.get(CONFIG.project)
      if (!owner) throw new PreviewBrowsingError(PREVIEW_BROWSING.recoveryUnavailable, 409)
      owner.recover()
    },
  ],
  [PREVIEW_STORAGE_READ.recoveryPath, (instance) => instance.storage.recoverRead()],
  [
    PREVIEW_ARTIFACTS.recoveryPath,
    (instance) => {
      if (!instance.artifacts)
        throw new PreviewArtifactsError(PREVIEW_ARTIFACTS.recoveryUnavailable, 409)
      instance.artifacts.recover()
    },
  ],
  [
    PREVIEW_ARCHIVE.recoveryPath,
    (instance) => {
      if (!instance.archive) throw new PreviewArchiveError(PREVIEW_ARCHIVE.recoveryUnavailable, 409)
      instance.archive.recoverProjects()
    },
  ],
  [
    PREVIEW_BROWSER.recoveryPath,
    (instance) => {
      if (!instance.browser) throw new PreviewBrowserError(PREVIEW_BROWSER.recoveryUnavailable, 409)
      instance.browser.recoverPolicy()
    },
  ],
])

const PREVIEW_BROWSER_REQUESTS = new Map<
  string,
  (owner: PreviewBrowser, body: unknown, signal: AbortSignal) => Promise<unknown>
>([
  [`${PREVIEW_BROWSER.path}/policy`, (owner, body, signal) => owner.policyRequest(body, signal)],
  [`${PREVIEW_BROWSER.path}/history`, (owner, body, signal) => owner.historyRequest(body, signal)],
  [`${PREVIEW_BROWSER.path}/data`, (owner, body, signal) => owner.dataRequest(body, signal)],
  [`${PREVIEW_BROWSER.path}/command`, (owner, body, signal) => owner.commandRequest(body, signal)],
  [
    `${PREVIEW_BROWSER.path}/snapshot`,
    (owner, body, signal) => {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
        return Promise.resolve({ ok: false, error: BROWSER_ERROR.invalidCommand })
      return owner.snapshotRequest(signal)
    },
  ],
])

function createSession(
  id: string,
  project: string | null,
  policy: PreviewConversationPolicy = { mode: 'chat' },
  createdAt = Date.now() / 1000
): Session {
  return {
    createdAt,
    modifiedAt: createdAt,
    lastAgentReplyAt: null,
    id,
    project,
    title: '设计协作演示',
    events: [],
    history: {
      turns: [],
      todos: [],
      todo_turn_id: null,
      artifacts: [],
      activity_events: [],
      turn_activity: [],
    },
    activeTurn: null,
    lastTurn: null,
    lastStatus: null,
    pending: [],
    turns: 0,
    archived: false,
    pinned: false,
    streams: new Set(),
    timers: new Set(),
    transport: new PreviewTransport(policy),
    annotations: policy.mixedReferences ? previewReferenceAnnotations(id) : [],
    context: {
      session_id: id,
      revision: 0,
      project_policy: 'auto_project',
      search_scope: 'disabled',
      refs: policy.draftReferences
        ? previewDraftReferences()
        : policy.references
          ? previewContextReferences()
          : [],
      updated_at: createdAt,
      capabilities: [],
    },
  }
}

function createInstance(
  id: string,
  scene: string,
  pageId?: string,
  globals?: Pick<Instance, 'login' | 'preferences'>
): Instance {
  const project: PreviewProject = {
    id: CONFIG.project,
    name: '设计协作项目',
    root: `${CONFIG.root}/design`,
    layout: 'managed',
    available: true,
    created_at: Date.now() / 1000,
  }
  const preferences = defaultRendererPreferences('zh')
  if (globals) {
    preferences.theme = globals.preferences.theme
    preferences.language = globals.preferences.language
  }
  preferences.onboarding = {
    seen: Object.fromEntries(ONBOARDING_GROUPS.map((group) => [group, true])),
  }
  const page = PREVIEW_CATALOG.find(
    (page) =>
      page.id === (pageId ?? scene) || (!pageId && page.scenarios.some((item) => item.id === scene))
  )
  const scenario =
    page?.scenarios.find((scenario) => scenario.id === scene) ??
    (page?.id === scene ? page.scenarios[0] : undefined)
  const conversation = previewConversationPolicy(scenario?.simulation?.conversation, scene)
  const archive = scenario?.simulation?.archives
    ? new PreviewArchive(scenario.simulation.archives)
    : undefined
  const archivedProjects: PreviewProject[] =
    archive?.policy.seed === 'sample'
      ? [1, 2].map((index) => ({
          id: randomUUID(),
          name: `模拟归档项目 ${index}`,
          root: `${CONFIG.root}/archived-${randomUUID()}`,
          layout: 'managed',
          available: true,
          created_at: Date.now() / 1000 - index,
          archived_at: Date.now() / 1000,
        }))
      : []
  const home = scenario?.home ? homeSeed(project, scenario.home) : undefined
  const fileSeed: PreviewFileSeed =
    scenario?.simulation?.browsing?.seed === 'empty' ? 'empty' : home ? 'example' : 'reviewed'
  const projects = new ProjectSimulation(
    CONFIG.root,
    home?.projects ?? (scene === 'empty' ? [] : [project, ...archivedProjects]),
    scenario?.simulation?.projectCreation,
    fileSeed
  )
  const browsing = new Map(
    projects
      .all()
      .map(
        (project) =>
          [
            project.id,
            new PreviewBrowsing(
              projects.files(project.id),
              project.id === CONFIG.project ? scenario?.simulation?.browsing : undefined
            ),
          ] as const
      )
  )
  const versions = new Map(
    projects
      .all()
      .map((project) => [
        project.id,
        new PreviewVersions(
          projects.files(project.id),
          scenario?.simulation?.versionHistory === 'sample-change' ? loadReviewedRevisions() : []
        ),
      ])
  )
  const reviews = new Map(
    projects.all().map((project) => {
      const owner = versions.get(project.id)!
      const reviews = new PreviewReviews(owner, {
        failOnce: scenario?.simulation?.reviewBatch === 'fail-once',
      })
      if (scenario?.simulation?.reviewBatch) {
        const batch = reviews.create({
          session_id: CONFIG.session,
          turn_id: randomUUID(),
          changes: loadReviewedRevisions(),
        })
        if (scenario.simulation.reviewBatch === 'conflict') {
          for (const member of batch.members)
            projects
              .files(project.id)
              .write(member.path, reviews.content(batch.id, member.file_id, 'base').bytes)
        }
      }
      return [project.id, reviews] as const
    })
  )
  if (page?.target) {
    preferences.lastLocation = { ...page.target }
    if (page.target.target?.kind === 'document')
      preferences.projectLayouts = {
        ...preferences.projectLayouts,
        [project.id]: { ...DEFAULT_PROJECT_LAYOUT, open: true },
      }
    if (page.target.view === 'resource') preferences.lastLocation.projectId = project.id
    if (page.target.view === 'conversation') {
      preferences.lastLocation.projectId = project.id
      preferences.lastLocation.sessionProjectId = project.id
      preferences.lastLocation.sessionId = CONFIG.session
    }
  }
  if (conversation.draftReferences && preferences.lastLocation) {
    preferences.lastLocation = {
      ...preferences.lastLocation,
      view: 'resource',
      projectId: project.id,
      sessionProjectId: project.id,
      sessionId: CONFIG.session,
      aiPanelOpen: true,
      aiPanelCover: true,
    }
  }
  const sessions =
    home || scene === 'empty'
      ? new Map<string, Session>()
      : new Map([[CONFIG.session, createSession(CONFIG.session, project.root, conversation)]])
  if (scenario?.simulation?.reviewBatch) {
    const session = sessions.get(CONFIG.session)!
    const batch = reviews.get(project.id)!.list().items[0]
    session.lastTurn = batch.turn_id
    session.lastStatus = 'completed'
    session.turns = 1
    session.history.turns.push({
      kind: 'text',
      role: 'assistant',
      phase: 'final_answer',
      text: '模拟文档变更已就绪；从审查卡片查看并处理，不代表真实模型执行。',
      turn_id: batch.turn_id,
      item_id: randomUUID(),
    })
    session.history.turn_activity.push({
      turn_id: batch.turn_id,
      started_at: session.createdAt,
      completed_at: session.createdAt,
      outcome: 'completed',
    })
    publish(session, 'review_ready', {
      batch_id: batch.id,
      project_id: project.id,
      file_ids: batch.members.map((member) => member.file_id),
      review_ids: batch.members.map((member) => member.review_id),
      paths: batch.members.map((member) => member.path),
    }, batch.id)
  }
  if (conversation.mixedReferences) {
    const origin = createSession(PREVIEW_REFERENCE_SESSION, project.root)
    origin.title = '模拟研究背景与实验设计'
    origin.history.turns.push({
      kind: 'text',
      role: 'assistant',
      text: '这是被引用的模拟原对话，可通过返回导航回到混合场景。',
      turn_id: 'preview-origin-turn',
      item_id: 'preview-origin-answer',
    })
    sessions.set(origin.id, origin)
    const mixed = sessions.get(CONFIG.session)!
    mixed.lastTurn = 'preview-context-turn'
    mixed.lastStatus = 'completed'
    mixed.turns = 1
    const refs = previewSubmittedReferences(mixed.context.refs, mixed.lastTurn).map(
      (reference) => ({
        type: reference.type,
        id: reference.id,
        title: reference.title,
        kind: reference.kind,
        source_id: reference.sourceId,
        snapshot_id: reference.snapshotId,
        anchor: reference.anchor
          ? {
              document_id: reference.anchor.documentId,
              preview_text: reference.anchor.previewText,
              locator: reference.anchor.locator,
            }
          : null,
      })
    )
    mixed.history.turns.push(
      {
        kind: 'text',
        role: 'assistant',
        text: '需要比较实验条件与样本规模。应保留结果的适用范围。',
        turn_id: mixed.lastTurn,
        item_id: 'preview-context-answer',
      },
      ...(!conversation.draftReferences
        ? [
            {
              kind: 'user' as const,
              role: 'user' as const,
              text: '请结合划词、注释、图片和文件，参考原对话，用 research 技能整理研究结论。',
              turn_id: 'preview-mixed-turn',
              item_id: 'preview-mixed-user',
              refs: [...refs, ...previewMixedReferences()],
            },
          ]
        : [])
    )
  }
  for (const task of home?.tasks ?? []) {
    const id = task.index === 0 ? CONFIG.session : CONFIG.session + '-' + (task.index + 1)
    const session = createSession(id, task.project, conversation, task.created_at)
    session.title = task.title
    sessions.set(id, session)
  }
  const artifactPolicy = scenario?.simulation?.artifacts
  if (conversation.authorization) {
    for (const session of sessions.values())
      seedAuthorization(
        session,
        conversation.authorization,
        conversation.authorizationKind
      )
  }
  const artifacts = artifactPolicy ? new PreviewArtifacts(artifactPolicy) : undefined
  if (artifacts) {
    for (const session of sessions.values()) session.artifactEnabled = true
    if (artifactPolicy?.seed === 'sample') {
      for (let index = 0; index < PREVIEW_ARTIFACTS.sampleSessions; index += 1) {
        const session =
          index === 0
            ? sessions.get(CONFIG.session)!
            : createSession(randomUUID(), project.root, conversation)
        session.artifactEnabled = true
        session.title = `${PREVIEW_ARTIFACTS.title} ${index + 1}`
        session.turns = 1
        session.lastTurn = randomUUID()
        session.lastStatus = 'completed'
        session.history.turns.push({
          kind: 'text',
          role: 'assistant',
          phase: 'final_answer',
          text: PREVIEW_ARTIFACTS.seedMessage,
          turn_id: session.lastTurn,
          item_id: randomUUID(),
        })
        session.history.turn_activity.push({
          turn_id: session.lastTurn,
          started_at: Date.now() / 1000,
          completed_at: Date.now() / 1000,
          outcome: 'completed',
        })
        captureArtifacts(artifacts, session, projects.files(project.id))
        publish(session, 'turn_completed', { stop_reason: 'completed' })
        sessions.set(session.id, session)
      }
    }
  }
  if (archive?.policy.seed === 'sample') {
    for (const [index, root] of [project.root, archivedProjects[0].root].entries()) {
      const session = createSession(randomUUID(), root)
      session.title = `模拟归档任务 ${index + 1}`
      session.archived = true
      session.turns = 1
      session.lastTurn = randomUUID()
      session.lastStatus = 'completed'
      session.history.turns.push(
        {
          kind: 'text',
          role: 'user',
          text: '受审模拟归档任务内容',
          turn_id: session.lastTurn,
          item_id: randomUUID(),
        },
        {
          kind: 'text',
          role: 'assistant',
          phase: 'final_answer',
          text: '这是模拟归档记录，不代表真实模型执行。',
          turn_id: session.lastTurn,
          item_id: randomUUID(),
        }
      )
      session.history.turns.push({
        kind: 'tool',
        tool: 'read_file',
        input: { path: 'readme.md' },
        output: '受审模拟工具记录，没有执行真实工具。',
        status: 'done',
        ok: true,
        turn_id: session.lastTurn,
        item_id: randomUUID(),
      })
      sessions.set(session.id, session)
    }
  }
  const roots = new PreviewRoots({
    workspace: () => [CONFIG.root, ...projects.all().map((project) => project.root)],
    session: () =>
      [...sessions.values()].map(
        (session) => catalogSession(session).runtime_workdir || catalogSession(session).workdir
      ),
    external: () => projects.all().map((project) => project.root),
  })
  if (page?.launch?.kind === 'components')
    sessions.set(CONFIG.componentSession, createSession(CONFIG.componentSession, project.root))
  let content: PreviewContent | undefined
  if (scenario?.simulation?.contentRead) {
    const target = page?.target?.target
    if (target?.kind !== 'document' || target.source.kind !== 'project')
      throw new Error('Preview content policy requires a project document target')
    const projectId = target.source.project ?? page?.target?.projectId
    const owner = projects.all().find((project) => project.id === projectId)
    if (!owner) throw new Error('Preview content policy requires an existing project')
    const file = projects.files(owner.id).fileInfo(target.source.path)
    if (file.kind !== 'file') throw new Error('Preview content policy requires an existing file')
    content = new PreviewContent(
      { project: owner.id, identity: file.identity },
      scenario.simulation.contentRead.mode
    )
  }
  return {
    id,
    scene,
    preparations: new Map(),
    projects,
    versions,
    reviews,
    archive,
    roots,
    conversation,
    artifacts,
    browsing,
    homeRead: new PreviewHomeRead(scenario?.home?.read),
    homeProjectRead: new PreviewHomeRead(scenario?.home?.projectRead),
    artifactDelivery: Boolean(artifactPolicy?.publishOnCompletion),
    browser: scenario?.simulation?.browser
      ? new PreviewBrowser(scenario.simulation.browser)
      : undefined,
    mcp: new PreviewMcp(scenario?.simulation?.mcp),
    models: new PreviewModels(scenario?.simulation?.modelProfiles),
    fileSettings: new PreviewConfiguration(scenario?.simulation?.fileSettings),
    storage: new PreviewStorage(CONFIG.root, scenario?.simulation?.storage),
    developer: scenario?.simulation?.developer
      ? new PreviewDeveloper(scenario.simulation.developer)
      : undefined,
    literature: new PreviewLiterature({
      currentProjectId: CONFIG.project,
      projects: () => projects.all(),
      pdf: projects.all().some((project) => project.id === CONFIG.project)
        ? projects
            .files(CONFIG.project)
            .manifest()
            .find((entry) => entry.path === 'sample.pdf')
        : undefined,
      policy: scenario?.simulation?.literature,
    }),
    content,
    searches: new PreviewSearches({
      literature: scenario?.simulation?.literatureSearch === 'results',
    }),
    accountControl: true,
    login: globals?.login ?? 'ready',
    accountOverride: scenario?.simulation?.account,
    account: new PreviewAccount(id, scenario?.simulation?.account ?? globals?.login ?? 'ready'),
    sessions,
    preferences,
    settings: {
      'permission-mode': { mode: 'safe_auto', modes: ['ask', 'safe_auto', 'bypassPermissions'] },
      workflow: { enabled: true },
      'auto-review': { enabled: true },
    },
    fileEvents: [],
    fileStreams: new Map(),
    notificationStreams: new Set(),
    epoch: randomUUID(),
    unhandled: [],
    skills: new Map(
      (scene === 'empty' ? [] : PREVIEW_SKILLS).map((info) => [
        info.name,
        {
          info: { ...info, path: `${CONFIG.root}/skills/${info.name}` },
          document: `# ${info.name}\n\n## 模拟技能\n\n仅验证技能设置的列表、详情与本实例状态，不会执行工具或读取用户文件。\n`,
        },
      ])
    ),
    skillRevision: 0,
    diagnostics: new PreviewDiagnostics(),
    feedbackReceipts: [],
    feedbackCount: 0,
    feedbackMode: scenario?.simulation?.feedback,
  }
}

function selectionFailure(scene: string, pageId?: string) {
  const page = pageId
    ? PREVIEW_CATALOG.find((page) => page.id === pageId)
    : PREVIEW_CATALOG.find(
        (page) => page.id === scene || page.scenarios.some((item) => item.id === scene)
      )
  if (pageId && !page) return { status: 400, body: { code: 'preview_unknown_page', pageId, scene } }
  if (!page && !(CONFIG.scenes as readonly string[]).includes(scene))
    return { status: 400, body: { code: 'preview_unknown_scene', pageId: pageId ?? null, scene } }
  if (page && !page.target && !page.host)
    return {
      status: 501,
      body: { code: 'preview_surface_unavailable', pageId: page.id, scene, simulated: true },
    }
  if (pageId && page && scene !== page.id && !page.scenarios.some((item) => item.id === scene))
    return { status: 400, body: { code: 'preview_scene_page_mismatch', pageId, scene } }
  return null
}

function snapshot(session: Session): OpenResp {
  return {
    session_id: session.id,
    title: session.title,
    title_fallback: null,
    runtime_id: HEALTH.runtime_id,
    runtime: HEALTH.runtime,
    readiness: HEALTH.readiness,
    capabilities: { ...HEALTH.capabilities, artifacts: Boolean(session.artifactEnabled) },
    workdir: CONFIG.root,
    runtime_workdir: CONFIG.root,
    project_path: session.project,
    last_seq: session.events.length,
    uncertain_operations: [],
    unknown_outcome: false,
    active_turn_id: session.activeTurn,
    running: session.activeTurn !== null,
    last_turn_id: session.lastTurn,
    last_turn_status: session.lastStatus,
    pending_hil: session.pending,
    todos: session.history.todos,
    todo_turn_id: session.history.todo_turn_id,
    artifacts: session.history.artifacts,
    context_channels: [],
  }
}

function catalogSession(session: Session): ServeSession {
  return {
    ...snapshot(session),
    session_id: session.id,
    title: session.title,
    workdir: CONFIG.root,
    turns: session.turns,
    live: true,
    waiting: session.pending.length > 0,
    archived: session.archived,
    pinned: session.pinned,
    mtime: session.modifiedAt,
    created_at: session.createdAt,
    last_agent_reply_at: session.lastAgentReplyAt,
  }
}

type EventData<
  Type extends ProductEvent['type'],
  Event extends ProductEvent = ProductEvent,
> = Event extends ProductEvent ? (Type extends Event['type'] ? Event['data'] : never) : never

function publish<Type extends ProductEvent['type']>(
  session: Session,
  type: Type,
  data: EventData<Type>,
  item?: string
): void {
  if (type === 'user_message') session.modifiedAt = Date.now() / 1000
  const event = {
    v: 2,
    seq: session.events.length + 1,
    ts: Date.now() / 1000,
    type,
    session_id: session.id,
    ...(session.lastTurn ? { turn_id: session.lastTurn } : {}),
    ...(item ? { item_id: item } : {}),
    data,
  } as ProductEvent
  session.events.push(event)
  session.history.activity_events.push(event)
  for (const stream of session.streams)
    if (!stream.destroyed && !stream.writableEnded)
      stream.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
  if (type === 'message_delta' && session.transport.observeDelta(session.streams.size > 0)) {
    for (const stream of session.streams) stream.end()
    session.streams.clear()
  }
}

function later(session: Session, action: () => void, delayMs: number = CONFIG.tickMs): void {
  const turn = session.activeTurn
  const timer = setTimeout(() => {
    session.timers.delete(timer)
    if (turn && session.activeTurn === turn) action()
  }, delayMs)
  session.timers.add(timer)
}

function requestAuthorization(session: Session): void {
  const question = session.authorization!.current()
  session.pending = [question]
  session.lastStatus = 'waiting'
  publish(session, 'hil_requested', question)
  if (session.activeTurn)
    publish(session, 'session_state', {
      state: 'waiting',
      runtime_id: 'codex',
      active_turn_id: session.activeTurn,
    })
}

function resolveAuthorization(session: Session, requestId: string, body: Record<string, unknown>) {
  const interaction = {
    ...session.authorization!.resolve(requestId, body),
    session_id: session.id,
    turn_id: session.lastTurn!,
  }
  session.pending = []
  publish(session, 'hil_resolved', interaction)
  answer(
    session,
    interaction.answers?.[requestId] === PREVIEW_AUTHORIZATION.allow &&
      interaction.selected_paper_ids?.length
      ? PREVIEW_AUTHORIZATION.authorized
      : session.authorization!.kind === 'review'
        ? PREVIEW_AUTHORIZATION.reviewRejected
        : PREVIEW_AUTHORIZATION.rejected
  )
  return interaction
}

function seedAuthorization(
  session: Session,
  state: PreviewAuthorizationState,
  kind: PreviewAuthorizationKind = 'precise'
): void {
  session.authorization = new PreviewAuthorization(session.id, kind)
  session.title = session.authorization.policy.title
  session.turns = 1
  session.activeTurn = randomUUID()
  session.lastTurn = session.activeTurn
  session.lastStatus = 'running'
  session.history.turns.push({
    kind: 'user',
    role: 'user',
    text: session.authorization.policy.prompt,
    turn_id: session.lastTurn,
    item_id: randomUUID(),
    refs: [],
  })
  session.history.turn_activity.push({ turn_id: session.lastTurn, started_at: Date.now() / 1000 })
  appendAnswer(session, PREVIEW_AUTHORIZATION.introduction)
  publish(session, 'display_card', {
    card_id: session.authorization.cardId,
    type: PREVIEW_AUTHORIZATION.cardType,
    content: session.authorization.result(),
  })
  requestAuthorization(session)
  if (state !== 'pending') {
    const question = session.authorization.current()
    resolveAuthorization(session, question.request_id, {
      answers: {
        [question.request_id]:
          state === 'authorized' ? PREVIEW_AUTHORIZATION.allow : PREVIEW_AUTHORIZATION.deny,
      },
    })
  }
}

function clearTimers(session: Session): void {
  for (const timer of session.timers) clearTimeout(timer)
  session.timers.clear()
}

function waitSubmission(session: Session, response: ServerResponse): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (accepted: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      session.timers.delete(timer)
      response.off('close', cancel)
      if (session.submission === submission) session.submission = undefined
      resolve(accepted)
    }
    const cancel = (): void => settle(false)
    const submission = { cancel }
    const timer = setTimeout(() => settle(true), PREVIEW_CONVERSATION.submissionDelayMs)
    session.submission = submission
    session.timers.add(timer)
    response.once('close', cancel)
    if (response.destroyed) cancel()
  })
}

function sessionOutputFiles(session: Session, offset = 0): FilesResp {
  const artifacts = session.history.artifacts.map(artifact => ({ ...artifact }))
  const items = artifacts.filter(artifact => artifact.status === 'available').map(artifact => ({
    name: artifact.path, dir: false, size: artifact.size ?? 0, updated_at: artifact.updated_at, artifact,
  }))
  return {
    root: CONFIG.root, path: '', crumbs: [], items: items.slice(offset), total: items.length, offset,
    project_path: null, artifacts, literature: [], has_files: items.length > 0,
  }
}

function captureArtifacts(owner: PreviewArtifacts, session: Session, files: PreviewFiles): void {
  if (!session.lastTurn) return
  const candidates = PREVIEW_ARTIFACTS.sample.map((sample) => ({
    file: files.read(sample.path),
    role: sample.role,
  }))
  for (const candidate of candidates) {
    const artifact = owner.publish(session.id, session.lastTurn, candidate.file, candidate.role)
    if (session.history.artifacts.some((existing) => existing.artifact_id === artifact.artifact_id))
      continue
    artifact.source_event_seq = session.events.length + 1
    artifact.source_event_id = randomUUID()
    session.history.artifacts.push(artifact)
    publish(session, 'artifact_changed', { op: 'upsert', artifact })
  }
}

function finish(session: Session, outcome: 'completed' | 'failed' | 'interrupted', interruptionReason?: string): void {
  if (!session.activeTurn) return
  clearTimers(session)
  if (outcome === 'completed' && session.deliver) {
    try {
      session.deliver()
    } catch (error) {
      console.error('[preview-artifacts]', error)
      publish(session, 'artifact_failed', {
        declaration_id: session.lastTurn!,
        code: PREVIEW_ARTIFACTS.publishFailed,
      })
      outcome = 'failed'
    }
  }
  session.lastStatus = outcome
  session.modifiedAt = Date.now() / 1000
  if (outcome === 'interrupted') {
    for (const item of session.history.turns)
      if (item.turn_id === session.lastTurn && item.kind === 'tool' && item.status === 'pending')
        item.status = 'cancelled'
  }
  const activity = session.history.turn_activity.at(-1)
  if (activity) {
    activity.completed_at = Date.now() / 1000
    activity.outcome = outcome
  }
  if (outcome === 'failed')
    publish(session, 'turn_failed', {
      code: 'preview_simulated_failure',
      message: '模拟失败：请使用重试入口。',
      retryable: true,
    })
  else if (outcome === 'interrupted') publish(session, 'turn_interrupted', interruptionReason ? { reason: interruptionReason } : {})
  else publish(session, 'turn_completed', { stop_reason: 'completed' })
  const submission = session.events.find(
    (event) => event.type === 'user_message' && event.turn_id === session.lastTurn
  )
  if (submission?.type === 'user_message')
    publish(session, 'message_removed', {
      queued_message_id: submission.data.client_turn_id,
      reason: outcome === 'interrupted' ? 'cancelled' : 'completed',
    })
  session.activeTurn = null
  publish(session, 'session_state', {
    state: outcome === 'completed' ? 'idle' : outcome,
    runtime_id: 'codex',
  })
}

function appendAnswer(session: Session, text: string): void {
  session.lastAgentReplyAt = Date.now() / 1000
  session.modifiedAt = session.lastAgentReplyAt
  const item = `answer-${session.turns}`
  const existing = session.history.turns.find(
    (turn) => turn.item_id === item && turn.turn_id === session.lastTurn
  )
  const cumulative = (existing?.text ?? '') + text
  if (existing) existing.text = cumulative
  else
    session.history.turns.push({
      kind: 'text',
      role: 'assistant',
      phase: 'final_answer',
      text: cumulative,
      turn_id: session.lastTurn!,
      item_id: item,
    })
  publish(session, 'message_delta', { delta: cumulative, phase: 'final_answer' }, item)
}

function answer(session: Session, text: string): void {
  appendAnswer(session, text)
  finish(session, 'completed')
}

function startTurn(instance: Instance, session: Session, body: Record<string, unknown>): void {
  const scene = instance.conversation.mode
  session.artifactEnabled = Boolean(instance.artifacts)
  session.deliver =
    instance.artifacts && instance.artifactDelivery
      ? () => {
          const project = instance.projects
            .all()
            .find((project) => project.root === session.project)
          if (project && instance.artifacts)
            captureArtifacts(instance.artifacts, session, instance.projects.files(project.id))
        }
      : undefined
  session.turns += 1
  session.activeTurn = `turn-${randomUUID()}`
  session.lastTurn = session.activeTurn
  session.lastStatus = 'running'
  const text = Array.isArray(body.input)
    ? body.input.map((item: { text?: string }) => item.text ?? '').join('\n')
    : ''
  const userItem =
    typeof body.client_user_message_id === 'string'
      ? body.client_user_message_id
      : `user-${session.turns}`
  const refs = previewSubmittedReferences(session.context.refs, session.activeTurn).map(
    (reference) => ({
      type: reference.type,
      id: reference.id,
      title: reference.title,
      kind: reference.kind,
      source_id: reference.sourceId,
      snapshot_id: reference.snapshotId,
      anchor: reference.anchor
        ? {
            document_id: reference.anchor.documentId,
            preview_text: reference.anchor.previewText,
            locator: reference.anchor.locator,
          }
        : null,
    })
  )
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item.type === 'skill')
        refs.push({
          type: 'skill',
          id: item.name,
          title: item.name,
          kind: undefined,
          source_id: undefined,
          snapshot_id: session.activeTurn,
          anchor: null,
        })
    }
  }
  session.history.turns.push({
    kind: 'user',
    role: 'user',
    text,
    turn_id: session.activeTurn,
    item_id: userItem,
    refs,
  })
  session.history.turn_activity.push({ turn_id: session.activeTurn, started_at: Date.now() / 1000 })
  publish(
    session,
    'user_message',
    { text, refs, client_turn_id: userItem, binding: 'bound', origin: 'turn' },
    userItem
  )
  if (instance.conversation.draftReferences)
    session.context = {
      ...session.context,
      refs: session.context.refs.filter((reference) => reference.retention !== 'next_turn'),
      revision: session.context.revision + 1,
    }
  publish(session, 'session_state', {
    state: 'running',
    runtime_id: 'codex',
    active_turn_id: session.activeTurn,
  })
  later(session, () => {
    const reasoning = PREVIEW_CONVERSATION.reasoning
    session.history.turns.push({
      kind: 'thinking',
      text: reasoning,
      turn_id: session.lastTurn!,
      item_id: `reason-${session.turns}`,
    })
    publish(session, 'reasoning_delta', { delta: reasoning }, `reason-${session.turns}`)
    publish(session, 'reasoning_completed', {}, `reason-${session.turns}`)
    if (scene === 'approval') {
      const hil: ProductHilData = {
        request_id: `approval-${randomUUID()}`,
        kind: 'command',
        tool_name: 'shell',
        title: '模拟工具审批',
        command: 'echo preview',
        cwd: CONFIG.root,
        body: '仅演示审批交互，不会执行命令。',
        requested_at: Date.now() / 1000,
        options: [
          { id: 'y', label: '允许一次' },
          { id: 'n', label: '拒绝' },
        ],
      }
      session.pending = [hil]
      session.lastStatus = 'waiting'
      publish(session, 'hil_requested', hil, `tool-${session.turns}`)
      publish(session, 'session_state', {
        state: 'waiting',
        runtime_id: 'codex',
        active_turn_id: session.activeTurn!,
      })
    } else if (scene === 'failure' && session.turns === 1) finish(session, 'failed')
    else if (scene === 'tools') {
      const execution = previewConversationTool(instance.conversation)
      const tool = `tool-${session.turns}`
      const historyTool = {
        kind: 'tool',
        tool: execution.name,
        input: execution.input,
        output: null as string | null,
        status: 'pending' as 'pending' | 'done' | 'error',
        ok: true,
        turn_id: session.activeTurn!,
        item_id: tool,
      }
      session.history.turns.push(historyTool)
      publish(
        session,
        'tool_started',
        { tool_id: tool, name: execution.name, input: execution.input },
        tool
      )
      execution.chunks.forEach((delta, index) =>
        later(
          session,
          () => {
            historyTool.output = (historyTool.output ?? '') + delta
            publish(session, 'tool_output_delta', { tool_id: tool, delta }, tool)
            if (index !== execution.chunks.length - 1) return
            historyTool.status = execution.success ? 'done' : 'error'
            historyTool.ok = execution.success
            publish(
              session,
              'tool_completed',
              {
                tool_id: tool,
                name: execution.name,
                output: historyTool.output,
                success: execution.success,
              },
              tool
            )
            answer(session, execution.answer)
          },
          execution.chunks.length === 1
            ? execution.runMs
            : Math.max(CONFIG.tickMs, (index * execution.runMs) / (execution.chunks.length - 1))
        )
      )
    } else if (scene === 'streaming' || scene === 'failure') {
      const { chunks: parts, intervalMs } = previewConversationStream(instance.conversation)
      parts.forEach((delta, index) =>
        later(
          session,
          () => {
            appendAnswer(session, delta)
            if (index === parts.length - 1) {
              finish(session, 'completed')
            }
          },
          (index + 1) * intervalMs
        )
      )
    } else answer(session, PREVIEW_CONVERSATION.answer)
  })
}

function projectBrowsing(instance: Instance, project: string): PreviewBrowsing {
  let owner = instance.browsing.get(project)
  if (!owner) {
    owner = new PreviewBrowsing(instance.projects.files(project))
    instance.browsing.set(project, owner)
  }
  return owner
}

function closeInstance(instance: Instance): void {
  instance.preparations.clear()
  instance.homeRead.dispose()
  instance.homeProjectRead.dispose()
  for (const owner of instance.browsing.values()) owner.dispose()
  instance.artifacts?.dispose()
  instance.browser?.dispose()
  instance.literature.dispose()
  instance.mcp.dispose()
  instance.models.dispose()
  instance.developer?.dispose()
  instance.fileSettings.dispose()
  instance.storage.dispose()
  instance.archive?.dispose()
  instance.roots.dispose()
  instance.account?.dispose()
  instance.content?.dispose()
  instance.projects.dispose()
  for (const stream of instance.fileStreams.keys()) stream.end()
  instance.fileStreams.clear()
  for (const stream of instance.notificationStreams) stream.end()
  instance.notificationStreams.clear()
  for (const session of instance.sessions.values()) {
    session.submission?.cancel()
    clearTimers(session)
    session.transport.dispose()
    for (const stream of session.streams) stream.end()
    session.streams.clear()
  }
}

async function archiveResponse(
  response: ServerResponse,
  action: (signal: AbortSignal) => Promise<void>
): Promise<void> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  response.once('close', abort)
  try {
    await action(controller.signal)
  } catch (error) {
    if (!response.destroyed) throw error
  } finally {
    response.off('close', abort)
  }
}

function json(response: ServerResponse, payload: unknown, status = 200): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-preview-simulation': 'true',
  })
  response.end(JSON.stringify(payload))
}

function unimplemented(
  instance: Instance,
  method: string,
  path: string,
  response: ServerResponse
): void {
  const unhandled = `${method} ${path}`
  if (!instance.unhandled.includes(unhandled))
    instance.unhandled = [...instance.unhandled.slice(-(CONFIG.maxUnhandled - 1)), unhandled]
  json(
    response,
    {
      code: 'preview_unimplemented',
      detail: `No preview handler for ${method} ${path}`,
      simulated: true,
    },
    501
  )
}

async function readBytes(
  request: IncomingMessage,
  limit: number = CONFIG.maxBodyBytes
): Promise<Buffer> {
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length
    if (bytes > limit) {
      request.resume()
      throw new Error('preview_body_too_large')
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function feedbackReceipt(request: IncomingMessage): Promise<Omit<FeedbackReceipt, 'id'>> {
  const contentType = request.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('multipart/form-data;'))
    throw new Error('multipart/form-data required')
  const bytes = await readBytes(request, FEEDBACK.maxBodyBytes)
  let form: FormData
  try {
    form = await new Response(new Uint8Array(bytes).buffer, {
      headers: { 'content-type': contentType },
    }).formData()
  } catch {
    throw new Error('invalid multipart form')
  }
  const text = (key: string): string => {
    const entries = form.getAll(key)
    const entry = entries[entries.length - 1] ?? ''
    if (typeof entry !== 'string') throw new Error(`${key} must be text`)
    return entry
  }
  const boolean = (key: string): boolean => {
    const value = text(key).toLowerCase()
    if (['true', '1', 'on', 'yes', 't', 'y'].includes(value)) return true
    if (['', 'false', '0', 'off', 'no', 'f', 'n'].includes(value)) return false
    throw new Error(`${key} must be a boolean`)
  }
  const images = form.getAll('images')
  if (images.length > FEEDBACK.maxImages) throw new Error('at most 5 images')
  let imageBytes = 0
  let imageCount = 0
  for (const image of images) {
    if (typeof image === 'string') throw new Error('images must be files')
    if (image.size === 0) continue
    if (imageBytes + image.size > FEEDBACK.maxImagesBytes)
      throw new Error('images exceed 40MB in total')
    if (image.size > FEEDBACK.maxImageBytes) throw new Error(`image ${image.name} exceeds 20MB`)
    imageBytes += image.size
    imageCount++
  }
  const report = async (key: string, label: string): Promise<number> => {
    const entries = form.getAll(key)
    const entry = entries[entries.length - 1]
    if (entry === undefined) return 0
    if (typeof entry === 'string') throw new Error(`${label} must be a file`)
    if (entry.size > FEEDBACK.maxReportBytes)
      throw new Error(`${label} exceed${key === 'recording_report' ? 's' : ''} 2MB`)
    if (entry.type.split(';', 1)[0].trim().toLowerCase() !== 'application/json')
      throw new Error(`${label} must be application/json`)
    let payload: unknown
    try {
      payload = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(await entry.arrayBuffer())
      )
    } catch {
      throw new Error(`${label} must contain valid JSON`)
    }
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      !('schemaVersion' in payload) ||
      payload.schemaVersion !== FEEDBACK.schemaVersion
    )
      throw new Error(`${label} schema is unsupported`)
    return entry.size
  }
  const recordingReportBytes = await report('recording_report', 'recording report')
  const rendererDiagnosticsBytes = await report('renderer_diagnostics', 'renderer diagnostics')
  const description = text('description').trim()
  if (!description) throw new Error('description is required')
  if (Array.from(description).length > FEEDBACK.maxDescription)
    throw new Error('description exceeds 5000 characters')
  text('email')
  text('session_id')
  return {
    imageCount,
    imageBytes,
    recordingReportBytes,
    rendererDiagnosticsBytes,
    requestedLogs: boolean('include_logs'),
    requestedTrace: boolean('include_trace'),
    collectedLogs: false,
    collectedTrace: false,
  }
}

async function readPayload(request: IncomingMessage): Promise<unknown> {
  const bytes = await readBytes(request)
  return bytes.length ? JSON.parse(bytes.toString('utf8')) : {}
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readPayload(request)
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('preview_invalid_body')
  return body as Record<string, unknown>
}

function resourceNode(entry: PreviewFileEntry, versions?: PreviewVersions, children = 0) {
  const capability = entry.kind === 'file' ? versions?.capability(entry.path) : undefined
  return {
    path: entry.path,
    name: entry.name,
    kind: entry.kind,
    count: entry.kind === 'dir' ? children : null,
    updated_at: entry.kind === 'file' ? entry.mtime : null,
    source: 'created',
    file_type: entry.kind === 'dir' ? 'dir' : posix.extname(entry.name).slice(1).toUpperCase(),
    origin: 'local',
    ...(capability
      ? {
          version: {
            management_state: capability.management_state,
            drifted: capability.drifted,
            snapshot_state: capability.snapshot_state,
            pending_origin: capability.pending?.origin ?? null,
            needs_review: Boolean(capability.pending?.review),
          },
        }
      : {}),
  }
}

function publishFile(
  instance: Instance,
  project: string,
  kind: FileEvent['kind'],
  path: string,
  previous: string | null = null
): void {
  const event: FileEvent = {
    epoch: instance.epoch,
    seq: instance.fileEvents.length + 1,
    project_id: project,
    root: 'resources',
    kind,
    path,
    source: 'product',
    previous_path: previous,
  }
  instance.fileEvents.push(event)
  for (const [stream, selected] of instance.fileStreams)
    if (selected === project) stream.write(`data: ${JSON.stringify(event)}\n\n`)
}

function documentProjection(
  entry: PreviewFileContent,
  project: string,
  versions?: PreviewVersions
): OpenDocumentResult {
  const format = previewDocumentFormat(entry.path, entry.bytes)
  const versioning = versions?.capability(entry.path) ?? null
  return {
    path: entry.path,
    project_id: project,
    viewer: format.viewer,
    processor: format.processor,
    content_kind: format.contentKind,
    media_type: format.mediaType,
    size: entry.size,
    revision: entry.revision,
    content_url: `/api/workbench/content?${new URLSearchParams({ project, path: entry.path })}`,
    asset_id: entry.identity,
    source_state: 'available',
    versioning,
    capabilities: {
      can_preview: format.viewer !== 'unsupported',
      can_edit: format.editable,
      can_select: format.selectable,
      can_annotate: false,
      can_save: format.editable,
      can_version: versioning?.can_version ?? false,
      can_diff: versioning?.can_diff ?? false,
      pending: format.pending,
    },
  }
}

export function createPreviewService() {
  const instances = new Map<string, Instance>()
  let disposed = false
  function state(instance: Instance) {
    const diagnostics: PreviewDiagnosticSnapshot = {
      requests: instance.diagnostics.snapshot(),
      events: [...instance.sessions.values()]
        .flatMap((session) => session.events)
        .sort((left, right) => left.ts - right.ts)
        .slice(-PREVIEW_DIAGNOSTIC_LIMIT)
        .map((event) => ({
          session_id: event.session_id,
          seq: event.seq,
          type: event.type,
          ...(event.turn_id ? { turn_id: event.turn_id } : {}),
        })),
      files: instance.fileEvents.slice(-PREVIEW_DIAGNOSTIC_LIMIT).map((event) => ({
        epoch: event.epoch,
        seq: event.seq,
        project_id: event.project_id,
        kind: event.kind,
        path: event.path,
        previous_path: event.previous_path,
      })),
    }
    return {
      instance: instance.id,
      generation: instance.epoch,
      scene: instance.scene,
      simulated: true,
      preferences: instance.preferences,
      login: instance.login,
      storage: instance.storage.bootstrap(),
      ...(instance.account ? { account: instance.account.bootstrap() } : {}),
      projects: instance.projects.all(),
      sessions: [...instance.sessions.values()].map(catalogSession),
      unhandled: instance.unhandled,
      diagnostics: { ...diagnostics, roots: instance.roots.counts() },
      feedback: { receipts: instance.feedbackReceipts.map((receipt) => ({ ...receipt })) },
    }
  }
  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    next: (error?: unknown) => void
  ): Promise<void> {
    const url = new URL(request.url ?? '/', CONFIG.origin)
    const path = url.pathname
    if (!path.startsWith('/api/') && !path.startsWith('/__preview/')) {
      next()
      return
    }
    if (disposed) {
      json(response, { code: 'preview_disposed' }, 503)
      return
    }
    let referer: URL | null = null
    try {
      referer = request.headers.referer ? new URL(request.headers.referer) : null
    } catch {
      json(response, { code: 'preview_invalid_referer' }, 400)
      return
    }
    const header = request.headers[CONFIG.instanceHeader]
    const id =
      url.searchParams.get(CONFIG.instanceParameter) ??
      (typeof header === 'string' ? header : null) ??
      referer?.searchParams.get(CONFIG.instanceParameter) ??
      'default'
    if (!CONFIG.instancePattern.test(id)) {
      json(response, { code: 'preview_invalid_instance' }, 400)
      return
    }
    if (path === '/__preview/state' && request.method === 'DELETE') {
      const explicit =
        url.searchParams.get(CONFIG.instanceParameter) ??
        (typeof header === 'string' ? header : null)
      if (!explicit) {
        json(response, { code: 'preview_instance_required' }, 400)
        return
      }
      const existing = instances.get(explicit)
      if (!existing) {
        json(response, { code: 'preview_instance_not_found' }, 404)
        return
      }
      closeInstance(existing)
      instances.delete(explicit)
      json(response, { ok: true })
      return
    }
    if (!instances.has(id)) {
      if (instances.size >= CONFIG.maxInstances) {
        json(response, { code: 'preview_instance_limit' }, 429)
        return
      }
      const scene =
        url.searchParams.get('scene') ?? referer?.searchParams.get('scene') ?? 'page-home'
      const pageId = url.searchParams.get('page') ?? referer?.searchParams.get('page') ?? undefined
      const failure = selectionFailure(scene, pageId)
      if (failure) {
        json(response, failure.body, failure.status)
        return
      }
      instances.set(id, createInstance(id, scene, pageId))
    }
    let instance = instances.get(id)!
    const method = request.method ?? 'GET'
    const diagnostics = instance.diagnostics
    const started = performance.now()
    let recorded = false
    const record = (outcome: 'completed' | 'aborted'): void => {
      if (recorded) return
      recorded = true
      diagnostics.record({
        method,
        path,
        status: response.statusCode,
        durationMs: Math.max(0, performance.now() - started),
        outcome,
      })
    }
    response.once('finish', () => record('completed'))
    response.once('close', () => record(response.writableFinished ? 'completed' : 'aborted'))
    if (path === FEEDBACK.path && method === 'POST') {
      if (Number(request.headers['content-length']) > FEEDBACK.maxBodyBytes) {
        request.resume()
        json(response, { detail: 'preview_feedback_body_too_large' }, 413)
        return
      }
      let receipt: Omit<FeedbackReceipt, 'id'>
      try {
        receipt = await feedbackReceipt(request)
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'invalid multipart form'
        if (!request.readableEnded) request.resume()
        json(
          response,
          {
            detail:
              detail === 'preview_body_too_large' ? 'preview_feedback_body_too_large' : detail,
          },
          detail === 'preview_body_too_large' ? 413 : 422
        )
        return
      }
      if (instances.get(id) !== instance) {
        json(response, { detail: 'preview_instance_reset' }, 409)
        return
      }
      if (instance.feedbackMode) {
        json(
          response,
          {
            detail:
              instance.feedbackMode === 'rate-limited'
                ? 'feedback rate limited'
                : 'feedback upstream unavailable',
          },
          instance.feedbackMode === 'rate-limited' ? 429 : 502
        )
        return
      }
      const receiptId = `preview-feedback:${instance.epoch}:${++instance.feedbackCount}`
      instance.feedbackReceipts = [
        ...instance.feedbackReceipts.slice(-(FEEDBACK.maxReceipts - 1)),
        { ...receipt, id: receiptId },
      ]
      json(response, { ok: true, id: receiptId, bundle_bytes: 0, simulated: true })
      return
    }
    if (
      method === 'POST' &&
      [`${SKILLS_PATH}/upload`, `${SKILLS_PATH}/create`, `${SKILLS_PATH}/import/github`].includes(
        path
      )
    ) {
      request.resume()
      unimplemented(instance, method, path, response)
      return
    }
    if (path === MCP_SETTINGS_PATH) {
      if (method !== 'GET' && method !== 'PUT') {
        request.resume()
        unimplemented(instance, method, path, response)
        return
      }
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      response.once('close', abort)
      try {
        let body: unknown
        if (method === 'PUT') {
          let bytes: Uint8Array
          try {
            bytes = await readBytes(request, PREVIEW_MCP.maxBytes)
          } catch (error) {
            if (error instanceof Error && error.message === 'preview_body_too_large')
              throw new PreviewMcpError(PREVIEW_MCP.tooLarge, 413)
            throw error
          }
          try {
            body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
          } catch {
            throw new PreviewMcpError(PREVIEW_MCP.invalid, 422)
          }
        }
        const value =
          method === 'GET'
            ? await instance.mcp.read(controller.signal)
            : await instance.mcp.replace(body, controller.signal)
        if (!response.destroyed) json(response, value)
      } catch (error) {
        if (response.destroyed) return
        if (error instanceof PreviewMcpError) {
          json(response, { detail: error.message }, error.status)
          return
        }
        throw error
      } finally {
        response.off('close', abort)
      }
      return
    }
    if (path === PREVIEW_MODELS.providersPath && method === 'GET') {
      json(response, instance.models.providers())
      return
    }
    if (path === PREVIEW_MODELS.profilesPath && method === 'GET') {
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      response.once('close', abort)
      try {
        const document = await instance.models.read(controller.signal)
        if (!response.destroyed) json(response, document)
      } catch (error) {
        if (response.destroyed) return
        if (error instanceof PreviewModelError) {
          json(response, { detail: error.message }, error.status)
          return
        }
        throw error
      } finally {
        response.off('close', abort)
      }
      return
    }
    if (
      path === PREVIEW_MODELS.profilesPath ||
      path.startsWith(`${PREVIEW_MODELS.profilesPath}/`)
    ) {
      const operation = path.slice(PREVIEW_MODELS.profilesPath.length + 1)
      const profileId = operation.split('/')[0]
      const unknownProfile =
        profileId &&
        !['models', 'probe'].includes(profileId) &&
        !instance.models.hasProfile(profileId)
      request.resume()
      json(
        response,
        { detail: unknownProfile ? PREVIEW_MODELS.notFound : PREVIEW_MODELS.readOnly },
        unknownProfile ? 404 : 501
      )
      return
    }
    const send = (payload: unknown, status = 200): void => json(response, payload, status)
    const browserRequest = PREVIEW_BROWSER_REQUESTS.get(path)
    if (instance.browser && method === 'POST' && browserRequest) {
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      response.once('close', abort)
      try {
        const browserBody = await readPayload(request)
        if (instances.get(id) !== instance) {
          send({ detail: 'preview_instance_reset' }, 409)
          return
        }
        const payload = await browserRequest(instance.browser, browserBody, controller.signal)
        if (instances.get(id) !== instance) {
          send({ detail: 'preview_instance_reset' }, 409)
          return
        }
        if (!response.destroyed) send(payload)
      } finally {
        response.off('close', abort)
      }
      return
    }
    const annotationContext = path.match(
      /^\/api\/assistant\/sessions\/([^/]+)\/annotations\/([^/]+)\/context$/
    )
    const rawBody =
      path === '/api/workbench/content' && method === 'PUT' ? await readBytes(request) : undefined
    const body =
      rawBody === undefined &&
      (['POST', 'PUT', 'PATCH'].includes(method) ||
        (method === 'DELETE' &&
          (annotationContext !== null || /^\/api\/assistant\/sessions\/[^/]+\/annotations$/.test(path) ||
            /^\/api\/resource\/versions\/[^/]+$/.test(path))))
        ? await readBody(request)
        : {}
    if (instances.get(id) !== instance) {
      send({ detail: 'preview_instance_reset' }, 409)
      return
    }
    const developerMember = path.match(/^\/api\/account\/api-keys\/([^/]+)(?:\/(rotate))?$/)
    const developerRoute = path === PREVIEW_DEVELOPER.keysPath || developerMember
    const credentialRoute =
      path === PREVIEW_DEVELOPER.ensurePath || path === PREVIEW_DEVELOPER.refreshPath
    if (instance.developer && (developerRoute || credentialRoute)) {
      const authorization =
        typeof request.headers.authorization === 'string'
          ? request.headers.authorization
          : undefined
      if (developerRoute && !instance.account?.authorizes(authorization)) {
        send({ code: 'unauthorized' }, 401)
        return
      }
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      response.once('close', abort)
      try {
        let payload: unknown
        if (credentialRoute && method === 'POST') {
          if (Object.keys(body).length !== 0) {
            send({ code: PREVIEW_DEVELOPER.invalidRequest }, 422)
            return
          }
          instance.developer.ensure()
          payload =
            path === PREVIEW_DEVELOPER.ensurePath
              ? { ok: true, ready: false }
              : { ok: true, issued: false, aligned: 0 }
        } else if (path === PREVIEW_DEVELOPER.keysPath && method === 'GET')
          payload = await instance.developer.list(controller.signal)
        else if (path === PREVIEW_DEVELOPER.keysPath && method === 'POST')
          payload = await instance.developer.create(body, controller.signal)
        else if (developerMember && !developerMember[2] && method === 'DELETE')
          payload = await instance.developer.revoke(
            decodeURIComponent(developerMember[1]),
            controller.signal
          )
        else if (
          developerMember?.[2] === 'rotate' &&
          method === 'POST' &&
          Object.keys(body).length === 0
        )
          payload = await instance.developer.rotate(
            decodeURIComponent(developerMember[1]),
            controller.signal
          )
        else {
          unimplemented(instance, method, path, response)
          return
        }
        if (!response.destroyed) send(payload)
      } catch (error) {
        if (response.destroyed) return
        if (error instanceof PreviewDeveloperError) {
          send({ code: error.message }, error.status)
          return
        }
        if (error instanceof URIError) {
          send({ code: PREVIEW_DEVELOPER.invalidRequest }, 422)
          return
        }
        throw error
      } finally {
        response.off('close', abort)
      }
      return
    }
    if (path === PREVIEW_ROOTS_PATH && method === 'POST') {
      const ok = instance.roots.update(body)
      send({ ok }, ok ? 200 : 422)
      return
    }
    const versionFile = path.match(/^\/api\/resource\/files\/([^/]+)\/versions$/)
    const versionContent = path.match(
      /^\/api\/resource\/versions\/([^/]+)(?:\/(content|annotations))?$/
    )
    const versionDelete = path.match(/^\/api\/resource\/versions\/([^/]+)\/delete\/preview$/)
    const reviewBatch = path.match(
      /^\/api\/resource\/review-batches(?:\/([^/]+)(?:\/(commit|members\/([^/]+)\/(base|candidate|current)))?)?$/
    )
    const reviewFile = path.match(
      /^\/api\/resource\/files\/([^/]+)\/(pending|review\/conflict|review\/reconcile|review\/([^/]+)\/base)$/
    )
    if (
      path === '/api/resource/capability' ||
      versionFile ||
      versionContent ||
      versionDelete ||
      reviewBatch ||
      reviewFile
    ) {
      const projectId = url.searchParams.get('project')
      const project =
        projectId === 'current'
          ? instance.projects.all()[0]
          : instance.projects.all().find((project) => project.id === projectId)
      if (!project) {
        send(
          {
            error: {
              code: projectId ? 'unknown_project' : 'project_required',
              message: projectId ? 'unknown_project' : 'project_required',
              details: {},
            },
          },
          projectId ? 400 : 422
        )
        return
      }
      let versions = instance.versions.get(project.id)
      if (!versions) {
        versions = new PreviewVersions(instance.projects.files(project.id))
        instance.versions.set(project.id, versions)
      }
      let reviews = instance.reviews.get(project.id)
      if (!reviews) {
        reviews = new PreviewReviews(versions)
        instance.reviews.set(project.id, reviews)
      }
      const key =
        typeof request.headers['idempotency-key'] === 'string'
          ? request.headers['idempotency-key']
          : ''
      const contentResponse = (content: {
        bytes: Uint8Array
        mediaType: string
        revision: string | null
      }) => {
        response.writeHead(200, {
          'Content-Type': content.mediaType,
          'Content-Length': String(content.bytes.length),
          'Cache-Control': 'no-store',
          ...(content.revision ? { 'X-ScholarSeed-Content-Revision': content.revision } : {}),
        })
        response.end(content.bytes)
      }
      if (reviewBatch) {
        const batchId = reviewBatch[1] ? decodeURIComponent(reviewBatch[1]) : null
        if (method === 'GET') {
          if (!batchId)
            send(
              reviews.list({
                state: url.searchParams.get('state') ?? undefined,
                after_batch_id: url.searchParams.get('after_batch_id') ?? undefined,
                ...(url.searchParams.has('limit')
                  ? { limit: Number(url.searchParams.get('limit')) }
                  : {}),
              })
            )
          else if (reviewBatch[3])
            contentResponse(
              reviews.content(batchId, decodeURIComponent(reviewBatch[3]), reviewBatch[4])
            )
          else if (!reviewBatch[2]) send(reviews.batch(batchId))
          else {
            unimplemented(instance, method, path, response)
          }
          return
        }
        if (batchId && reviewBatch[2] === 'commit' && method === 'POST') {
          const before = reviews.batch(batchId).members.map((member) => ({
            path: member.path,
            fileId: member.file_id,
            state: JSON.stringify([
              versions.pending(member.file_id),
              versions.current(member.file_id).snapshot,
            ]),
          }))
          const result = reviews.commit(batchId, body, key)
          for (const member of before)
            if (
              member.state !==
              JSON.stringify([
                versions.pending(member.fileId),
                versions.current(member.fileId).snapshot,
              ])
            )
              publishFile(instance, project.id, 'modified', member.path)
          send(result)
          return
        }
      }
      if (reviewFile) {
        const fileId = decodeURIComponent(reviewFile[1])
        if (reviewFile[2] === 'pending' && method === 'GET') {
          send({ file_id: fileId, pending: versions.pending(fileId) })
          return
        }
        if (reviewFile[2] === 'review/conflict' && method === 'GET') {
          send(reviews.conflict(fileId))
          return
        }
        if (reviewFile[2] === 'review/reconcile' && method === 'POST') {
          const before = JSON.stringify([
            versions.pending(fileId),
            versions.current(fileId).snapshot,
          ])
          const result = reviews.reconcile(fileId, body, key)
          if (
            before !== JSON.stringify([versions.pending(fileId), versions.current(fileId).snapshot])
          )
            publishFile(instance, project.id, 'modified', versions.current(fileId).snapshot.path)
          send(result)
          return
        }
        if (reviewFile[3] && method === 'GET') {
          const review = versions.pending(fileId)?.review
          if (!review || review.id !== decodeURIComponent(reviewFile[3]))
            throw new PreviewVersionError(404, 'review_not_found')
          contentResponse(versions.readSnapshot(review.base))
          return
        }
      }
      if (path === '/api/resource/capability' && method === 'GET') {
        const filePath = url.searchParams.get('path')
        if (!filePath) {
          send({ error: { code: 'path_required', message: 'path_required', details: {} } }, 422)
          return
        }
        send(versions.capability(filePath))
        return
      }
      if (versionFile) {
        const fileId = decodeURIComponent(versionFile[1])
        if (method === 'GET') {
          send(
            versions.history(fileId, {
              ...(url.searchParams.has('cursor')
                ? { cursor: Number(url.searchParams.get('cursor')) }
                : {}),
              ...(url.searchParams.has('limit')
                ? { limit: Number(url.searchParams.get('limit')) }
                : {}),
              q: url.searchParams.get('q') ?? undefined,
              origin: url.searchParams.get('origin') ?? undefined,
              order: url.searchParams.get('order') ?? undefined,
            })
          )
          return
        }
        if (method === 'POST') {
          send(
            versions.seal(
              fileId,
              body,
              typeof request.headers['idempotency-key'] === 'string'
                ? request.headers['idempotency-key']
                : ''
            )
          )
          return
        }
      }
      if (versionDelete && method === 'POST') {
        send(versions.previewDelete(decodeURIComponent(versionDelete[1])))
        return
      }
      if (versionContent && !versionContent[2] && method === 'DELETE') {
        send(versions.deleteVersion(decodeURIComponent(versionContent[1]), body, key))
        return
      }
      if (
        versionContent &&
        (method === 'GET' || (versionContent[2] === 'content' && method === 'HEAD'))
      ) {
        const content = versions.content(decodeURIComponent(versionContent[1]))
        if (!versionContent[2]) {
          send(content.version)
          return
        }
        if (versionContent[2] === 'annotations')
          throw new PreviewVersionError(404, 'annotations_not_available')
        const headers: Record<string, string> = {
          'Content-Type': content.mediaType,
          'Content-Length': String(content.bytes.length),
          'Accept-Ranges': 'bytes',
          'Content-Disposition': 'inline',
        }
        if (method === 'HEAD') {
          response.writeHead(200, headers)
          response.end()
          return
        }
        if (request.headers.range) {
          const range = previewVersionRange(request.headers.range, content.bytes.length)
          if (!range) {
            response.writeHead(416, {
              'Content-Range': `bytes */${content.bytes.length}`,
              'Accept-Ranges': 'bytes',
            })
            response.end()
            return
          }
          const [start, end] = range
          response.writeHead(206, {
            ...headers,
            'Content-Range': `bytes ${start}-${end}/${content.bytes.length}`,
            'Content-Length': String(end - start + 1),
          })
          response.end(content.bytes.subarray(start, end + 1))
          return
        }
        response.writeHead(200, headers)
        response.end(content.bytes)
        return
      }
    }
    const recover = PREVIEW_RECOVERY.get(path)
    if (recover && method === 'POST') {
      recover(instance)
      send({ preferences: instance.preferences })
      return
    }
    if (path === '/__preview/catalog' && method === 'GET') {
      send(PREVIEW_CATALOG)
      return
    }
    if (path === PREVIEW_LOGIN.path) {
      if (method !== 'POST') {
        send({ code: 'preview_method_not_allowed' }, 405)
        return
      }
      if (!isPreviewLoginMode(body.mode) || Object.keys(body).some((key) => key !== 'mode')) {
        send({ code: 'preview_invalid_login_mode' }, 400)
        return
      }
      instance.login = body.mode
      const effective = instance.accountOverride ?? instance.login
      if (instance.account?.bootstrap().mode !== effective) {
        instance.account?.dispose()
        instance.account = new PreviewAccount(id, effective)
      }
      send(state(instance))
      return
    }
    if (path === '/__preview/state') {
      const requestedScene = url.searchParams.get('scene')
      if (requestedScene) {
        const failure = selectionFailure(
          requestedScene,
          url.searchParams.get('page') ?? referer?.searchParams.get('page') ?? undefined
        )
        if (failure) {
          send(failure.body, failure.status)
          return
        }
      }
      if (method === 'POST') {
        if (
          !body.preferences ||
          typeof body.preferences !== 'object' ||
          Array.isArray(body.preferences)
        ) {
          send({ code: 'preview_invalid_preferences' }, 400)
          return
        }
        const fields = body.changedFields
        if (fields === undefined) {
          instance.preferences = sanitizeRendererPreferences(body.preferences)
        } else {
          if (!Array.isArray(fields) || new Set(fields).size !== fields.length || fields.some(field => !PREFERENCE_FIELDS.includes(field))) {
            send({ code: 'preview_invalid_preferences' }, 400)
            return
          }
          const values = body.preferences as Record<string, unknown>
          if (fields.some(field => !Object.hasOwn(values, field))) {
            send({ code: 'preview_invalid_preferences' }, 400)
            return
          }
          const patch = Object.fromEntries(fields.map(field => [field, values[field]]))
          instance.preferences = sanitizeRendererPreferences({ ...instance.preferences, ...patch })
        }
      } else if (method !== 'GET') {
        send({ code: 'preview_method_not_allowed' }, 405)
        return
      }
      send(state(instance))
      return
    }
    if (path === '/__preview/reset' && method === 'POST') {
      const scene = typeof body.scene === 'string' ? body.scene : 'chat'
      const pageId = typeof body.pageId === 'string' ? body.pageId : undefined
      const failure = selectionFailure(scene, pageId)
      if (failure) {
        send(failure.body, failure.status)
        return
      }
      closeInstance(instance)
      instance = createInstance(id, scene, pageId, instance)
      instances.set(id, instance)
      send(state(instance))
      return
    }
    if (path === NOTIFICATION_PATH && method === 'GET') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-preview-simulation': 'true',
      })
      response.write(`event: ready\ndata: ${JSON.stringify({ instance_id: instance.epoch, changes: [] })}\n\n`)
      instance.notificationStreams.add(response)
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), CONFIG.heartbeatMs)
      response.once('close', () => {
        clearInterval(heartbeat)
        instance.notificationStreams.delete(response)
      })
      return
    }
    if (path === '/api/healthz' && method === 'GET') {
      send({
        ...HEALTH,
        capabilities: { ...HEALTH.capabilities, artifacts: Boolean(instance.artifacts) },
        service_instance_id: `preview-${id}`,
      })
      return
    }
    if (path === '/api/healthz/backend' && method === 'GET') {
      send({
        ok: HEALTH.ok,
        product: HEALTH.product,
        serve: HEALTH.serve,
        runtime_id: HEALTH.runtime_id,
        service_instance_id: `preview-${id}`,
        workbench_ready: HEALTH.workbench_ready,
      })
      return
    }
    if (path === PREVIEW_RUNTIME_RECONFIGURATION.preparationPath && method === 'POST') {
      if (typeof body.request_id !== 'string' || typeof body.model_id !== 'string' || typeof body.service_instance_id !== 'string' || (body.persist_default !== undefined && typeof body.persist_default !== 'boolean')) {
        send({ error: PREVIEW_RUNTIME_RECONFIGURATION.invalid }, 422)
        return
      }
      if (!PREVIEW_RUNTIME_RECONFIGURATION.requestPattern.test(body.request_id)) {
        send({ error: PREVIEW_RUNTIME_RECONFIGURATION.invalid }, 409)
        return
      }
      if (body.service_instance_id !== `preview-${id}`) {
        send({ error: PREVIEW_RUNTIME_RECONFIGURATION.instanceChanged }, 409)
        return
      }
      const persistDefault = body.persist_default === true
      const existing = instance.preparations.get(body.request_id)
      if (existing && (existing.receipt.model_id !== body.model_id || existing.persistDefault !== persistDefault)) {
        send({ error: PREVIEW_RUNTIME_RECONFIGURATION.stale }, 409)
        return
      }
      const valid = MODELS.available_models.some(model => model.key === body.model_id && !model.disabled)
      const receipt: RuntimePreparation = existing?.receipt ?? {
        request_id: body.request_id, session_id: null, model_id: body.model_id,
        service_instance_id: body.service_instance_id,
        state: valid ? PREVIEW_RUNTIME_RECONFIGURATION.preparationState.applied : PREVIEW_RUNTIME_RECONFIGURATION.preparationState.rejected,
        error: valid ? '' : PREVIEW_RUNTIME_RECONFIGURATION.preparationInvalid,
      }
      instance.preparations.set(body.request_id, { receipt, persistDefault })
      send(receipt)
      return
    }
    if (path.startsWith(PREVIEW_RUNTIME_RECONFIGURATION.preparationPath + '/') && method === 'GET') {
      const requestId = decodeURIComponent(path.slice(PREVIEW_RUNTIME_RECONFIGURATION.preparationPath.length + 1))
      const receipt = instance.preparations.get(requestId)?.receipt
      send(receipt ?? { error: PREVIEW_RUNTIME_RECONFIGURATION.notFound }, receipt ? 200 : 404)
      return
    }
    if (path === PREVIEW_RUNTIME_RECONFIGURATION.path && method === 'GET') {
      send({ state: null, service_instance_id: `preview-${id}` })
      return
    }
    if (path === '/api/resource/agent-origin' && method === 'GET') {
      const projectId = url.searchParams.get('project')
      const resourcePath = url.searchParams.get('path')
      if (!projectId || !resourcePath) {
        send({ detail: 'project and path are required' }, 422)
        return
      }
      const project =
        projectId === 'current'
          ? instance.projects.all()[0]
          : instance.projects.all().find((project) => project.id === projectId)
      if (!project) {
        send(
          { detail: projectId === 'current' ? 'no_project_selected' : 'unknown_project' },
          projectId === 'current' ? 400 : 404
        )
        return
      }
      send(null)
      return
    }
    if (path === '/api/content/trash' && method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? TRASH.defaultLimit)
      if (!Number.isSafeInteger(limit) || limit < TRASH.minLimit || limit > TRASH.maxLimit) {
        send({ detail: 'invalid_limit' }, 422)
        return
      }
      const projectId = url.searchParams.get('project')
      const project =
        projectId && projectId !== 'current'
          ? instance.projects.all().find((project) => project.id === projectId)
          : instance.projects.all()[0]
      if (!project) {
        send(
          {
            detail:
              projectId && projectId !== 'current' ? 'unknown_project' : 'no_project_selected',
          },
          400
        )
        return
      }
      send({ project_id: project.id, entries: [] })
      return
    }
    if (path === '/api/account/me' && method === 'GET' && instance.account) {
      const result = await instance.account.profile(
        typeof request.headers.authorization === 'string'
          ? request.headers.authorization
          : undefined
      )
      send(result.body, result.status)
      return
    }
    if (path === PREVIEW_CREDITS.path && method === 'GET' && instance.account) {
      const result = await instance.account.credits(
        typeof request.headers.authorization === 'string'
          ? request.headers.authorization
          : undefined
      )
      send(result.body, result.status)
      return
    }
    if (path === '/api/auth/status' && method === 'GET') {
      const base = previewAccountBase(
        `http://${request.headers.host}`,
        instance.account?.bootstrap()
      )
      send({
        enabled: false,
        bootstrap: false,
        mode: 'preview',
        methods: [],
        account_base_url: base,
      })
      return
    }
    if (path === '/api/auth/me' && method === 'GET') {
      send(
        instance.accountControl && instance.account
          ? instance.account.identity()
          : {
              user_id: 'preview-designer',
              email: 'preview@example.invalid',
              auth: false,
              display_name: '设计预览',
            }
      )
      return
    }
    if (path === `${SKILLS_PATH}/marketplace/labels` && method === 'GET') {
      send({ labels: [] })
      return
    }
    if (path === `${SKILLS_PATH}/marketplace` && method === 'GET') {
      send({ items: [], nextCursor: null, registry: 'https://preview.invalid' })
      return
    }
    if (path === SKILLS_PATH && method === 'GET') {
      const surface = url.searchParams.get('surface')
      if (
        surface !== null &&
        surface !== SKILL_SURFACE_CONVERSATION &&
        surface !== SKILL_SURFACE_SETTINGS
      ) {
        send({ detail: 'unknown_skill_surface' }, 422)
        return
      }
      send({
        skills: [...instance.skills.values()].map((skill) => skill.info),
        revision: `${instance.epoch}:${instance.skillRevision}`,
        cwd: CONFIG.root,
        errors: [],
      })
      return
    }
    const skillRoute = path.startsWith(`${SKILLS_PATH}/`)
      ? path.slice(SKILLS_PATH.length).match(/^\/([^/]+)(?:\/(document|activate))?$/)
      : null
    if (skillRoute) {
      const name = decodeURIComponent(skillRoute[1])
      const skill = instance.skills.get(name)
      if (!skill) {
        send({ detail: `unknown skill '${name}'` }, 404)
        return
      }
      const operation = skillRoute[2]
      if (operation === 'document' && method === 'GET') {
        send({ name, path: `${skill.info.path}/SKILL.md`, document: skill.document })
        return
      }
      if (operation === 'activate' && (method === 'POST' || method === 'DELETE')) {
        const enabled = method === 'POST'
        if (!enabled && !skill.info.toggleable) {
          send(
            {
              detail: { code: 'immutable_skill', message: '产品必需技能始终开启，不可关闭', name },
            },
            409
          )
          return
        }
        skill.info = {
          ...skill.info,
          enabled,
          active: enabled && skill.info.dependency_status === 'ready',
        }
        instance.skillRevision += 1
        send({ name, active: enabled })
        return
      }
      if (!operation && method === 'DELETE') {
        if (!skill.info.removable) {
          send({ detail: '内置技能不可删除' }, 403)
          return
        }
        instance.skills.delete(name)
        instance.skillRevision += 1
        send({ name, deleted: true })
        return
      }
    }
    if (path === '/api/resource/import-jobs' && method === 'GET') {
      send({ items: [] })
      return
    }
    if (path === '/api/literature/ai/structure' && method === 'POST') {
      const project = instance.projects.all().find(project => project.id === body.project_id)
      const reviewed = PREVIEW_DOCUMENTS.find(document => document.path === PREVIEW_PDF_TRANSLATION.path)!
      if (!project || body.path !== reviewed.path || body.literature_id || body.attachment_id || body.kind !== 'document_translation' ||
          ['asset_id', 'literature_id', 'attachment_id', 'revision'].some(key => body[key] !== undefined && typeof body[key] !== 'string') ||
          typeof body.model_key !== 'string' || ['client_action_id', 'client_attempt_id'].some(key => {
            const identity = body[key]
            return typeof identity !== 'string' || !identity || Array.from(identity).length > CONFIG.analysisIdentityMaxChars
          })) {
        send({ detail: { code: 'pdf_ai_source_invalid', diagnostic: '' } }, 422)
        return
      }
      let file: PreviewFileContent
      try {
        file = instance.projects.files(project.id).read(reviewed.path)
      } catch (error) {
        if (!(error instanceof PreviewFileError)) throw error
        send({ detail: { code: 'pdf_ai_source_invalid', diagnostic: '' } }, 422)
        return
      }
      if ((body.asset_id && body.asset_id !== file.identity) || file.kind !== 'file') {
        send({ detail: { code: 'pdf_ai_source_invalid', diagnostic: '' } }, 422)
        return
      }
      const revision = typeof body.revision === 'string' && body.revision.startsWith(CONFIG.pdfRevisionPrefix)
        ? body.revision.slice(CONFIG.pdfRevisionPrefix.length) : body.revision
      if ((revision && revision !== reviewed.sha256) || file.revision !== CONFIG.pdfRevisionPrefix + reviewed.sha256) {
        send({ detail: { code: 'pdf_ai_source_changed', diagnostic: '' } }, 422)
        return
      }
      const page = body.page === undefined ? PREVIEW_PDF_TRANSLATION.page : body.page
      if (page !== PREVIEW_PDF_TRANSLATION.page) {
        send({ detail: { code: 'pdf_ai_page_out_of_range', diagnostic: '' } }, 422)
        return
      }
      send({ revision: reviewed.sha256, page, structure_version: PREVIEW_PDF_TRANSLATION.structureVersion,
        blocks: PREVIEW_PDF_TRANSLATION.blocks })
      return
    }
    if (path === '/api/literature/searches' && method === 'GET') {
      send(instance.searches.listLiterature())
      return
    }
    if (path === '/api/literature/searches/result-status' && method === 'POST') {
      send(instance.searches.resultStatus(body))
      return
    }
    if (path === '/api/content/projects/recoveries' && method === 'GET') {
      send({ creations: [] })
      return
    }
    if (path === '/api/content/roots' && method === 'GET') {
      const projectId = url.searchParams.get('project')
      const project = projectId
        ? instance.projects.all().find((project) => project.id === projectId)
        : instance.projects.all()[0]
      if (!project) {
        send({ code: 'preview_project_not_found' }, 404)
        return
      }
      send({ roots: [], writableRoots: [project.root] })
      return
    }
    if (path === '/api/content/projects') {
      if (method === 'POST') {
        send({ operation: instance.projects.create(body.name), state: 'queued' }, 202)
        return
      }
      if (method === 'PATCH') {
        send(instance.projects.patch(body))
        return
      }
      if (method === 'GET') {
        const includeArchived = url.searchParams.get('includeArchived') === 'true'
        await archiveResponse(response, async (signal) => {
          if (includeArchived) await instance.archive?.readProjects(signal)
          const outcome = await instance.homeProjectRead.read(signal)
          if (instances.get(id) !== instance || outcome === 'cancelled') {
            send({ detail: 'preview_instance_reset' }, 409)
            return
          }
          if (outcome === 'failed') {
            send({ detail: PREVIEW_HOME.projectReadFailure }, 503)
            return
          }
          const all = instance.projects.all()
          const projects = all
            .filter((project) => includeArchived || project.archived_at == null)
          send({ projects, current: all.some(project => project.id === CONFIG.project) ? CONFIG.project : '', workspaceRoot: CONFIG.root })
        })
        return
      }
    }
    const projectMutation = path.match(/^\/api\/content\/projects\/([^/]+)(?:\/(archive))?$/)
    if (projectMutation && projectMutation[1] !== 'directory') {
      const projectId = decodeURIComponent(projectMutation[1])
      if (projectMutation[2] === 'archive' && method === 'POST') {
        if (typeof body.archived !== 'boolean') {
          send({ detail: 'invalid_archived' }, 422)
          return
        }
        const archived = body.archived
        const previous = instance.projects.validateArchive(projectId, archived)
        await archiveResponse(response, async (signal) => {
          if ((previous.archived_at != null) !== archived) await instance.archive?.write(signal)
          send(instance.projects.archive(projectId, archived))
        })
        return
      }
      if (!projectMutation[2] && method === 'DELETE') {
        send(
          {
            operation: instance.projects.forget(
              projectId,
              () => instance.archive?.write() ?? Promise.resolve()
            ),
            state: 'queued',
          },
          202
        )
        return
      }
    }
    if (path === '/api/content/projects/directory' && method === 'GET') {
      send({ root: instance.projects.directory(url.searchParams.get('name')) })
      return
    }
    const operationRoute = path.match(/^\/api\/content\/operations\/([^/]+)$/)
    if (operationRoute && method === 'GET') {
      send(instance.projects.operation(decodeURIComponent(operationRoute[1])))
      return
    }
    const taskFiles = path === '/api/serve/task-files'
    if ((path === '/api/serve/sessions' || taskFiles) && method === 'GET') {
      if (taskFiles && !url.searchParams.has('project_path')) {
        send({ detail: 'project_path is required' }, 422)
        return
      }
      const scopeKind = taskFiles ? 'project' : url.searchParams.get('scope')
      const rawProject = url.searchParams.get('project_path')?.trim()
      const projectPath = rawProject ? posix.normalize(rawProject) : null
      const projectExists = () => instance.projects.all().some(project => project.root === projectPath)
      if (scopeKind === 'project') {
        if (!taskFiles && !projectPath) {
          send({ detail: CONFIG.projectRequired }, 422)
          return
        }
        if (!projectExists()) {
          send(CONFIG.sessionNotFound, 404)
          return
        }
      }
      const archived = !taskFiles && url.searchParams.get('archived') === 'true'
      await archiveResponse(response, async (signal) => {
        if (
          url.searchParams.get('scope') === 'all' &&
          url.searchParams.get('include_last_agent_reply') === 'true'
        ) {
          const outcome = await instance.homeRead.read(signal)
          if (instances.get(id) !== instance || outcome === 'cancelled') {
            send({ detail: 'preview_instance_reset' }, 409)
            return
          }
          if (outcome === 'failed') {
            send({ detail: PREVIEW_HOME.readFailure }, 503)
            return
          }
        }
        if (scopeKind === 'project')
          await instance.artifacts?.beforeRead('catalog', signal)
        if (instances.get(id) !== instance) {
          send({ detail: 'preview_instance_reset' }, 409)
          return
        }
        if (archived) await instance.archive?.read(false, signal)
        if (scopeKind === 'project' && !projectExists()) {
          send(CONFIG.sessionNotFound, 404)
          return
        }
        const sessions = [...instance.sessions.values()]
          .filter((session) => {
            return (
              (scopeKind !== 'project' || session.project === projectPath) &&
              (scopeKind !== 'unassigned' || session.project === null) &&
              session.archived === archived
            )
          })
          .map(catalogSession)
        const scope = createHash('sha256')
          .update(
            JSON.stringify([
              scopeKind,
              projectPath,
              url.searchParams.get('archived'),
            ])
          )
          .digest('hex')
        let page
        try {
          page = homeSessionPage(
            sessions,
            url.searchParams.get('limit'),
            url.searchParams.get('cursor'),
            instance.epoch + scope
          )
        } catch {
          send({ detail: 'invalid_preview_session_page' }, taskFiles ? 422 : 400)
          return
        }
        if (taskFiles) {
          const entries = []
          for (const entry of page.sessions) {
            try {
              await instance.artifacts?.beforeRead('history', signal)
              if (instances.get(id) !== instance) {
                send({ detail: 'preview_instance_reset' }, 409)
                return
              }
              const session = instance.sessions.get(entry.session_id)
              if (!session) {
                entries.push({ session: entry, files: null })
                continue
              }
              const files = sessionOutputFiles(session)
              if (files.has_files) entries.push({ session: entry, files })
            } catch (error) {
              if (!(error instanceof PreviewArtifactsError) || error.status !== 503) throw error
              entries.push({ session: entry, files: null })
            }
          }
          send({ entries, next_cursor: page.next_cursor })
        } else send(page)
      })
      return
    }
    if (path === '/api/serve/status' && method === 'POST') {
      const queued = body.queued_ids === undefined ? {} : body.queued_ids
      if (!Array.isArray(body.session_ids) || body.session_ids.length > CONFIG.statusSessionLimit ||
          body.session_ids.some(value => typeof value !== 'string') || !queued ||
          typeof queued !== 'object' || Array.isArray(queued) ||
          Object.values(queued).some(value => !Array.isArray(value) || value.some(identity => typeof identity !== 'string'))) {
        send({ detail: 'invalid_session_status_request' }, 422)
        return
      }
      const queuedIds = queued as Record<string, string[]>
      if (Object.values(queuedIds).reduce((total, values) => total + values.length, 0) > CONFIG.statusQueueLimit) {
        send({ error: 'too_many_queue_ids' }, 422)
        return
      }
      send({ sessions: body.session_ids.flatMap(identity => {
        const session = instance.sessions.get(identity)
        if (!session) return []
        const { last_seq: _sequence, ...summary } = catalogSession(session)
        return [{ ...summary, active_turn_id: session.lastTurn, summary_seq: session.events.length, interrupting: false, queued_messages: [],
          acknowledged_queue_ids: (queuedIds[identity] ?? []).filter(message => session.events.some(event =>
            event.type === 'user_message' && event.data.client_turn_id === message)) }]
      }) })
      return
    }
    if (path === '/api/serve/sessions/open' && method === 'POST') {
      const resume = typeof body.resume_session_id === 'string' ? body.resume_session_id : null
      let session = resume ? instance.sessions.get(resume) : undefined
      if (resume && !session) {
        send({ code: 'session_not_found', detail: 'Preview session not found' }, 404)
        return
      }
      if (!session) {
        session = createSession(
          randomUUID(),
          typeof body.project_path === 'string' ? body.project_path : null,
          instance.conversation
        )
        session.artifactEnabled = Boolean(instance.artifacts)
        instance.sessions.set(session.id, session)
      }
      send({ ...snapshot(session), resumed: !!resume })
      return
    }
    const historyMatch = path.match(/^\/api\/serve\/history\/([^/]+)$/)
    const authorizationRoute = path.match(
      /^\/api\/sessions\/([^/]+)\/literature\/(results\/([^/]+)|result-status|authorizations\/([^/]+)\/retry)$/
    )
    if (authorizationRoute) {
      const session = instance.sessions.get(decodeURIComponent(authorizationRoute[1]))
      const owner = session?.authorization
      if (!session || !owner)
        throw new PreviewAuthorizationError(404, 'preview_authorization_not_found')
      if (authorizationRoute[3] && method === 'GET') {
        if (decodeURIComponent(authorizationRoute[3]) !== owner.cardId)
          throw new PreviewAuthorizationError(404, 'preview_result_not_found')
        send(owner.result())
        return
      }
      if (authorizationRoute[2] === 'result-status' && method === 'POST') {
        const papers = owner.result().papers as { id: string }[]
        send({
          items: Object.fromEntries(papers.map((paper) => [paper.id, { library: 'absent' }])),
        })
        return
      }
      if (authorizationRoute[4] && (method === 'GET' || method === 'POST')) {
        const result = owner.retry(decodeURIComponent(authorizationRoute[4]), method === 'GET')
        if (
          method === 'POST' &&
          owner.current().state === 'pending' &&
          !session.pending.some((question) => question.request_id === result.request_id)
        )
          requestAuthorization(session)
        send(result)
        return
      }
    }
    if (historyMatch && method === 'GET') {
      const session = instance.sessions.get(decodeURIComponent(historyMatch[1]))
      if (!session) {
        send({ code: 'session_not_found' }, 404)
        return
      }
      await archiveResponse(response, async (signal) => {
        await instance.artifacts?.beforeRead('history', signal)
        if (instances.get(id) !== instance) {
          send({ detail: 'preview_instance_reset' }, 409)
          return
        }
        if (session?.archived) await instance.archive?.read(true, signal)
        if (instance.sessions.get(session.id) !== session) {
          send({ code: 'session_not_found' }, 404)
          return
        }
        const history =
          session?.archived && instance.archive?.policy.history === 'empty'
            ? createSession(session.id, session.project).history
            : session?.history
        send(history ?? { code: 'session_not_found' }, session ? 200 : 404)
      })
      return
    }
    const sessionMatch = path.match(/^\/api\/serve\/sessions\/([^/]+)(?:\/(.*))?$/)
    if (sessionMatch) {
      const session = instance.sessions.get(decodeURIComponent(sessionMatch[1]))
      if (!session) {
        send({ code: 'session_not_found' }, 404)
        return
      }
      const action = sessionMatch[2] ?? ''
      if (action === PREVIEW_CONVERSATION.toolRecoveryAction && method === 'GET') {
        if (!url.searchParams.has('turn_id')) {
          send({ detail: PREVIEW_CONVERSATION.recoveryTurnRequired }, 422)
          return
        }
        send({ tool_ids: [] })
        return
      }
      if (action === 'prediction' && method === 'POST') {
        if (typeof body.source_turn_id !== 'string' || !body.source_turn_id.trim()) {
          send({ detail: 'source_turn_id is required' }, 422)
          return
        }
        if (session.activeTurn || session.archived || session.lastStatus !== 'completed' || session.lastTurn !== body.source_turn_id) {
          send({ error: PREVIEW_CONVERSATION.predictionUnavailable }, 409)
          return
        }
        send({ source_turn_id: body.source_turn_id, text: null })
        return
      }
      if (action === 'files' && method === 'GET') {
        const offset = Number(url.searchParams.get('offset') ?? 0)
        if (url.searchParams.get('path') || !Number.isSafeInteger(offset) || offset < 0) {
          send({ code: CONFIG.sessionDirectoryUnavailable }, url.searchParams.get('path') ? 404 : 422)
          return
        }
        await archiveResponse(response, async signal => {
          await instance.artifacts?.beforeRead('history', signal)
          if (instance.sessions.get(session.id) !== session) {
            send({ code: 'session_not_found' }, 404)
            return
          }
          send(sessionOutputFiles(session, offset))
        })
        return
      }
      if (action === 'fork-origin' && method === 'GET') {
        send({ origin: null })
        return
      }
      if (action === 'display-children' && method === 'GET') {
        send({ session_id: session.id, child_count: 0 })
        return
      }
      if (action === PREVIEW_RUNTIME_RECONFIGURATION.sessionAction && method === 'GET') {
        response.writeHead(204)
        response.end()
        return
      }
      const artifactRoute = action.match(/^artifacts\/([^/]+)\/(raw|content|open)$/)
      if (
        artifactRoute &&
        (method === 'GET' || (method === 'HEAD' && artifactRoute[2] === 'raw'))
      ) {
        if (!instance.artifacts || url.searchParams.get('member'))
          throw new PreviewArtifactsError(PREVIEW_ARTIFACTS.notFound, 404)
        const artifactId = decodeURIComponent(artifactRoute[1])
        instance.artifacts.read(session.id, artifactId)
        await archiveResponse(response, async (signal) => {
          await instance.artifacts!.beforeRead('content', signal)
          if (instances.get(id) !== instance) {
            send({ detail: 'preview_instance_reset' }, 409)
            return
          }
          if (instance.sessions.get(session.id) !== session) {
            send({ code: 'session_not_found' }, 404)
            return
          }
          const file = instance.artifacts!.read(session.id, artifactId)
          if (artifactRoute[2] === 'open') {
            const format = previewDocumentFormat(file.path, file.bytes)
            send({ viewer: format.viewer, processor: format.processor, content_kind: format.contentKind,
              media_type: format.mediaType, size: file.size, revision: file.revision,
              capabilities: { can_preview: format.viewer !== 'unsupported', can_edit: false,
                can_select: false, can_annotate: false, can_save: false, can_version: false,
                can_diff: false, pending: format.pending } })
          } else if (artifactRoute[2] === 'content') {
            const binary = file.bytes.subarray(0, PREVIEW_ARTIFACTS.binaryProbeBytes).includes(0)
            const truncated = file.size > PREVIEW_ARTIFACTS.textMaxBytes
            send({
              path: file.path,
              size: file.size,
              binary,
              truncated,
              content: binary || truncated ? '' : new TextDecoder().decode(file.bytes),
            })
          } else {
            response.writeHead(200, {
              'content-type': previewDocumentFormat(file.path, file.bytes).mediaType,
              'content-length': String(file.size),
              etag: `"${file.revision}"`,
              [PREVIEW_ARTIFACTS.editableHeader]: 'false',
              'cache-control': 'no-store',
            })
            response.end(method === 'HEAD' ? undefined : file.bytes)
          }
        })
        return
      }
      if (action === '' && method === 'DELETE') {
        if (session.activeTurn) {
          send({ ok: false, error: 'session_running' }, 409)
          return
        }
        await archiveResponse(response, async (signal) => {
          await instance.archive?.write(signal)
          if (session.activeTurn) {
            send({ ok: false, error: 'session_running' }, 409)
            return
          }
          session.submission?.cancel()
          clearTimers(session)
          session.transport.dispose()
          for (const stream of session.streams) stream.end()
          instance.sessions.delete(session.id)
          send({ ok: true, session_id: session.id })
        })
        return
      }
      if (action === 'events' && method === 'GET') {
        const from = Number(url.searchParams.get('from_seq') ?? 0)
        if (!Number.isSafeInteger(from) || from < 0 || from > session.events.length) {
          send({ code: 'preview_invalid_cursor' }, 400)
          return
        }
        const controller = new AbortController()
        const abort = (): void => controller.abort()
        response.once('close', abort)
        try {
          await session.transport.wait(controller.signal)
        } catch (error) {
          if (response.destroyed) return
          if (error instanceof PreviewTransportError) {
            send({ code: error.code }, error.status)
            return
          }
          throw error
        } finally {
          response.off('close', abort)
        }
        if (response.destroyed) return
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-preview-simulation': 'true',
        })
        response.write(
          ': preview-simulation\n\n' +
            session.events
              .filter((event) => event.seq > from)
              .map((event) => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
              .join('')
        )
        session.streams.add(response)
        const heartbeat = setInterval(
          () => response.write('event: heartbeat\ndata: {}\n\n'),
          CONFIG.heartbeatMs
        )
        response.on('close', () => {
          clearInterval(heartbeat)
          session.streams.delete(response)
        })
        return
      }
      if (action === 'turns' && method === 'POST') {
        if (session.activeTurn || session.submission) {
          send(
            {
              code: 'session_busy',
              detail: 'A simulated turn is already running or being submitted',
            },
            409
          )
          return
        }
        if (
          !Array.isArray(body.input) ||
          !body.input.length ||
          body.input.some(
            (item) =>
              !item ||
              (item.type === 'text'
                ? typeof item.text !== 'string'
                : item.type === 'skill' && instance.conversation.draftReferences
                  ? !instance.skills.has(item.name) ||
                    instance.skills.get(item.name)?.info.path !== item.path
                  : true)
          )
        ) {
          send({ code: 'preview_text_input_required' }, 400)
          return
        }
        if (instance.conversation.submission === 'delayed') {
          const accepted = await waitSubmission(session, response)
          if (
            !accepted ||
            response.destroyed ||
            instances.get(id) !== instance ||
            instance.sessions.get(session.id) !== session
          ) {
            if (!response.destroyed) send({ code: PREVIEW_CONVERSATION.submissionCancelled }, 410)
            return
          }
        }
        startTurn(instance, session, body)
        send({ ok: true, accepted: true, disposition: 'direct', turn_id: session.activeTurn })
        return
      }
      if (action.startsWith('hil/') && method === 'POST') {
        const requestId = decodeURIComponent(action.slice('hil/'.length))
        const pending = session.pending.find((item) => item.request_id === requestId)
        if (!pending) {
          send({ code: 'interaction_not_pending' }, 409)
          return
        }
        if (session.authorization && pending.kind === 'question' && body.cancelled !== true) {
          const interaction = resolveAuthorization(session, requestId, body)
          send({ ok: true, request_id: requestId, interaction })
          return
        }
        const decision =
          body.decision ??
          (body.option_id === 'y' ? 'allow_once' : body.option_id === 'n' ? 'deny' : undefined)
        if (body.cancelled !== true && decision !== 'allow_once' && decision !== 'deny') {
          send({ code: 'preview_invalid_decision' }, 400)
          return
        }
        const cancelled = body.cancelled === true
        const interaction = {
          ...pending,
          session_id: session.id,
          turn_id: session.lastTurn!,
          state: cancelled ? ('cancelled' as const) : ('resolved' as const),
          created_at: pending.requested_at!,
          resolved_at: Date.now() / 1000,
          ...(decision ? { decision: decision as 'deny' | 'allow_once' } : {}),
        }
        session.pending = []
        publish(session, 'hil_resolved', {
          ...pending,
          state: interaction.state,
          decision: interaction.decision,
          resolved_at: interaction.resolved_at,
        })
        if (decision === 'deny') session.deliver = undefined
        if (cancelled) finish(session, 'interrupted')
        else {
          session.lastStatus = 'running'
          publish(session, 'session_state', {
            state: 'running',
            runtime_id: 'codex',
            active_turn_id: session.activeTurn!,
          })
          const delay =
            decision !== 'deny' && instance.conversation.approvalResume === 'delayed'
              ? PREVIEW_CONVERSATION.approvalResumeDelayMs
              : CONFIG.tickMs
          later(
            session,
            () =>
              answer(
                session,
                decision === 'deny'
                  ? PREVIEW_CONVERSATION.denialAnswer
                  : PREVIEW_CONVERSATION.approvalAnswer
              ),
            delay
          )
        }
        send({ ok: true, request_id: requestId, interaction })
        return
      }
      if ((action === 'interrupt' || action === 'terminate') && method === 'POST') {
        session.submission?.cancel()
        for (const pending of session.pending)
          publish(session, 'hil_resolved', { ...pending, state: 'cancelled' })
        session.pending = []
        finish(session, 'interrupted', action === 'interrupt' ? PREVIEW_CONVERSATION.userInterruptReason : undefined)
        send({ ok: true })
        return
      }
      if (action === 'navigation' && method === 'GET') {
        send(snapshot(session))
        return
      }
      if (action === 'queue' && method === 'GET') {
        send({ messages: [] })
        return
      }
      const reconcile = action.match(/^queue\/([^/]+)\/reconcile$/)
      if (reconcile && method === 'POST') {
        const messageId = decodeURIComponent(reconcile[1])
        const applied = session.events.some(
          (event) => event.type === 'user_message' && event.data.client_turn_id === messageId
        )
        send({
          ok: true,
          outcome: applied ? 'applied' : 'not_applied',
          queued_message_id: messageId,
          queue_missing: true,
        })
        return
      }
      if (action === 'model' && method === 'GET') {
        send({ model_id: CONFIG.model, model_key: CONFIG.model, reasoning_effort: 'medium' })
        return
      }
      if (action === 'mode' && method === 'GET') {
        send({ mode: 'safe_auto', collaboration_mode: 'default' })
        return
      }
      if (action === 'pin' && method === 'PUT') {
        if (typeof body.pinned !== 'boolean') {
          send({ code: 'invalid_pinned' }, 400)
          return
        }
        if (session.pinned !== body.pinned) {
          session.pinned = body.pinned
          session.modifiedAt = Date.now() / 1000
        }
        send({ ok: true, session_id: session.id, pinned: session.pinned })
        return
      }
      if (action === 'archive' && method === 'PUT') {
        if (typeof body.archived !== 'boolean') {
          send({ code: 'invalid_archived' }, 400)
          return
        }
        if (session.activeTurn) {
          send({ ok: false, error: 'session_running' }, 409)
          return
        }
        const archived = body.archived
        await archiveResponse(response, async (signal) => {
          if (session.archived !== archived) await instance.archive?.write(signal)
          if (session.activeTurn) {
            send({ ok: false, error: 'session_running' }, 409)
            return
          }
          if (session.archived !== archived) {
            session.archived = archived
            session.modifiedAt = Date.now() / 1000
          }
          send({ ok: true, session_id: session.id, archived: session.archived })
        })
        return
      }
      if (action === '' && method === 'PATCH' && typeof body.title === 'string') {
        if (session.title !== body.title) {
          session.title = body.title
          session.modifiedAt = Date.now() / 1000
        }
        send({ ok: true, title: session.title, title_fallback: null })
        return
      }
    }
    if (path === PREVIEW_STORAGE_READ.configPath && method === 'GET') {
      await archiveResponse(response, async (signal) => {
        await instance.storage.beforeRead('home', signal)
        if (instances.get(id) !== instance) {
          send({ detail: 'preview_instance_reset' }, 409)
          return
        }
        if (!response.destroyed) send(instance.storage.readConfig())
      })
      return
    }
    if (path === PREVIEW_STORAGE.path) {
      if (method === 'GET') {
        await archiveResponse(response, async (signal) => {
          await instance.storage.beforeRead('workspace', signal)
          if (instances.get(id) !== instance) {
            send({ detail: 'preview_instance_reset' }, 409)
            return
          }
          if (!response.destroyed) send(instance.storage.read())
        })
        return
      }
      if (method !== 'PUT') {
        unimplemented(instance, method, path, response)
        return
      }
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      response.once('close', abort)
      try {
        const result = await instance.storage.configure(body, controller.signal)
        if (!response.destroyed) send(result)
      } catch (error) {
        if (response.destroyed) return
        throw error
      } finally {
        response.off('close', abort)
      }
      return
    }
    const setting = path.match(/^\/api\/serve\/settings\/([^/]+)$/)?.[1]
    if (setting === 'file-versions') {
      if (method === 'POST') {
        const controller = new AbortController()
        const abort = (): void => controller.abort()
        response.once('close', abort)
        try {
          const result = await instance.fileSettings.configure(body, controller.signal)
          if (!response.destroyed) send(result)
        } catch (error) {
          if (response.destroyed) return
          throw error
        } finally {
          response.off('close', abort)
        }
        return
      }
      if (method !== 'GET') {
        unimplemented(instance, method, path, response)
        return
      }
      const projects = instance.projects.all()
      const scan = {
        status: 'idle' as const,
        projects: projects.length,
        managed: 0,
        created: 0,
        ignored: 0,
        oversized: 0,
        unsupported: 0,
        failed: 0,
      }
      for (const project of projects) {
        let versions = instance.versions.get(project.id)
        if (!versions) {
          versions = new PreviewVersions(instance.projects.files(project.id))
          instance.versions.set(project.id, versions)
        }
        for (const entry of instance.projects.files(project.id).manifest()) {
          const capability = versions.capability(entry.path)
          if (capability.managed) scan.managed++
          else scan.unsupported++
        }
      }
      send(instance.fileSettings.read(scan))
      return
    }
    if (setting && Object.prototype.hasOwnProperty.call(instance.settings, setting)) {
      if (method === 'POST') {
        if (setting === 'permission-mode') {
          if (!['ask', 'safe_auto', 'bypassPermissions'].includes(String(body.mode))) {
            send({ code: 'invalid_mode' }, 400)
            return
          }
          instance.settings[setting] = {
            ...(instance.settings[setting] as object),
            mode: body.mode,
          }
        } else {
          if (typeof body.enabled !== 'boolean') {
            send({ code: 'invalid_enabled' }, 400)
            return
          }
          instance.settings[setting] = { enabled: body.enabled }
        }
      } else if (method !== 'GET') {
        send({ code: 'preview_method_not_allowed' }, 405)
        return
      }
      send(instance.settings[setting])
      return
    }
    if (path === '/api/serve/models' && method === 'GET') {
      send({ ...MODELS, service_instance_id: `preview-${id}` })
      return
    }
    if (path === '/api/resource/finalizations' && method === 'GET') {
      const session = instance.sessions.get(url.searchParams.get('session_id') ?? '')
      if (!session) {
        send({ code: 'session_not_found' }, 404)
        return
      }
      send({ entries: [], next_cursor: null })
      return
    }
    const turnSources = path.match(/^\/api\/assistant\/sessions\/([^/]+)\/turns\/([^/]+)\/sources$/)
    if (turnSources) {
      if (method !== 'GET') {
        send({ code: 'preview_method_not_allowed' }, 405)
        return
      }
      const session = instance.sessions.get(decodeURIComponent(turnSources[1]))
      if (!session) {
        send(CONFIG.sessionNotFound, 404)
        return
      }
      const turnId = decodeURIComponent(turnSources[2])
      const markdown = session.history.turns
        .filter(
          (turn) =>
            turn.turn_id === turnId && turn.role === 'assistant' && turn.phase === 'final_answer'
        )
        .map((turn) => turn.text ?? '')
        .join('\n\n')
      send({ sources: [], markdown, answer_id: CONFIG.turnAnswerPrefix + turnId })
      return
    }
    const assistantRead = path.match(
      /^\/api\/assistant\/sessions\/([^/]+)\/(annotations|resources\/links|literature\/links)$/
    )
    if (assistantRead && method === 'GET') {
      if (!instance.sessions.has(decodeURIComponent(assistantRead[1]))) {
        send({ code: 'session_not_found' }, 404)
        return
      }
      send(
        assistantRead[2] === 'annotations'
          ? {
              annotations:
                instance.sessions.get(decodeURIComponent(assistantRead[1]))!.annotations,
            }
          : { links: [] }
      )
      return
    }
    if (assistantRead?.[2] === 'annotations' && method === 'DELETE') {
      const session = instance.sessions.get(decodeURIComponent(assistantRead[1]))
      if (!session) {
        send(CONFIG.sessionNotFound, 404)
        return
      }
      const revision = body.expected_context_revision
      const selected = body.annotations
      if (!Number.isSafeInteger(revision) || Number(revision) < 0 || !Array.isArray(selected) ||
          !selected.length || selected.some(item => !item || typeof item.annotation_id !== 'string' ||
            !item.annotation_id || !Number.isSafeInteger(item.expected_annotation_revision) || item.expected_annotation_revision < 1) ||
          new Set(selected.map(item => item.annotation_id)).size !== selected.length) {
        send({ detail: 'invalid_annotation_batch_delete' }, 422)
        return
      }
      const expected = new Map(selected.map(item => [item.annotation_id, item.expected_annotation_revision]))
      const annotations = session.annotations.filter(item => expected.has(item.annotation_id))
      if (!annotations.length) {
        send(session.context)
        return
      }
      if (revision !== session.context.revision) {
        send({ detail: { error: ASSISTANT_CONTEXT_REVISION_CONFLICT, latest: session.context } }, 409)
        return
      }
      for (const annotation of annotations) {
        if (annotation.revision !== expected.get(annotation.annotation_id)) {
          send({ detail: { error: 'answer_annotation_revision_conflict', latest: annotation } }, 409)
          return
        }
        const claimed = session.context.refs.some(reference => reference.kind === 'note' &&
          reference.source_id === annotation.annotation_id && session.context.claimed_ref_ids?.includes(reference.ref_id)) ||
          Boolean(session.activeTurn && session.history.turns.some(turn => turn.kind === 'user' && turn.turn_id === session.activeTurn &&
            turn.refs?.some(reference => reference.kind === 'note' && reference.source_id === annotation.annotation_id)))
        if (claimed) {
          send({ detail: 'answer_annotation_claimed' }, 409)
          return
        }
      }
      const deleted = new Set(annotations.map(annotation => annotation.annotation_id))
      const refs = session.context.refs.filter(reference => reference.kind !== 'note' || !deleted.has(reference.source_id))
      session.annotations = session.annotations.filter(annotation => !deleted.has(annotation.annotation_id))
      if (refs.length !== session.context.refs.length)
        session.context = { ...session.context, refs, revision: session.context.revision + 1, updated_at: Date.now() / 1000 }
      send(session.context)
      return
    }
    if (annotationContext && method === 'DELETE') {
      const session = instance.sessions.get(decodeURIComponent(annotationContext[1]))
      if (!session) {
        send(CONFIG.sessionNotFound, 404)
        return
      }
      const revision = body.expected_context_revision
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
        send({ detail: CONTEXT_POLICY.invalidAnnotationRevision }, 422)
        return
      }
      const annotationId = decodeURIComponent(annotationContext[2])
      const reference = session.context.refs.find(
        (candidate) => candidate.kind === 'note' && candidate.source_id === annotationId
      )
      if (!reference) {
        send(session.context)
        return
      }
      if (revision !== session.context.revision) {
        send(
          { detail: { error: ASSISTANT_CONTEXT_REVISION_CONFLICT, latest: session.context } },
          409
        )
        return
      }
      session.context = {
        ...session.context,
        refs: session.context.refs.filter((candidate) => candidate.ref_id !== reference.ref_id),
        revision: session.context.revision + 1,
        updated_at: Date.now() / 1000,
      }
      send(session.context)
      return
    }
    const referenceRaw = path.match(/^\/api\/serve\/sessions\/([^/]+)\/files\/raw$/)
    if (referenceRaw && method === 'GET' && (instance.artifacts || instance.conversation.mixedReferences)) {
      const session = instance.sessions.get(decodeURIComponent(referenceRaw[1]))
      if (!session) {
        send(CONFIG.sessionNotFound, 404)
        return
      }
      if (!url.searchParams.has('path')) {
        send({ detail: 'path is required' }, 422)
        return
      }
      const name = url.searchParams.get('path')!
      const published = Boolean(instance.artifacts && sessionOutputFiles(session).items.some(file => file.name === name))
      const referenced = instance.conversation.mixedReferences && PREVIEW_REFERENCE_FILES.some(file => file === name)
      const project = published
        ? instance.projects.all().find(project => project.root === session.project)
        : referenced ? instance.projects.all()[0] : undefined
      if (!project) {
        send({ code: CONFIG.sessionFileUnavailable }, 404)
        return
      }
      await archiveResponse(response, async signal => {
        if (published) await instance.artifacts!.beforeRead('content', signal)
        if (instances.get(id) !== instance || instance.sessions.get(session.id) !== session) {
          send(CONFIG.sessionNotFound, 404)
          return
        }
        if (!instance.projects.all().some(candidate => candidate.id === project.id && candidate.root === (published ? session.project : project.root))) {
          send({ code: CONFIG.sessionFileUnavailable }, 404)
          return
        }
        const file = instance.projects.files(project.id).read(name)
        response.writeHead(200, {
          'content-type': previewDocumentFormat(file.path, file.bytes).mediaType,
          'content-length': String(file.size),
          etag: `"${file.revision}"`,
          'cache-control': 'no-store',
        }).end(file.bytes)
      })
      return
    }
    if (path === '/api/serve/attention' && method === 'GET') {
      send({ epoch: `preview-${id}`, revision: 0, unread_count: 0, by_session: {}, items: [] })
      return
    }
    const contextMatch = path.match(/^\/api\/assistant\/sessions\/([^/]+)\/context$/)
    if (contextMatch) {
      const session = instance.sessions.get(decodeURIComponent(contextMatch[1]))
      if (!session) {
        send({ code: 'session_not_found' }, 404)
        return
      }
      if (method === 'PATCH') {
        if (body.expected_revision !== session.context.revision) {
          send(
            { detail: { error: ASSISTANT_CONTEXT_REVISION_CONFLICT, latest: session.context } },
            409
          )
          return
        }
        if (
          !CONTEXT_POLICY.projects.some((value) => value === body.project_policy) ||
          !CONTEXT_POLICY.searches.some((value) => value === body.search_scope) ||
          !Array.isArray(body.refs) ||
          body.refs.some(
            (reference) =>
              !reference ||
              typeof reference.ref_id !== 'string' ||
              typeof reference.source_id !== 'string' ||
              typeof reference.kind !== 'string' ||
              typeof reference.label !== 'string'
          )
        ) {
          send({ code: 'preview_context_not_supported' }, 400)
          return
        }
        session.context = {
          ...session.context,
          refs: structuredClone(body.refs) as AssistantContextSelection['refs'],
          project_policy: body.project_policy as AssistantContextSelection['project_policy'],
          search_scope: body.search_scope as AssistantContextSelection['search_scope'],
          revision: session.context.revision + 1,
          updated_at: Date.now() / 1000,
        }
      } else if (method !== 'GET') {
        send({ code: 'preview_method_not_allowed' }, 405)
        return
      }
      send(session.context)
      return
    }
    const literatureResults = path.match(/^\/api\/literature\/([^/]+)\/ai\/results$/)
    const literatureState = path.match(/^\/api\/literature\/([^/]+)\/ai\/state$/)
    if (
      path === '/api/v1/literatures' ||
      path.startsWith('/api/v1/literatures/') ||
      path === '/api/v1/collections' ||
      path === '/api/v1/tags' ||
      literatureResults ||
      literatureState
    ) {
      const attachmentRoute = path.match(
        /^\/api\/v1\/literatures\/([^/]+)\/attachments\/([^/]+)\/(open|content|location|records|regions)$/
      )
      if (
        attachmentRoute &&
        (method === 'GET' || (method === 'HEAD' && attachmentRoute[3] === 'content'))
      ) {
        const itemId = decodeURIComponent(attachmentRoute[1])
        const attachmentId = decodeURIComponent(attachmentRoute[2])
        const attachment = instance.literature.attachment(itemId, attachmentId)
        if (attachment.availability !== 'available') {
          send({ detail: PREVIEW_LITERATURE.attachmentNotFound }, 404)
          return
        }
        const files = instance.projects.files(CONFIG.project)
        const entry = files.manifest().find((entry) => entry.identity === attachment.identity)
        if (!entry) {
          send({ detail: PREVIEW_LITERATURE.attachmentNotFound }, 404)
          return
        }
        const file = files.read(entry.path)
        const projection = documentProjection(file, CONFIG.project)
        const action = attachmentRoute[3]
        if (action === 'open') {
          send({
            viewer: projection.viewer,
            processor: projection.processor,
            content_kind: projection.content_kind,
            capabilities: projection.capabilities,
            media_type: projection.media_type,
            size: file.size,
            revision: file.revision,
          })
          return
        }
        if (action === 'location') {
          unimplemented(instance, method, path, response)
          return
        }
        if (action === 'records') {
          const records = { schema_version: 1 as const, marks: [], comments: [], notes: [] }
          const canonical = JSON.stringify({
            records: { comments: [], marks: [], notes: [], schema_version: 1 },
            source_revision: file.revision,
          })
          const snapshot: PdfRecordSnapshot = {
            record_target: attachment.summary.record_target,
            record_revision: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
            source_revision: file.revision,
            source_state: 'available',
            source_path: attachment.summary.name,
            records,
          }
          send(snapshot)
          return
        }
        if (action === 'regions') {
          const missing = ['revision', 'start_page', 'end_page'].filter(
            (key) => !url.searchParams.has(key)
          )
          if (missing.length) {
            send(
              {
                detail: missing.map((key) => ({
                  type: 'missing',
                  loc: ['query', key],
                  msg: 'Field required',
                  input: null,
                })),
              },
              422
            )
            return
          }
          const manifest = await previewPdfRegions(
            file,
            projection.media_type,
            url.searchParams.get('revision'),
            url.searchParams.get('start_page'),
            url.searchParams.get('end_page')
          )
          if (response.destroyed) return
          if (instances.get(id) !== instance) {
            send({ detail: PREVIEW_LITERATURE.disposed }, 410)
            return
          }
          const current = files.fileInfo(entry.path)
          if (current.identity !== file.identity || current.revision !== file.revision) {
            send({ detail: 'source_revision_conflict' }, 409)
            return
          }
          send(manifest)
          return
        }
        if (url.searchParams.get('preview') === 'true') {
          unimplemented(instance, method, path, response)
          return
        }
        const headers = {
          'Content-Type': projection.media_type,
          'Content-Length': String(file.size),
          'Accept-Ranges': 'bytes',
          ETag: `"${file.revision}"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(attachment.summary.name)}`,
        }
        if (method === 'HEAD') {
          response.writeHead(200, headers)
          response.end()
          return
        }
        if (request.headers.range) {
          const range = previewVersionRange(request.headers.range, file.size)
          if (!range) {
            response.writeHead(416, {
              ...headers,
              'Content-Length': '0',
              'Content-Range': `bytes */${file.size}`,
            })
            response.end()
            return
          }
          const [start, end] = range
          response.writeHead(206, {
            ...headers,
            'Content-Range': `bytes ${start}-${end}/${file.size}`,
            'Content-Length': String(end - start + 1),
          })
          response.end(file.bytes.subarray(start, end + 1))
          return
        }
        response.writeHead(200, headers)
        response.end(file.bytes)
        return
      }
      const projectId = url.searchParams.getAll('project_id').at(-1) ?? ''
      const detailRoute = path.match(
        /^\/api\/v1\/literatures\/([^/]+)(?:\/(notes)(?:\/([^/]+))?)?$/
      )
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      response.once('close', abort)
      try {
        let payload: unknown
        const signal = controller.signal
        if (literatureState && method === 'GET') {
          const itemId = decodeURIComponent(literatureState[1])
          const item = await instance.literature.detail(itemId, '', signal)
          const attachment = instance.literature.attachment(
            itemId,
            url.searchParams.get('attachment_id') || item.primary_attachment?.id || ''
          )
          const files = instance.projects.files(CONFIG.project)
          const entry = files.manifest().find(entry => entry.identity === attachment.identity)
          if (attachment.availability !== 'available' || !entry) {
            send({ detail: PREVIEW_LITERATURE.attachmentNotFound }, 404)
            return
          }
          const revision = createHash('sha256').update(files.read(entry.path).bytes).digest('hex')
          const requested = url.searchParams.get('source_revision')?.replace(/^sha256:/, '')
          if (requested && requested !== revision) {
            send({ detail: { code: PREVIEW_LITERATURE.sourceChanged, diagnostic: '' } }, 422)
            return
          }
          payload = { revision, attachment_id: attachment.summary.id, results: {}, task: null }
        } else if (literatureResults && method === 'GET') {
          if (!url.searchParams.has('source_revision')) {
            send(
              {
                detail: [
                  {
                    type: 'missing',
                    loc: ['query', 'source_revision'],
                    msg: 'Field required',
                    input: null,
                  },
                ],
              },
              422
            )
            return
          }
          await instance.literature.detail(decodeURIComponent(literatureResults[1]), '', signal)
          payload = {}
        } else if (path === '/api/v1/literatures' && method === 'GET')
          payload = await instance.literature.list(
            parsePreviewLiteratureQuery(url.searchParams),
            signal
          )
        else if (path === '/api/v1/literatures/counts' && method === 'GET')
          payload = await instance.literature.counts(projectId, signal)
        else if (path === '/api/v1/literatures/facets' && method === 'GET')
          payload = await instance.literature.facets({ project_id: projectId }, signal)
        else if (path === '/api/v1/literatures/projects' && method === 'GET')
          payload = await instance.literature.projects(signal)
        else if (path === '/api/v1/literatures/tag-facets' && method === 'GET') {
          const scope = new URLSearchParams()
          for (const key of [
            'project_id',
            'collection_id',
            'recent',
            'without_collection',
            'without_project',
          ])
            for (const value of url.searchParams.getAll(key)) scope.append(key, value)
          payload = await instance.literature.tagFacets(parsePreviewLiteratureQuery(scope), signal)
        } else if (path === '/api/v1/collections' && method === 'GET')
          payload = await instance.literature.collections(projectId, signal)
        else if (path === '/api/v1/tags' && method === 'GET')
          payload = await instance.literature.tags(signal)
        else if (detailRoute && !detailRoute[2] && method === 'GET')
          payload = await instance.literature.detail(
            decodeURIComponent(detailRoute[1]),
            projectId,
            signal
          )
        else if (detailRoute && !detailRoute[2] && method === 'PATCH')
          payload = await instance.literature.update(
            decodeURIComponent(detailRoute[1]),
            body,
            projectId,
            signal
          )
        else if (detailRoute && detailRoute[2] === 'notes' && !detailRoute[3] && method === 'GET')
          payload = await instance.literature.notes(decodeURIComponent(detailRoute[1]), signal)
        else if (detailRoute && detailRoute[2] === 'notes' && !detailRoute[3] && method === 'POST')
          payload = await instance.literature.createNote(
            decodeURIComponent(detailRoute[1]),
            body,
            signal
          )
        else if (detailRoute?.[3] && method === 'PATCH')
          payload = await instance.literature.updateNote(
            decodeURIComponent(detailRoute[1]),
            decodeURIComponent(detailRoute[3]),
            body,
            signal
          )
        else if (detailRoute?.[3] && method === 'DELETE')
          payload = await instance.literature.deleteNote(
            decodeURIComponent(detailRoute[1]),
            decodeURIComponent(detailRoute[3]),
            signal
          )
        else {
          unimplemented(instance, method, path, response)
          return
        }
        if (!response.destroyed) send(payload)
      } finally {
        response.off('close', abort)
      }
      return
    }
    if (path === '/api/serve/interactions/pending' && method === 'GET') {
      send({
        interactions: [...instance.sessions.values()].flatMap((session) =>
          session.pending.map((item) => ({
            ...item,
            session_id: session.id,
            turn_id: session.lastTurn,
            state: 'pending',
            created_at: item.requested_at,
          }))
        ),
      })
      return
    }
    const projectTree = path.match(/^\/api\/content\/projects\/([^/]+)\/tree$/)
    if (projectTree && method === 'GET') {
      const project = instance.projects
        .all()
        .find((project) => project.id === decodeURIComponent(projectTree[1]))
      if (!project) {
        send({ code: 'preview_project_not_found' }, 404)
        return
      }
      await archiveResponse(response, async (signal) => {
        const files = instance.projects.files(project.id)
        const result = await projectBrowsing(instance, project.id).tree(
          url.searchParams.get('path') ?? '',
          Number(url.searchParams.get('offset') ?? 0),
          signal
        )
        if (instances.get(id) !== instance) {
          send({ detail: 'preview_instance_reset' }, 409)
          return
        }
        if (!instance.projects.all().some((current) => current.id === project.id)) {
          send({ code: 'preview_project_not_found' }, 404)
          return
        }
        const page: ProjectTreePage = {
          root: project.root,
          total: result.total,
          offset: result.offset,
          nodes: result.entries.map((entry) => ({
            path: entry.path,
            name: entry.name,
            kind: entry.kind,
            available: true,
            count: entry.kind === 'dir' ? files.list(entry.path).length : null,
          })),
        }
        if (!response.destroyed) send({ ...page, path: url.searchParams.get('path') ?? '' })
      })
      return
    }
    const pdfRecords = path.match(/^\/api\/workbench\/assets\/([^/]+)\/pdf\/records$/)
    if (pdfRecords && method === 'GET') {
      const project = instance.projects
        .all()
        .find((project) => project.id === url.searchParams.get('project'))
      if (!project) {
        send({ code: 'preview_project_not_found' }, 404)
        return
      }
      const files = instance.projects.files(project.id)
      const entry = files
        .manifest()
        .find((entry) => entry.identity === decodeURIComponent(pdfRecords[1]))
      if (!entry) {
        send({ code: 'preview_asset_not_found' }, 404)
        return
      }
      const file = files.read(entry.path)
      if (new TextDecoder().decode(file.bytes.slice(0, 5)) !== '%PDF-') {
        send({ detail: 'invalid_pdf' }, 422)
        return
      }
      const records = { schema_version: 1 as const, marks: [], comments: [], notes: [] }
      const canonical = JSON.stringify({
        records: { comments: [], marks: [], notes: [], schema_version: 1 },
        source_revision: file.revision,
      })
      const snapshot: PdfRecordSnapshot = {
        record_target: { owner: 'project_asset', scope_id: project.id, subject_id: entry.identity },
        record_revision: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
        source_revision: file.revision,
        source_state: 'available',
        source_path: entry.path,
        records,
      }
      send(snapshot)
      return
    }
    if (path === '/api/workbench/pdf/regions' && method === 'GET') {
      const missing = ['path', 'project', 'revision', 'start_page', 'end_page'].filter(
        (key) => !url.searchParams.has(key)
      )
      if (missing.length) {
        send(
          {
            detail: missing.map((key) => ({
              type: 'missing',
              loc: ['query', key],
              msg: 'Field required',
              input: null,
            })),
          },
          422
        )
        return
      }
    }
    const resourcePaths = [
      '/api/resource/tree',
      RESOURCE_LIST_SCOPE.path,
      RESOURCE_LIST_SCOPE.searchPath,
      '/api/resource/count',
      '/api/resource/read',
      '/api/resource/raw',
      '/api/resource/write',
      '/api/resource/node',
      '/api/resource/reveal',
      '/api/workbench/open',
      '/api/workbench/content',
      '/api/workbench/pdf/regions',
      '/api/content/cursor',
      '/api/content/events',
    ]
    if (resourcePaths.includes(path)) {
      const searchListing = path === RESOURCE_LIST_SCOPE.searchPath && method === 'GET'
      const listing = (path === RESOURCE_LIST_SCOPE.path && method === 'GET') || searchListing
      const listingProject = url.searchParams.getAll('project').slice(-1)[0]
      if (listing && !listingProject) {
        send(
          listingProject === undefined ? RESOURCE_LIST_SCOPE.missing : RESOURCE_LIST_SCOPE.empty,
          RESOURCE_LIST_SCOPE.validationStatus
        )
        return
      }
      if (listing && listingProject === 'current') {
        send(RESOURCE_LIST_SCOPE.noProject, RESOURCE_LIST_SCOPE.noProjectStatus)
        return
      }
      const requestedProject = listing
        ? listingProject
        : path === '/api/resource/reveal'
          ? typeof body.project === 'string'
            ? body.project
            : undefined
          : (url.searchParams.get('project') ??
            (typeof body.project === 'string' ? body.project : undefined))
      const project =
        requestedProject && requestedProject !== 'current'
          ? instance.projects
              .all()
              .find(
                (project) =>
                  project.id === requestedProject || (!listing && project.root === requestedProject)
              )
          : instance.projects.all()[0]
      if (!project) {
        send(
          listing ? RESOURCE_LIST_SCOPE.unknownProject : { code: 'preview_project_not_found' },
          listing ? RESOURCE_LIST_SCOPE.unknownProjectStatus : 404
        )
        return
      }
      const files = instance.projects.files(project.id)
      let versions = instance.versions.get(project.id)
      if (!versions) {
        versions = new PreviewVersions(files)
        instance.versions.set(project.id, versions)
      }
      const filePath = url.searchParams.get('path') ?? ''
      if (path === '/api/resource/reveal' && method === 'POST') {
        if (
          typeof body.path !== 'string' ||
          (body.project != null && typeof body.project !== 'string')
        ) {
          send({ detail: 'preview_invalid_path' }, 400)
          return
        }
        if (body.path === '' || body.path === '.') {
          send({ absolute: project.root })
          return
        }
        try {
          const entry = files.fileInfo(body.path)
          send({ absolute: `${project.root}/${entry.path}` })
        } catch (error) {
          if (error instanceof PreviewFileError && error.code === PREVIEW_FILE_ERROR.notFound) {
            send({ detail: 'node_not_found' }, 404)
            return
          }
          throw error
        }
        return
      }
      if (path === '/api/content/cursor' && method === 'GET') {
        send({ epoch: instance.epoch, last_seq: instance.fileEvents.length })
        return
      }
      if (path === '/api/content/events' && method === 'GET') {
        const from = Number(url.searchParams.get('from_seq') ?? 0)
        if (!Number.isSafeInteger(from) || from < 0 || from > instance.fileEvents.length) {
          send({ code: 'preview_invalid_cursor' }, 400)
          return
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        response.write(
          ': preview-file-events\n\n' +
            instance.fileEvents
              .filter((event) => event.project_id === project.id && event.seq > from)
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join('')
        )
        instance.fileStreams.set(response, project.id)
        const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), CONFIG.heartbeatMs)
        response.on('close', () => {
          clearInterval(heartbeat)
          instance.fileStreams.delete(response)
        })
        return
      }
      if (path === '/api/resource/count' && method === 'GET') {
        send({ files: files.manifest().length })
        return
      }
      if (listing) {
        const owner = projectBrowsing(instance, project.id)
        const projectExists = (): boolean =>
          instance.projects.all().some((current) => current.id === project.id)
        await archiveResponse(response, async (signal) => {
          const directory = searchListing ? null : url.searchParams.get('directory')
          const entries = await owner.listing(signal, directory ?? undefined)
          if (instances.get(id) !== instance) {
            send({ detail: 'preview_instance_reset' }, 409)
            return
          }
          if (!projectExists()) {
            send(RESOURCE_LIST_SCOPE.unknownProject, RESOURCE_LIST_SCOPE.unknownProjectStatus)
            return
          }
          if (response.destroyed) return
          const childCounts = new Map<string, number>()
          if (directory === null) {
            for (const entry of entries) {
              const parent = posix.dirname(entry.path)
              childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1)
            }
          }
          const projectNode = (entry: PreviewFileEntry, capability?: PreviewVersions) =>
            resourceNode(entry, capability, childCounts.get(entry.path))
          if (searchListing) {
            // The browsing VFS models local project files only. External roots are not mounted here.
            const linkedRoots = {}
            // Capture one VFS view before a slow response allows other requests to modify it.
            const items = entries.map((entry) => projectNode(entry, versions))
            const canContinue = (): boolean => {
              if (signal.aborted || response.destroyed || !response.writable) return false
              if (instances.get(id) === instance && projectExists()) return true
              response.destroy()
              return false
            }
            const writeFrame = async (frame: object): Promise<boolean> => {
              if (!canContinue()) return false
              if (!response.write(`data: ${JSON.stringify(frame)}\n\n`)) {
                try {
                  await once(response, 'drain', { signal })
                } catch (error) {
                  if (!signal.aborted) throw error
                }
              }
              return canContinue()
            }
            response.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-store',
              'x-preview-simulation': 'true',
            })
            for (let start = 0; start < items.length; start += PREVIEW_BROWSING.pageSize) {
              const batch = items
                .slice(start, start + PREVIEW_BROWSING.pageSize)
                .map(({ version: _version, ...item }) => item)
              if (!(await writeFrame({ type: 'batch', items: batch, linked_roots: linkedRoots })))
                return
            }
            if (url.searchParams.get('candidate_completion') === 'true') {
              const candidates = { type: 'candidates_complete', items: [], linked_roots: linkedRoots }
              if (!(await writeFrame(candidates))) return
            }
            if (!canContinue()) return
            const completed = {
              type: 'complete',
              items,
              linked_roots: linkedRoots,
              incremental: { parents: [], supported: false },
            }
            response.end(`data: ${JSON.stringify(completed)}\n\n`)
          } else {
            const withVersions = directory === null || url.searchParams.get('versions') !== 'false'
            const canonical = directory === null ? null : posix.normalize(directory).replace(/\/$/, '')
            send({
              ...(canonical !== null ? { directory: canonical === '.' ? '' : canonical } : {}),
              items: entries.map((entry) => projectNode(entry, withVersions ? versions : undefined)),
            })
          }
        })
        return
      }
      if (path === '/api/resource/tree' && method === 'GET') {
        const owner = projectBrowsing(instance, project.id)
        const page = owner.page(filePath, Number(url.searchParams.get('offset') ?? 0))
        send({
          root: project.root,
          resource_root: project.root,
          nodes: page.entries.map((entry) =>
            resourceNode(
              entry,
              versions,
              entry.kind === 'dir' ? files.list(entry.path).length : 0
            )
          ),
          total: page.total,
          offset: page.offset,
        })
        return
      }
      if (path === '/api/workbench/open' && method === 'GET') {
        send(documentProjection(files.read(filePath), project.id, versions))
        return
      }
      if (path === '/api/workbench/pdf/regions' && method === 'GET') {
        const file = files.read(filePath)
        const manifest = await previewPdfRegions(
          file,
          documentProjection(file, project.id).media_type,
          url.searchParams.get('revision'),
          url.searchParams.get('start_page'),
          url.searchParams.get('end_page')
        )
        if (instances.get(id) !== instance) {
          send({ detail: PREVIEW_CONTENT.cancelledCode }, 410)
          return
        }
        const current = files.fileInfo(filePath)
        if (current.identity !== file.identity || current.revision !== file.revision) {
          send({ detail: 'source_revision_conflict' }, 409)
          return
        }
        send(manifest)
        return
      }
      if (
        (path === '/api/workbench/content' ||
          path === '/api/resource/raw' ||
          path === '/api/resource/read') &&
        method === 'GET'
      ) {
        const entry = files.fileInfo(filePath)
        if (path === '/api/workbench/content' && url.searchParams.get('preview') === 'true') {
          send({ code: 'preview_conversion_unavailable' }, 501)
          return
        }
        if (path === '/api/workbench/content' && instance.content) {
          const controller = new AbortController()
          const abort = (): void => controller.abort()
          response.once('close', abort)
          let outcome: Awaited<ReturnType<PreviewContent['read']>>
          try {
            outcome = await instance.content.read(
              { project: project.id, identity: entry.identity },
              controller.signal
            )
          } finally {
            response.off('close', abort)
          }
          if (response.destroyed) return
          if (instances.get(id) !== instance) {
            send({ detail: PREVIEW_CONTENT.cancelledCode }, 410)
            return
          }
          if (outcome !== 'ready') {
            send(
              {
                detail:
                  outcome === 'failed'
                    ? PREVIEW_CONTENT.failureCode
                    : PREVIEW_CONTENT.cancelledCode,
              },
              outcome === 'failed' ? 503 : 410
            )
            return
          }
          if (!instance.projects.all().some((current) => current.id === project.id)) {
            send({ code: 'preview_project_not_found' }, 404)
            return
          }
        }
        const file = files.read(filePath)
        if (path === '/api/resource/read') send({ content: new TextDecoder().decode(file.bytes) })
        else {
          response.writeHead(200, {
            'content-type': documentProjection(file, project.id).media_type,
            etag: `"${file.revision}"`,
            'cache-control': 'no-store',
          })
          response.end(file.bytes)
        }
        return
      }
      if (path === '/api/workbench/content' && method === 'PUT') {
        if (request.headers['content-type']?.split(';', 1)[0] !== 'application/octet-stream') {
          send({ detail: 'binary_content_type_required' }, 415)
          return
        }
        const expectedHeader = request.headers['if-match']
        const expected = typeof expectedHeader === 'string' ? expectedHeader.trim() : ''
        if (!expected || expected === '""') {
          send({ detail: 'revision_required' }, 428)
          return
        }
        const previous = files.read(filePath)
        if (!documentProjection(previous, project.id).capabilities.can_save) {
          send({ code: 'preview_read_only' }, 403)
          return
        }
        if (expected !== `"${previous.revision}"` && expected !== previous.revision) {
          send({ detail: 'revision_conflict' }, 412)
          return
        }
        const updated = versions.write(filePath, rawBody!)
        publishFile(instance, project.id, 'modified', filePath)
        response.writeHead(204, { etag: `"${updated.revision}"` })
        response.end()
        return
      }
      if (path === '/api/resource/write' && method === 'POST') {
        if (typeof body.path !== 'string' || typeof body.content !== 'string') {
          send({ code: 'invalid_content' }, 400)
          return
        }
        const node = versions.write(body.path, new TextEncoder().encode(body.content))
        publishFile(instance, project.id, 'modified', node.path)
        send({ ok: true, node: resourceNode(node) })
        return
      }
      if (path === '/api/resource/node' && method === 'POST') {
        const name = typeof body.name === 'string' ? body.name : ''
        const parent = typeof body.parent === 'string' ? body.parent : ''
        const source = typeof body.path === 'string' ? body.path : ''
        if (body.action === 'create_document') {
          const entry = versions.write(
            parent ? `${parent}/${name}` : name,
            new TextEncoder().encode(typeof body.content === 'string' ? body.content : '')
          )
          publishFile(instance, project.id, 'created', entry.path)
          send({ ok: true, node: resourceNode(entry) })
          return
        }
        if (body.action === 'rename') {
          const folder = source.includes('/') ? source.slice(0, source.lastIndexOf('/')) : ''
          const entry = files.rename(source, folder ? `${folder}/${name}` : name)
          publishFile(instance, project.id, 'moved', entry.path, source)
          send({ ok: true, node: resourceNode(entry) })
          return
        }
      }
    }
    unimplemented(instance, method, path, response)
  }
  return {
    middleware(
      request: IncomingMessage,
      response: ServerResponse,
      next: (error?: unknown) => void
    ): void {
      void handle(request, response, next).catch((error) => {
        if (response.headersSent) {
          response.destroy()
          return
        }
        if (error instanceof PreviewProjectError) {
          json(response, { detail: error.code }, error.status)
          return
        }
        if (error instanceof PreviewAuthorizationError) {
          json(response, { detail: error.code }, error.status)
          return
        }
        if (error instanceof PreviewHomeError) {
          json(response, { detail: error.message }, error.status)
          return
        }
        if (error instanceof PreviewLiteratureError) {
          json(response, { detail: { code: error.code, message: error.message } }, error.status)
          return
        }
        if (error instanceof PreviewStorageError) {
          json(response, { detail: error.message }, error.status)
          return
        }
        if (error instanceof PreviewBrowsingError) {
          json(response, { detail: error.message }, error.status)
          return
        }
        if (error instanceof PreviewContentError) {
          json(response, { detail: error.code }, error.status)
          return
        }
        if (error instanceof PreviewArchiveError) {
          json(response, { detail: error.message }, error.status)
          return
        }
        if (error instanceof PreviewBrowserError) {
          json(response, { detail: error.message }, error.status)
          return
        }
        if (error instanceof PreviewArtifactsError) {
          json(response, { detail: { code: error.code } }, error.status)
          return
        }
        if (error instanceof PreviewConfigurationError) {
          json(
            response,
            { error: { code: error.message, message: error.message, details: {} } },
            error.status
          )
          return
        }
        if (error instanceof PreviewRegionError) {
          json(response, { detail: error.message }, error.status)
          return
        }
        if (error instanceof PreviewSearchError) {
          json(response, { detail: error.code }, error.status)
          return
        }
        if (error instanceof PreviewVersionError) {
          json(
            response,
            { error: { code: error.code, message: error.code, details: {} } },
            error.status
          )
          return
        }
        if (error instanceof PreviewFileError) {
          const status =
            error.code === PREVIEW_FILE_ERROR.notFound
              ? 404
              : error.code === PREVIEW_FILE_ERROR.conflict
                ? 409
                : 400
          json(response, { code: error.code, detail: error.code }, status)
          return
        }
        json(
          response,
          {
            code: error instanceof SyntaxError ? 'preview_invalid_json' : 'preview_invalid_request',
          },
          400
        )
      })
    },
    dispose(): void {
      disposed = true
      for (const instance of instances.values()) closeInstance(instance)
      instances.clear()
    },
  }
}
