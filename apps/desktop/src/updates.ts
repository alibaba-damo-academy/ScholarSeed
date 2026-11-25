// updates.ts — the desktop update wire contract.
//
// Shared by the main process (which parses and owns update state) and the renderer
// (which projects it). It deliberately holds only data shapes plus pure helpers over
// them: no Node, Electron or product-policy imports, so both tsconfig projects can
// list it.

export const UPDATE_HEALTH_CHANNEL = 'scholarseed:update-workbench-ready'
export const UPDATE_REPAIR_CHANNEL = 'scholarseed:update-repair'

// 渠道集合放在共享契约：main 的产品配置校验与 renderer 的关于页展示消费同一份
// 字面量，避免跨进程边界各写一遍 'preview'。
export const UPDATE_CHANNELS = ['preview', 'release'] as const
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number]
export const PREVIEW_UPDATE_CHANNEL: UpdateChannel = 'preview'

// 产品决策：只有 preview 渠道在关于页自报渠道，release 保持无标签。
export function isPreviewUpdateChannel(channel: string): boolean {
  return channel === PREVIEW_UPDATE_CHANNEL
}

export const PREVIEW_UPDATE_SCOPES = ['current-line', 'current-version'] as const
export type PreviewUpdateScope = (typeof PREVIEW_UPDATE_SCOPES)[number]
export interface PreviewUpdatePolicy {
  scope: PreviewUpdateScope
  target?: LatestVersionMeta
}
export interface PreviewUpdateLine {
  line: string
  latest: LatestVersionMeta
}
export const PREVIEW_UPDATE_IPC = {
  get: 'scholarseed:preview-policy-get',
  scope: 'scholarseed:preview-policy-scope',
  lines: 'scholarseed:preview-policy-lines',
  select: 'scholarseed:preview-policy-select',
  cancel: 'scholarseed:preview-policy-cancel',
} as const

export const MACOS_UPDATE_ZIP = 'macos-zip'

/** Release identity as the update service reports it. */
export interface LatestVersionMeta {
  id: string
  version: string
  build_number: string
  product_id: string
  bundle_id: string
  arch_type: string
  team_id?: string
  channel: string
  file_size: number
  sha512: string
  artifact_kind?: typeof MACOS_UPDATE_ZIP
  version_built_at?: string
  /**
   * 「本次更新了什么」，由管理台在发布后人工录入，不是构建产物的一部分。
   * 服务端没填就没有这个键 —— 更新面必须按无摘要降级渲染，不能当错误。
   */
  release_notes?: string
  /** Optional English summary; older services and historical rows may omit it. */
  release_notes_en?: string
}

export interface UpdateCheckResult {
  has_update: boolean
  latest: LatestVersionMeta | null
  /** Main-only policy epoch; never trusted from HTTP. */
  previewRevision?: number
  /** Main-only check generation; invalidated replies cannot restore rejected candidates. */
  checkRevision?: number
}

export interface DownloadInfo extends LatestVersionMeta {
  download_url: string
  /** Ephemeral transport details, validated against the selected ZIP before use. */
  macos_zip_components?: unknown
}

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'preparing'
  // This process holds the matching native preparation receipt and may request restart.
  // Retained package bytes can be reused after restart, but cannot restore readiness on their own.
  | 'ready'
  | 'installing'
  | 'restarting'
  | 'manual'
  | 'failed'
  | 'rolled-back'
  | 'unsupported'

export type UpdateInstallStage = 'preparing' | 'copying' | 'handoff' | 'restarting'

export type UpdateInstallStep =
  | 'package'
  | 'image'
  | 'mounts'
  | 'mounting'
  | 'identity'
  | 'signature'
  | 'gatekeeper'
  | 'notarization'
  | 'publisher'
  | 'staging-cleanup'
  | 'copying'
  | 'cleanup'
  | 'helper'
  | 'saving'
  | 'restarting'

/** Main-owned timestamps survive renderer remounts; timeout is a limit, never an ETA. */
export interface UpdateInstallation {
  step: UpdateInstallStep
  startedAt: number
  stepStartedAt: number
  timeoutMs?: number
  application?: 'source' | 'staged'
  cancelling: boolean
}

/**
 * 失败来自哪一次用户动作。
 *
 * 相位说的是「任务此刻在做什么」，不是「上一次动作的结果」：安装失败时暂存包还在，
 * 相位必须留在 `ready`（用户要重试的是安装这一步），于是 `ready` + error 是一个合法
 * 组合。界面因此既不能从相位推断有没有失败，也不能从相位推断失败来自哪一次动作 ——
 * 展示侧要按动作来源选文案（「下载失败」与「安装失败」是两件事），所以来源由主进程
 * 显式标注，与 `errorFallback` 同一条原则：绝不从 error 文本反推。
 */
export type UpdateErrorOrigin = 'check' | 'download' | 'preparation' | 'install'

