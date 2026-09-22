import assert from 'node:assert/strict'
import test from 'node:test'

import type { LatestVersionMeta, UpdateSnapshot } from '../../../../updates'
import {
  formatInstallerSize,
  hasMoreReleaseNotes,
  isAnnouncementAcknowledged,
  isUpdateEntryVisible,
  releaseNoteLines,
  UPDATE_NOTES_COLLAPSED_COUNT,
  updateActionOf,
  updateFailureOf,
  updateFailureText,
  updateFailureTitle,
  updatePanelStageOf,
  visibleReleaseNotes
} from './state.ts'

// 更新入口有两个表面（工作台活动栏与 0.1 侧栏底部），PRD 第 12 条要求它们是同一个
// 任务的同一个状态。动作判定与入口可见性因此必须是纯函数、只此一份 —— 这两个测试
// 钉的就是「两个表面不会各说一套」这件事。

const CANDIDATE: LatestVersionMeta = {
  id: 'package-1',
  version: '0.2.1',
  build_number: '202608271500',
  product_id: 'scholarseed',
  bundle_id: 'com.scholarseed.desktop',
  arch_type: 'darwin-arm64',
  team_id: 'A1B2C3D4E5',
  channel: 'release',
  file_size: 564_973_100,
  sha512: 'a'.repeat(128)
}

function snapshot(phase: UpdateSnapshot['phase'], extra: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return { phase, currentVersion: '0.2.0', ...extra }
}

test('the download action is offered exactly where the main process accepts it', () => {
  // 主进程只在 available / failed 且候选包仍是当前那一个时放行下载。
  assert.equal(updateActionOf(snapshot('available', { candidate: CANDIDATE })), 'download')
  assert.equal(updateActionOf(snapshot('failed', { candidate: CANDIDATE })), 'download')
  // 检查失败时没有候选包，重试的只能是检查本身。
  assert.equal(updateActionOf(snapshot('failed')), 'check')
  assert.equal(updateActionOf(snapshot('available')), 'check')
})

test('the install action only exists once the package is staged and verified', () => {
  assert.equal(updateActionOf(snapshot('ready', { candidate: CANDIDATE })), 'install')
  // 下载完但还没校验通过时不能安装；已在下载中时也不能再发起一次下载。
  for (const phase of ['downloading', 'verifying', 'installing', 'restarting', 'manual', 'checking', 'unsupported'] as const) {
    assert.equal(updateActionOf(snapshot(phase, { candidate: CANDIDATE })), 'none', phase)
  }
})

test('a quiescent phase always offers a fresh check', () => {
  assert.equal(updateActionOf(null), 'check')
  for (const phase of ['idle', 'up-to-date', 'rolled-back'] as const) {
    assert.equal(updateActionOf(snapshot(phase)), 'check', phase)
  }
})

test('the entry stays from discovery until the update is done, and never before', () => {
  // PRD 第 1/2 条：未发现新版本时不展示；发现之后到更新完成前持续保留 —— 包括失败
  // 与回滚，那两种状态恰恰是用户最需要看见的。
  assert.equal(isUpdateEntryVisible(null), false)
  for (const phase of ['idle', 'checking', 'up-to-date', 'unsupported'] as const) {
    assert.equal(isUpdateEntryVisible(snapshot(phase)), false, phase)
  }
  for (const phase of [
    'available', 'downloading', 'verifying', 'ready', 'installing',
    'restarting', 'manual', 'failed', 'rolled-back'
  ] as const) {
    assert.equal(isUpdateEntryVisible(snapshot(phase, { candidate: CANDIDATE })), true, phase)
  }
})

test('installer sizes are reported the way Finder reports the same file', () => {
  // 十进制 MB：539 MiB 的包在访达里显示 565 MB，用 1024 进制会和用户对不上。
  assert.equal(formatInstallerSize(564_973_100), '565.0 MB')
  assert.equal(formatInstallerSize(1_500_000_000), '1.5 GB')
  assert.equal(formatInstallerSize(999_999), '999999 B')
  assert.equal(formatInstallerSize(1_000_000), '1.0 MB')
  // 取不到大小时返回空串，让界面把「· 大小」整段省掉而不是显示 NaN。
  assert.equal(formatInstallerSize(undefined), '')
  assert.equal(formatInstallerSize(0), '')
  assert.equal(formatInstallerSize(-1), '')
  assert.equal(formatInstallerSize(Number.NaN), '')
})

