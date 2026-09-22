/**
 * 客户端更新领域状态（MVP 0.2）。
 *
 * 归属：项目与桌面文件运行时。线上契约在 `src/updates.ts`，这里只负责渲染层的
 * **一份**订阅与两个表面共用的判定。
 *
 * 为什么状态不能存在组件里：首页活动栏的更新入口、更新卡与设置页「关于书深」的
 * 当前版本行必须显示同一个任务的同一个状态（PRD 第 12 条），而它们挂载/卸载的时机
 * 互不相干 —— 设置弹层打开时活动栏那一侧可能根本没挂载。各自 useState 就等于各存
 * 一份，谁先谁后取决于挂载顺序。主进程是唯一的权威，这里只做一次投影。
 *
 * 推论（bug 86968393 踩过）：**渲染层不得持有任何跨启动的更新状态**。窗口 origin 含
 * 后端随机端口（main 侧 `listen(0)`），localStorage 按 origin 分区，写在这里的东西下次
 * 启动必然读不回来。要跨重启的一律交主进程落盘，随快照下发。
 */

import type { TFunction } from 'i18next'
import { useState, useSyncExternalStore } from 'react'

import {
  updateCandidateKey,
  type UpdateErrorOrigin,
  type UpdateInstallFallback,
  type UpdateSnapshot
} from '../../../../updates.ts'

type Listener = () => void

const listeners = new Set<Listener>()
let snapshot: UpdateSnapshot | null = null
let detach: (() => void) | null = null

function emit(): void {
  for (const listener of listeners) listener()
}

function attach(): () => void {
  // 先拉一次当前值再挂订阅：主进程只在状态变化时广播，光等广播会一直停在 null。
  void window.scholarseed.getUpdateState().then((next) => {
    snapshot = next
    emit()
  })
  return window.scholarseed.onUpdateState((next) => {
    snapshot = next
    emit()
  })
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  if (!detach) detach = attach()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && detach) {
      detach()
      detach = null
    }
  }
}

function readSnapshot(): UpdateSnapshot | null {
  return snapshot
}

/** 权威更新状态；主进程还没回答过时是 null，界面按「未检查」渲染。 */
export function useUpdateState(): UpdateSnapshot | null {
  return useSyncExternalStore(subscribe, readSnapshot, readSnapshot)
}

/** 当前相位下用户能发起的那一个动作。 */
export type UpdateAction = 'check' | 'download' | 'install' | 'none'

/**
 * 两个表面共用同一份动作判定，才不会一个给「重试下载」另一个给「检查更新」。
 *
 * 口径与主进程的放行条件严格对齐：下载只在 available / failed 且有候选包时可发起，
 * 安装只在 ready 时可发起。local lane 的 unsupported 不在这里给动作 —— 只读诊断由
 * 「关于书深」那一行自己持有（它要在本地展示诊断输出），更新卡根本不渲染该相位。
 */
export function updateActionOf(state: UpdateSnapshot | null): UpdateAction {
  if (!state) return 'check'
  switch (state.phase) {
    case 'ready':
      return 'install'
    case 'available':
    case 'failed':
      return state.candidate ? 'download' : 'check'
    case 'checking':
    case 'downloading':
    case 'verifying':
    case 'installing':
    case 'restarting':
    case 'manual':
    case 'unsupported':
      return 'none'
    case 'idle':
    case 'up-to-date':
    case 'rolled-back':
      return 'check'
  }
}

/**
 * 发起当前相位对应的那一个动作。
 *
 * 不做任何本地乐观写：相位一律等主进程发布回来，两个入口因此天然同步（PRD 第 12 条）。
 */
export function runUpdateAction(state: UpdateSnapshot | null): void {
  const action = updateActionOf(state)
  const id = state?.candidate?.id
  if (action === 'download' && id) void window.scholarseed.startUpdate(id)
  else if (action === 'install') void window.scholarseed.installUpdate()
  else if (action === 'check') void window.scholarseed.checkUpdate()
}

/** 更新入口是否该常驻：从发现新版本到更新完成前一直保留（PRD 第 2 条）。 */
export const UPDATE_ENTRY_PHASES: ReadonlySet<UpdateSnapshot['phase']> = new Set([
  'available',
  'downloading',
  'verifying',
  'ready',
  'installing',
  'restarting',
  'manual',
  'failed',
  'rolled-back'
])

export function isUpdateEntryVisible(state: UpdateSnapshot | null): boolean {
  return state !== null && UPDATE_ENTRY_PHASES.has(state.phase)
}

// 安装包体积按十进制 MB 报，与访达对同一个文件显示的数字一致。
const DECIMAL_MB = 1_000_000
const DECIMAL_GB = 1_000_000_000