/**
 * Main-process failure classification for localized update messages. Keep
 * native diagnostics in logs and pass only the classification to the renderer.
 */
export type UpdateInstallFallback =
  | 'download_failed'
  | 'storage_exhausted'
  | 'install_failed'
  | 'install_verification_failed'
  | 'install_verify_unavailable'
  | 'install_archive_limit'
  | 'install_disk_space'
  | 'install_signature_untrusted'
  | 'install_notarization_indeterminate'
  | 'install_in_use'
  | 'install_occupancy_unknown'
  | 'preparation_connection_closed'
  | 'launcher_maintenance_required'
  | 'preparation_failed'
  | 'activation_unavailable'
  | 'activation_candidate_changed'
  | 'activation_recovery_required'
  | 'preparation_unverified'
  | 'activation_authorization_required'

/**
 * 主进程内部 updater → shell 的进度回调形状，不过 IPC 桥。
 *
 * 渲染层只读 UpdateSnapshot 这一个权威状态：shell 收到进度就把它并进快照再广播，
 * 所以再开一条并行的进度通道只会让两个表面各说一套。
 */
export interface UpdateProgress {
  phase: 'downloading' | 'verifying' | 'preparing' | 'installing'
  percent?: number
  /** 已落盘字节数。总量不重复携带 —— 它就是 candidate.file_size。 */
  receivedBytes?: number
  install_stage?: UpdateInstallStage
  installation?: UpdateInstallation
}

export interface UpdateSnapshot {
  startupVerification?: 'starting' | 'verified'
  repairAvailable?: boolean
  /** Explicit origin of an application-generated fallback; never inferred from error text. */
  errorFallback?: UpdateInstallFallback
  phase: UpdatePhase
  currentVersion: string
  /** User requested restart; the prepared release is pinned until this attempt ends. */
  restartPending?: boolean
  /** A user-requested restart is preparing without blocking the Workbench. */
  restartPreparing?: boolean
  checkedAt?: number
  candidate?: LatestVersionMeta
  latestCandidate?: LatestVersionMeta
  /** First ready candidate in an uninterrupted chain of native macOS promotions. */
  readyOrigin?: string
  nextBackgroundPreparationAt?: number
  percent?: number
  receivedBytes?: number
  installStage?: UpdateInstallStage
  installation?: UpdateInstallation
  error?: string
  /** `error` 来自哪一次动作；展示侧据此选文案，不从相位或 error 文本反推。 */
  errorOrigin?: UpdateErrorOrigin
  /**
   * 下载失败时部分安装包是否留着、能不能从断点续传。PRD 要求失败态明确说明
   * 「已下载内容是否保留」，这是界面无法从别处推导的事实。
   */
  resumable?: boolean
  rollbackVersion?: string
  reason?: string
  /**
   * 用户已经主动查看或确认的候选身份（`<version>-<build_number>`）。
   *
   * 必须由主进程持有并落盘：渲染层的 origin 含后端随机端口（`listen(0)`），
   * localStorage 按 origin 分区，写在渲染层的确认每次启动都读不回来，入口会反复显示未读。
   */
  announcedKey?: string
}

/** Why a release lane cannot consume updates; surfaced verbatim to the update surface. */
export const LOCAL_LANE_UPDATE_REASON = 'local-lane'
export const UNSUPPORTED_UPDATE_ARCH = 'unsupported-architecture'

/**
 * 候选版本的稳定身份，入口未读确认和安装动作按它识别具体构建。
 *
 * 主进程写、渲染层比对，两边必须是同一份定义，否则确认永远对不上。带 build_number 是
 * 有意的：同一 version 的下一次构建是新候选，但仅更新入口状态，不自动弹窗。无候选返回 null。
 */
export function updateCandidateKey(candidate: LatestVersionMeta | undefined): string | null {
  return candidate ? `${candidate.version}-${candidate.build_number}` : null
}

/** Identity fields the update check compares against the packaged product policy. */
export type UpdateIdentityField = 'product_id' | 'bundle_id' | 'arch_type' | 'channel' | 'team_id'

/** Read-only view of one update check: the server identity next to the packaged policy. */
export interface UpdateDiagnosis {
  url: string
  releaseLane: string
  policy: {
    productId: string
    bundleId: string
    expectedTeamId: string
    channel: string
  }
  server: {
    version: string
    buildNumber: string
    productId: string
    bundleId: string
    teamId: string
    channel: string
    archType: string
  } | null
  mismatches: UpdateIdentityField[]
  error?: string
}

export interface StartUpdateResult {
  ok: boolean
  cancelled?: boolean
  mode?: 'auto' | 'manual'
  error?: string
  /**
   * Classified failures carry only the code. The renderer uses it to select
   * localized guidance, while diagnostics remain in the update logs.
   */
  errorFallback?: UpdateInstallFallback
}