test('the update popup collapses every main-process phase into its three design states', () => {
  // 设计稿只画了「发现新版本 / 正在下载更新 / 新版本已就绪」三态，映射必须把校验中归
  // 下载、把安装/重启/manual 归就绪，否则弹窗会在这些相位上退回「发现新版本」重发下载。
  assert.equal(updatePanelStageOf(null), 'available')
  for (const phase of ['idle', 'checking', 'up-to-date', 'available', 'unsupported'] as const) {
    assert.equal(updatePanelStageOf(snapshot(phase, { candidate: CANDIDATE })), 'available', phase)
  }
  for (const phase of ['downloading', 'verifying'] as const) {
    assert.equal(updatePanelStageOf(snapshot(phase, { candidate: CANDIDATE })), 'downloading', phase)
  }
  for (const phase of ['ready', 'installing', 'restarting', 'manual'] as const) {
    assert.equal(updatePanelStageOf(snapshot(phase, { candidate: CANDIDATE })), 'ready', phase)
  }
  for (const phase of ['failed', 'rolled-back'] as const) {
    assert.equal(updatePanelStageOf(snapshot(phase, { candidate: CANDIDATE })), 'failed', phase)
  }
})

test('release notes collapse exactly at the designed threshold', () => {
  const notes = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `说明 ${index + 1}`)

  // 不超过 3 条：全部直接显示，「查看更多更新内容」根本不出现。
  for (const count of [0, 1, UPDATE_NOTES_COLLAPSED_COUNT]) {
    const lines = notes(count)
    assert.equal(hasMoreReleaseNotes(lines), false, `count=${count}`)
    assert.deepEqual(visibleReleaseNotes(lines, false), lines, `count=${count}`)
  }

  // 超过 3 条：收起时只给前 3 条，展开后给全部（由容器滚动）。
  const many = notes(UPDATE_NOTES_COLLAPSED_COUNT + 4)
  assert.equal(hasMoreReleaseNotes(many), true)
  assert.deepEqual(
    visibleReleaseNotes(many, false),
    many.slice(0, UPDATE_NOTES_COLLAPSED_COUNT)
  )
  assert.deepEqual(visibleReleaseNotes(many, true), many)
  // 展开与否都不许改动调用方传进来的那份要点。
  visibleReleaseNotes(many, true)
  assert.equal(many.length, UPDATE_NOTES_COLLAPSED_COUNT + 4)
})

test('release notes are split per line and blank lines are dropped', () => {
  assert.deepEqual(releaseNoteLines(undefined), [])
  assert.deepEqual(releaseNoteLines(''), [])
  assert.deepEqual(releaseNoteLines('  检索式回看\n\n  入库选分类 \n'), [
    '检索式回看',
    '入库选分类'
  ])
})

// ── 失败呈现（bug 86968393）──────────────────────────────────────────────────
// 安装失败时暂存包还在，主进程会把相位留在 `ready`。旧实现只有「版式」一维
// （updatePanelStageOf 纯按相位映射），于是 ready + error 被渲染成一切正常，用户点了
// 「重启客户端」之后既不重启也看不到任何原因。失败必须是独立的**结果**维度。

const ALL_PHASES = [
  'idle', 'checking', 'up-to-date', 'available', 'downloading', 'verifying',
  'ready', 'installing', 'restarting', 'manual', 'failed', 'rolled-back', 'unsupported'
] as const

test('any phase carrying an error is presented as a failure, ready included', () => {
  for (const phase of ALL_PHASES) {
    const failure = updateFailureOf(snapshot(phase, { error: 'installer refused', errorOrigin: 'install' }))
    assert.notEqual(failure, null, phase)
    assert.equal(failure?.message, 'installer refused', phase)
  }
})

test('the layout stage and the failure result are orthogonal dimensions', () => {
  // 用户现场：Windows 安装器验签失败 → 相位回落 ready + error。版式仍是「已就绪」，
  // 但结果必须是失败；两个维度都要如实，界面才不会二选一地骗人。
  const state = snapshot('ready', {
    candidate: CANDIDATE,
    percent: 100,
    error: 'Error: Windows installer signature differs from packaged product policy',
    errorOrigin: 'install'
  })
  assert.equal(updatePanelStageOf(state), 'ready')
  const failure = updateFailureOf(state)
  assert.equal(failure?.origin, 'install')
  assert.equal(failure?.fallback, undefined)
  assert.equal(failure?.rolledBack, false)
  // 重试的仍然是安装这一步，不是重新下载。
  assert.equal(updateActionOf(state), 'install')
})

test('a phase that declares failure still fails without an error message', () => {
  for (const phase of ['failed', 'rolled-back'] as const) {
    assert.notEqual(updateFailureOf(snapshot(phase)), null, phase)
  }
  // 其余相位不带 error 就是没有失败：不能把「检查中」渲染成告警。
  for (const phase of ALL_PHASES) {
    if (phase === 'failed' || phase === 'rolled-back') continue
    assert.equal(updateFailureOf(snapshot(phase)), null, phase)
  }
  assert.equal(updateFailureOf(null), null)
})