export function formatInstallerSize(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes >= DECIMAL_GB) return `${(bytes / DECIMAL_GB).toFixed(1)} GB`
  if (bytes >= DECIMAL_MB) return `${(bytes / DECIMAL_MB).toFixed(1)} MB`
  return `${bytes} B`
}

/**
 * 更新说明的要点行。
 *
 * 服务端的 release_notes 是一段自由文本（管理台手工录入），产品面按行呈现要点，
 * 所以在这里按换行切分并丢掉空行。两个表面共用同一份切分，卡片摘要与「更新内容」
 * 弹窗才不会一个分行一个整段。
 */
export function releaseNoteLines(notes: string | undefined): string[] {
  if (!notes) return []
  return notes
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * 弹窗默认只给三条要点（设计稿 190:18735），多出的收在「查看更多更新内容」后面。
 *
 * 放在领域层而不是组件里：条数阀值是产品规则，不是某个页面的排版细节，跟
 * releaseNoteLines 一样属于「更新说明怎么投影给界面」。
 */
export const UPDATE_NOTES_COLLAPSED_COUNT = 3

/** 要点是否多到需要「查看更多更新内容」；不超过阀值时该链接根本不渲染。 */
export function hasMoreReleaseNotes(notes: readonly string[]): boolean {
  return notes.length > UPDATE_NOTES_COLLAPSED_COUNT
}

/** 当前该渲染哪几条要点：未展开且超出阀值时只给前几条，展开后给全部并交给容器滚动。 */
export function visibleReleaseNotes(notes: readonly string[], expanded: boolean): string[] {
  if (expanded || !hasMoreReleaseNotes(notes)) return [...notes]
  return notes.slice(0, UPDATE_NOTES_COLLAPSED_COUNT)
}

/**
 * 「发现新版本」弹窗的呈现阶段。
 *
 * 设计稿只给了三个状态（发现新版本 / 正在下载更新 / 新版本已就绪），而主进程的相位比
 * 这细：校验中仍属于「下载没结束」（进度条继续显示），安装/重启/manual 都属于「包已就
 * 绪」（分割线恢复、等用户重启），失败单独一档以便把错误如实报出来。映射只此一份，
 * 弹窗才不会自己再发明一套相位语义。
 */
export type UpdatePanelStage = 'available' | 'downloading' | 'ready' | 'failed'

export function updatePanelStageOf(state: UpdateSnapshot | null): UpdatePanelStage {
  switch (state?.phase) {
    case 'downloading':
    case 'verifying':
      return 'downloading'
    case 'ready':
    case 'installing':
    case 'restarting':
    case 'manual':
      return 'ready'
    case 'failed':
    case 'rolled-back':
      return 'failed'
    case 'idle':
    case 'checking':
    case 'up-to-date':
    case 'available':
    case 'unsupported':
    case undefined:
      return 'available'
  }
}

/**
 * 一次失败的呈现所需的全部事实；`null` = 当前没有失败。
 *
 * 这是**结果**维度，与 `updatePanelStageOf` 的**版式**维度正交，两者不能互相替代：
 * 安装失败时暂存包还在，主进程会把相位留在 `ready`（用户要重试的是安装这一步），
 * 于是版式仍是「已就绪」而结果已经是失败。旧实现只有版式一维，用户点了「重启完成
 * 更新」之后界面对失败一无所知（bug 86968393）。
 */
export interface UpdateFailure {
  /** 失败来自哪一次动作；展示侧据此选文案，不从相位或 error 文本反推。 */
  origin: UpdateErrorOrigin | undefined
  /**
   * 主进程标注的结构化失败分类；`undefined` = 不是分类失败（可能有 `message` 原文）。
   * 带分类时**没有** `message`：原始诊断（Windows 控制台代码页下的中文 stderr）会乱码，只落
   * update.log，界面按分类给本地化说法（bug 87042987）。
   */
  fallback?: UpdateInstallFallback
  /** 新版本已经装上又退了回来：这是独立结局，文案与「没装成」不同。 */
  rolledBack: boolean
  /** 协议级诊断原文。 */
  message?: string
}

export function updateFailureOf(state: UpdateSnapshot | null): UpdateFailure | null {
  if (!state) return null
  const rolledBack = state.phase === 'rolled-back' || state.rollbackVersion !== undefined
  if (state.errorFallback) {
    return { origin: state.errorOrigin, fallback: state.errorFallback, rolledBack }
  }
  if (state.error) {
    return { origin: state.errorOrigin, rolledBack, message: state.error }
  }
  // 相位自己说失败了却没带原因（回滚记录被截断之类）：仍按失败呈现，不能装作一切正常。
  if (state.phase === 'failed' || rolledBack) {
    return { origin: state.errorOrigin, rolledBack }
  }
  return null
}

/** 失败标题：按动作来源选，「下载失败」与「安装失败」是两件不同的事。 */
export function updateFailureTitle(
  failure: UpdateFailure,
  t: TFunction<'components'>
): string {
  if (failure.rolledBack) return t('update.rolledBack')
  if (failure.origin === 'install') return t('update.titleInstallFailed')
  if (failure.origin === 'download') return t('update.titleFailed')
  return t('update.checkFailed')
}

/** 失败原因正文。文案键一律写成字面量：i18n 门禁按调用点的字面键校验资源是否齐全。 */
export function updateFailureText(
  failure: UpdateFailure,
  t: TFunction<'components'>,
  accountText: TFunction<'account'>
): string {
  // 结构化分类失败：按类别给可操作的本地化说法，绝不透出原始诊断（Windows 控制台代码页下会乱码，
  // 见 bug 87042987）。校验环境不可用 → 引导手动下载重装；签名不可信 → 安全拦截、引导官方渠道重取；
  // 本机不可判定 → 包字节与签名者都对、缺的是本机链/吊销状态，引导修复环境后重试而非重新下载。
  if (failure.fallback === 'install_verify_unavailable') return t('update.installVerifyUnavailable')
  if (failure.fallback === 'install_signature_untrusted') return t('update.installSignatureUntrusted')
  if (failure.fallback === 'install_signature_indeterminate') return t('update.installSignatureIndeterminate')
  // 上一轮安装器还活着：重试只会被安装器互斥量 Abort，文案说明在等什么而不是报失败。
  if (failure.fallback === 'install_already_running') return t('update.installAlreadyRunning')
  // 笼统 fallback 或拿不到诊断原文时退回通用说法：安装类走 account 命名空间那句既有文案，其余按检查失败报。
  if (failure.fallback || !failure.message) {
    return failure.origin === 'install'
      ? accountText('update.installFailed')
      : t('update.checkFailed')
  }
  if (failure.origin === 'install') return t('update.installFailedSub', { error: failure.message })
  if (failure.origin === 'download') return t('update.failedSub', { error: failure.message })
  return t('update.checkFailedSub', { error: failure.message })
}

/**
 * 「发现新版本」弹窗是否已经被用户收起过。
 *
 * PRD：每次检测到新版本默认先给弹窗，用户收起或关闭后不再弹，只保留活动栏的常驻
 * 入口。按 version+build_number 记，所以同一版本的下一次构建会重新弹一次；没有候选
 * 包时无从弹起，按已处理算。
 *
 * 确认由主进程持有并随快照下发（`announcedKey`），不在渲染层落任何存储 —— 见文件头。
 */
export function isAnnouncementAcknowledged(state: UpdateSnapshot | null): boolean {
  const key = updateCandidateKey(state?.candidate)
  if (!key) return true
  return state?.announcedKey === key
}

/** 收起确认。身份由主进程按当前候选自己算，这里不传参数。 */
export function acknowledgeAnnouncement(): void {
  void window.scholarseed.acknowledgeUpdateAnnouncement()
}

export interface UpdateAnnouncement {
  /** 这个候选包还没被用户收起过：为 true 时入口应自动展开一次浮窗。 */
  pending: boolean
  /** 记下「用户已经收起过这个候选包」，之后不再自动展开。 */
  acknowledge: () => void
}

/**
 * 「发现新版本」的首次自动提示。
 *
 * PRD：每次检测到新版本默认先给弹窗，用户收起或关闭后不再自动弹，之后只保留活动栏
 * 的常驻入口。按 version+build_number 记，所以同一版本的下一次构建会重新弹一次。
 * 工作台活动栏与 0.1 侧栏底部按 mainView 互斥挂载，两边各自调用不会重复弹。
 *
 * 这里只回答「该不该自动展开」，不持有浮窗的开关：浮窗已经收敛为入口自己的锚定
 * 弹层（不再有独立的居中模态），开关归调用方，两边才能各自保持原有的位置行为。
 */
export function useUpdateAnnouncement(): UpdateAnnouncement {
  const state = useUpdateState()
  const key = updateCandidateKey(state?.candidate)
  const [ackedKey, setAckedKey] = useState<string | null>(null)

  // 权威确认在主进程（落盘后随快照下发），而 ack 是一次异步 IPC：本地再记一份已收起的
  // 键，收起后 pending 立刻转 false，不必等快照回来，也不会因为读回旧值把浮窗弹回去。
  const pending = key !== null && ackedKey !== key && !isAnnouncementAcknowledged(state)

  return {
    pending,
    acknowledge: () => {
      if (!key) return
      acknowledgeAnnouncement()
      setAckedKey(key)
    }
  }
}