test('rollback is reported as its own outcome, not as a plain install failure', () => {
  assert.equal(
    updateFailureOf(snapshot('rolled-back', { rollbackVersion: '0.2.0', error: 'health confirmation timeout' }))?.rolledBack,
    true
  )
  assert.equal(
    updateFailureOf(snapshot('ready', { candidate: CANDIDATE, error: 'nope', errorOrigin: 'install' }))?.rolledBack,
    false
  )
})

test('the install fallback marker keeps its origin so the text is not blamed on the download', () => {
  const failure = updateFailureOf(snapshot('ready', {
    candidate: CANDIDATE,
    error: 'update failed',
    errorFallback: 'install_failed',
    errorOrigin: 'install'
  }))
  assert.equal(failure?.fallback, 'install_failed')
  assert.equal(failure?.origin, 'install')
  // 占位串不能直接给用户看。
  assert.equal(failure?.message, undefined)
})

// 文案映射：把 t 换成回显函数，钉住「哪个来源用哪句」而不是钉住具体字面。
function echo(prefix: string) {
  return ((key: string, options?: { error?: string }) =>
    options?.error ? `${prefix}:${key}:${options.error}` : `${prefix}:${key}`) as never
}

test('failure wording follows the action that failed', () => {
  const t = echo('c')
  const account = echo('a')
  const cases: Array<[UpdateSnapshot, string, string]> = [
    [snapshot('ready', { error: 'E', errorOrigin: 'install' }), 'c:update.titleInstallFailed', 'c:update.installFailedSub:E'],
    [snapshot('failed', { candidate: CANDIDATE, error: 'E', errorOrigin: 'download' }), 'c:update.titleFailed', 'c:update.failedSub:E'],
    [snapshot('failed', { error: 'E', errorOrigin: 'check' }), 'c:update.checkFailed', 'c:update.checkFailedSub:E'],
    [snapshot('ready', { error: 'update failed', errorFallback: 'install_failed', errorOrigin: 'install' }), 'c:update.titleInstallFailed', 'a:update.installFailed'],
    // bug 87042987：结构化分类各给一句可操作的本地化说法，且即便快照里残留 error 原文也不透出（走分类文案）。
    [snapshot('ready', { errorFallback: 'install_verify_unavailable', errorOrigin: 'install' }), 'c:update.titleInstallFailed', 'c:update.installVerifyUnavailable'],
    [snapshot('ready', { error: 'STATUS=乱码', errorFallback: 'install_signature_untrusted', errorOrigin: 'install' }), 'c:update.titleInstallFailed', 'c:update.installSignatureUntrusted'],
    // 本机不可判定（链/吊销状态）是独立分类：文案引导修复环境后重试，而不是重新下载那条死路。
    [snapshot('ready', { error: 'STATUS=NotTrusted', errorFallback: 'install_signature_indeterminate', errorOrigin: 'install' }), 'c:update.titleInstallFailed', 'c:update.installSignatureIndeterminate'],
    // 上一轮安装器还活着：独立分类，文案说清在等什么，而不是报「安装失败」诱导对着互斥量重试。
    [snapshot('ready', { errorFallback: 'install_already_running', errorOrigin: 'install' }), 'c:update.titleInstallFailed', 'c:update.installAlreadyRunning'],
    [snapshot('rolled-back', { rollbackVersion: '0.2.0', error: 'health confirmation timeout', errorOrigin: 'install' }), 'c:update.rolledBack', 'c:update.installFailedSub:health confirmation timeout']
  ]
  for (const [state, title, text] of cases) {
    const failure = updateFailureOf(state)
    assert.ok(failure)
    assert.equal(updateFailureTitle(failure, t), title)
    assert.equal(updateFailureText(failure, t, account), text)
  }
})

// ── 弹窗收起确认（bug 86968393 第二条）────────────────────────────────────────
// 确认曾经写在渲染层 localStorage，而窗口 origin 含后端随机端口，localStorage 按 origin
// 分区 → 每次启动都读不回来 → 浮窗反复自动展开。现在判据只认主进程随快照下发的 announcedKey。

test('the announcement acknowledgement comes from the snapshot, not from renderer storage', () => {
  const key = `${CANDIDATE.version}-${CANDIDATE.build_number}`
  assert.equal(isAnnouncementAcknowledged(snapshot('available', { candidate: CANDIDATE })), false)
  assert.equal(isAnnouncementAcknowledged(snapshot('available', { candidate: CANDIDATE, announcedKey: key })), true)
  // 认过的是上一个构建：新构建要重新弹一次。
  assert.equal(
    isAnnouncementAcknowledged(snapshot('available', { candidate: CANDIDATE, announcedKey: '0.2.1-202608271400' })),
    false
  )
})

test('without a candidate there is nothing to announce', () => {
  assert.equal(isAnnouncementAcknowledged(null), true)
  assert.equal(isAnnouncementAcknowledged(snapshot('up-to-date')), true)
  assert.equal(isAnnouncementAcknowledged(snapshot('available')), true)
})
