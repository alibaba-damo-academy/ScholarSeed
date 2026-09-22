import React from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import rocketGlyph from '../../assets/update-rocket.png'
import type { UpdateSnapshot } from '../../../../updates'
import {
  hasMoreReleaseNotes,
  releaseNoteLines,
  runUpdateAction,
  updateActionOf,
  updateFailureOf,
  updateFailureText,
  updateFailureTitle,
  updatePanelStageOf,
  useUpdateState,
  visibleReleaseNotes
} from '../../features/updates/state'
import { IconFont } from '../primitive'
import { Button, Divider, IconButton, ProgressBar, Tag } from '../ui'
import { cx } from '../ui/utils'
import { UpdateMetadata } from './UpdateMetadata'

// UpdatePanel.tsx — 版本更新浮窗的内容本体，工作台活动栏的火箭入口与 0.1 侧栏底部的
// 药丸入口共用这一份。
//
// 两个入口按 mainView 互斥挂载，但 PRD 第 12 条要求它们是同一个任务的同一个状态，所以
// 这里不存任何更新态：相位一律由主进程发布，动作判定走同一份 updateActionOf，不做乐观写。
//
// 本组件只拥有浮窗的视觉与内容，**不拥有定位**：调用方把它放进自己的浮层容器（活动栏走
// 设计系统 Popover，侧栏走自己的锚点），位置因此保持各入口原有的行为。
//
// 它是一条状态机而不是一次性提示：点「立即更新」不收起浮窗，留在原地把分割线换成进度条
// 看下载；下载完再变成「新版本已就绪 / 重启客户端」。只有「稍后」与右上角 × 收起浮窗，
// 且只收浮窗本身，不动更新入口与后台下载任务（PRD 第 10 条）。
//
// 三套版式各有设计稿，逐稿对齐，不互相套用：
//   summary（360，无描边）  发现新版本 / 正在下载更新… / 新版本已就绪   稿 190:18735
//   notes  （480，带描边）  点「查看更多更新内容」后的「更新内容」       稿 190:23576
//   failed （360，带描边）  更新失败                                     稿 190:23291
// 失败态优先于展开态：下载失败是最需要被看见的信息，不能藏在一个更宽的说明版式后面。
//
// 稿子只画了 available / downloading / ready / failed；verifying 与 manual 没有稿，但旧卡片
// 本来就把「正在校验安装包」和 manual 的操作指引如实报给用户，删掉等于砍能力，所以按同一
// 套排版补一行状态文本，四个设计态的版式不受影响。

type PanelView = 'failed' | 'notes' | 'summary'

const PANEL_HERO_ICON_TYPE = 'fill-status-warning'

const PANEL_BASE_CLASS_NAME = [
  'relative overflow-hidden rounded-[var(--vds-radius-8)]',
  '[background:var(--vds-bg-white-default)] shadow-[var(--vds-shadow-3-center)]'
].join(' ')
const PANEL_SUMMARY_WIDTH_CLASS_NAME = 'w-[var(--vds-update-notes-width)]'
const PANEL_NOTES_WIDTH_CLASS_NAME = 'w-[var(--vds-update-notes-expanded-width)]'
const PANEL_BORDERED_CLASS_NAME =
  'border border-[var(--vds-divider-default)] [border-style:solid] [border-width:var(--vds-border-width-1)]'
const PANEL_HEADER_CLASS_NAME =
  'relative flex items-start gap-[var(--vds-space-3)] px-[var(--vds-space-5)] pb-[12px] pt-[var(--vds-space-5)]'
// 失败稿的头部四边等距 20（高 88），与 summary 稿的 20/20/16（高 84）不同。
const PANEL_HEADER_FAILED_CLASS_NAME =
  'relative flex items-start gap-[var(--vds-space-3)] p-[var(--vds-space-5)]'
// 更新内容稿没有火箭徽标，标题与关闭按钮垂直居中，下内边距 12。
const PANEL_HEADER_NOTES_CLASS_NAME =
  'relative flex items-center gap-[var(--vds-space-3)] px-[var(--vds-space-5)] pb-[var(--vds-space-3)] pt-[var(--vds-space-5)]'
const PANEL_HERO_CLASS_NAME =
  'grid size-[42px] flex-none place-items-center rounded-[var(--vds-update-notes-hero-radius)] [background:var(--vds-bg-white-active-transparent)]'
const PANEL_HERO_GLYPH_CLASS_NAME = 'size-[20px] object-contain'
const PANEL_HERO_ICON_CLASS_NAME =
  'grid size-[20px] place-items-center !text-[20px] !leading-none text-[var(--vds-error-bg-default)]'
const PANEL_HEADING_CLASS_NAME = 'relative grid min-w-0 flex-1 gap-0'
const PANEL_TITLE_CLASS_NAME =
  'm-0 truncate !text-[16px] !font-normal leading-[var(--vds-lh-title)] !text-[var(--vds-text-primary)]'
const PANEL_VERSION_CLASS_NAME =
  'truncate text-[length:var(--vds-font-body-lv1)] font-normal leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-placeholder)] tabular-nums'
const PANEL_VERSION_MUTED_CLASS_NAME =
  'truncate text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-placeholder)] tabular-nums'
const PANEL_CLOSE_CLASS_NAME = 'relative flex-none'
// 分割线与进度条占同一条水平带（左右各 20px），下载中只换芯不换位。
const PANEL_DIVIDER_CLASS_NAME =
  'relative !w-[calc(100%_-_var(--vds-space-5)_*_2)] [--vds-divider-color:var(--vds-divider-default)] [--vds-divider-margin-horizontal:0_var(--vds-space-5)]'
const PANEL_PROGRESS_CLASS_NAME = [
  'relative mx-[var(--vds-space-5)]',
  '[--vds-progress-height:var(--vds-update-notes-progress-height)]',
  '[--vds-progress-track:var(--vds-bg-white-active-transparent)]',
  '[--vds-progress-value-color:var(--vds-brand-bg-default)]'
].join(' ')
const PANEL_BODY_CLASS_NAME =
  'relative grid gap-[var(--vds-space-6)] px-[var(--vds-space-5)] pb-[var(--vds-space-5)] pt-[var(--vds-space-4)]'
// 失败稿与更新内容稿的内容区四边等距 20；后者行距 12，前者 24。
const PANEL_BODY_FAILED_CLASS_NAME = 'relative grid gap-[var(--vds-space-6)] p-[var(--vds-space-5)]'
const PANEL_BODY_NOTES_CLASS_NAME = 'relative grid gap-[var(--vds-space-3)] p-[var(--vds-space-5)]'
// 说明区 = 要点列表 + 状态行；设计稿的大间距留在说明区与操作区之间，状态行贴着要点走
// 小间距，没有状态行时这一组的版式与设计稿完全相同。
const PANEL_NOTES_GROUP_CLASS_NAME = 'grid gap-[var(--vds-space-2)]'
const PANEL_LIST_CLASS_NAME = 'grid gap-[var(--vds-space-2)]'
// 更新内容稿行距 12，且最多露 4 行，多出的滚动看全部。
const PANEL_LIST_NOTES_CLASS_NAME =
  'grid max-h-[var(--vds-update-notes-list-max-height)] gap-[var(--vds-space-3)] overflow-y-auto'
const PANEL_ITEM_CLASS_NAME =
  'flex items-start gap-[var(--vds-update-notes-item-gap)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-secondary)]'
const PANEL_MARKER_CLASS_NAME =
  'grid h-[var(--vds-lh-body-lv2)] w-[var(--vds-update-notes-marker-width)] flex-none place-items-center'
// 设计稿的圆点是一条 PATH，API 不返回其填充；按稿内唯一可见的强调色（版本行、链接、
// 主按钮、进度条填充都是 brand-bg-default）推导为同一支品牌色。
const PANEL_DOT_CLASS_NAME =
  'size-[var(--vds-update-notes-dot-size)] rounded-[var(--vds-radius-circle)] [background:var(--vds-brand-bg-default)]'
const PANEL_EMPTY_CLASS_NAME =
  'text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-tertiary)]'
// 「查看更多更新内容」是列表的最后一行（稿内 y=90，与要点同为 8px 行距），左起 16px
// 正好与要点正文（6px 标记列 + 10px 间隔）对齐。
const PANEL_MORE_CLASS_NAME = [
  'justify-self-start px-[var(--vds-space-4)]',
  '!text-[var(--vds-brand-bg-default)]',
  '!text-[length:var(--vds-font-body-lv2)] !leading-[var(--vds-lh-body-lv2)]',
  '!no-underline hover:!underline'
].join(' ')
// 更新内容稿的版本行：说明文字用 text-placeholder，右侧跟一枚品牌 tag。
const PANEL_VERSION_ROW_CLASS_NAME = 'flex items-center gap-[var(--vds-space-2)]'
const PANEL_VERSION_ROW_TEXT_CLASS_NAME =
  'truncate text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-placeholder)]'
// Tag 的 brand 色调背景已与稿子一致(#E9EEEB)；只把描边按稿改成 brand-light-bg-hover
// (#C5DDD0)。文字保留设计系统的 --vds-brand-text-primary：稿子标的 brand-bg-default 在
// 暗色主题下是 #498e76，压在 tag 深底 #12241c 上只有 ~4.1:1，达不到小字 AA；亮色下
// 两者同为深品牌绿(#234438 vs #2C5545)，肉眼无差。覆盖必须带 important：tone 类与
// 这里写的是同一个 CSS 变量，胜负取决于 Tailwind 的生成顺序而不是 className 书写顺序。
const PANEL_TAG_CLASS_NAME = '![--vds-tag-border:var(--vds-brand-light-bg-hover)]'
const PANEL_STATUS_CLASS_NAME =
  'grid gap-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]'
const PANEL_ERROR_CLASS_NAME = [
  'grid gap-[var(--vds-space-1)] rounded-[var(--vds-radius-3)]',
  'border border-[var(--vds-warning-light-border)] [border-style:solid] [border-width:var(--vds-border-width-1)]',
  '[background:var(--vds-warning-light-bg-hover)] [padding:var(--vds-update-notes-error-padding)]',
  'text-[length:var(--vds-font-body-lv2)] font-normal leading-[var(--vds-lh-body-lv2)] text-[var(--vds-warning-bg-default)]'
].join(' ')
const PANEL_ERROR_TEXT_CLASS_NAME = 'break-all'
const PANEL_ACTIONS_CLASS_NAME = 'flex flex-row gap-[var(--vds-space-3)]'
// summary / failed 两稿的按钮等分整行；更新内容稿靠右、按内容自适应宽度。
const PANEL_ACTIONS_NOTES_CLASS_NAME =
  'flex flex-row justify-end gap-[var(--vds-space-3)]'
const PANEL_ACTION_CLASS_NAME = 'flex-1'

export interface UpdatePanelProps {
  /** 收起浮窗。只收浮窗本身，不取消更新提示、下载任务或已完成的下载（PRD 第 2 条）。 */
  onDismiss: () => void
}

export function UpdatePanel({ onDismiss }: UpdatePanelProps): React.JSX.Element {
  const { t: accountUpdateText } = useTranslation('account')
  const { t } = useTranslation('components')
  const { t: uiText } = useTranslation('ui')
  const state = useUpdateState()
  // 展开只在本次打开内有效：换了候选包就回到设计稿默认的三条。浮窗收起即卸载，
  // 所以下次打开天然从收起态开始。
  const [expanded, setExpanded] = React.useState(false)
  const candidateId = state?.candidate?.id
  const titleId = React.useId()

  React.useEffect(() => {
    setExpanded(false)
  }, [candidateId])

  // 卡片被打开时静默刷新一次（与背景检查同一路径，不进 'checking' 相位、不闪按钮）：
  // 上一次检查之后线上新发布的包会在用户点「重启完成更新」之前由主进程 supersede 推进，
  // 安装点击本身保持秒级、可预测。两个入口表面（工作台活动栏火箭、0.1 侧栏药丸）都只在
  // 展开时渲染本组件，挂这一处即同时覆盖。StrictMode 下重复触发无害：静默检查幂等，
  // 主进程侧 in-flight 闸与安装失败结果保护都在投影点里。
  React.useEffect(() => {
    void window.scholarseed.refreshUpdate()
  }, [])

  const candidate = state?.candidate
  const phase: UpdateSnapshot['phase'] = state?.phase ?? 'idle'
  const stage = updatePanelStageOf(state)
  const action = updateActionOf(state)
  const downloading = stage === 'downloading'
  // stage 是**版式**维度（设计稿的三套），failure 是**结果**维度，两者正交：安装失败时
  // 暂存包还在，主进程会把相位留在 ready，于是 stage 仍是 'ready' 而结果已经失败。失败
  // 版式必须由结果驱动，否则用户点完「重启客户端」看到的还是一切正常（bug 86968393）。
  const failure = updateFailureOf(state)
  const failed = failure !== null
  const notes = releaseNoteLines(candidate?.release_notes)
  const showMore = hasMoreReleaseNotes(notes) && !expanded
  // 失败态优先于展开态：失败信息不该被藏在更宽的说明版式后面。
  const view: PanelView = failed ? 'failed' : expanded ? 'notes' : 'summary'

  let title: string = t('update.titleAvailable')
  if (view === 'notes') title = t('update.notesTitle')
  else if (failure) title = updateFailureTitle(failure, t)
  else if (downloading) title = t('update.titleDownloading')
  else if (stage === 'ready') title = t('update.titleReady')

  // 「稍后更新」只在 summary 版式且还没开始下载时说全；其余场合动作就只是收起浮窗。
  const secondaryLabel =
    view === 'summary' && stage === 'available' ? t('update.laterUpdate') : t('update.later')

  // 主按钮文案一律由**实际会执行的那个动作**决定，不由相位/版式推：rolled-back 归在失败
  // 态里，但 updateActionOf 给的是 check 而不是 download，按 failed 取文案就会摆一个写着
  // 「重试下载」、点了却去做检查更新的按钮。文案与行为共用 action 这一个真源，才不会分叉。
  let primaryLabel: string = t('update.check')
  if (downloading) primaryLabel = t('update.updating')
  else if (action === 'install') primaryLabel = t('update.restartClient')
  else if (action === 'download')
    primaryLabel = failed ? t('update.retryDownload') : t('update.now')

  // 下载/校验中按设计稿保留主按钮但禁用（文案「更新中」）；安装、重启、manual 这些没有
  // 可发起动作的相位直接不渲染主按钮，免得摆一个永远点不动的「重启客户端」。
  const showPrimary = downloading || action !== 'none'

  // 设计稿没画的相位仍要如实说明处境：校验中、manual 的操作指引。
  let status: string | null = null
  if (phase === 'verifying') status = t('update.verifying')
  else if (phase === 'manual') status = t('update.manualHint')

  const runPrimary = (): void => {
    // 下载留在浮窗里看进度（分割线换进度条）。安装期间全屏遮罩（z-loading 9000）盖住
    // 浮窗，所以不收起也没有视觉差别；而一旦安装失败，相位会带着 error 回到 ready，
    // 遮罩消失时浮窗还在原地，失败原因就地可见。发起动作前先收起浮窗，等于把唯一的
    // 结果表面在结果出来之前丢掉（bug 86968393）。
    runUpdateAction(state)
  }

  const noteItems = (
    visibleReleaseNotes(notes, expanded).map((note, index) => (
      // 要点是服务端自由文本，可能整行重复，所以按位置而不是按文本做 key。
      <span className={PANEL_ITEM_CLASS_NAME} key={index}>
        <span aria-hidden className={PANEL_MARKER_CLASS_NAME}>
          <span className={PANEL_DOT_CLASS_NAME} />
        </span>
        <span>{note}</span>
      </span>
    ))
  )

  return (
    <div
      aria-labelledby={titleId}
      className={cx(
        PANEL_BASE_CLASS_NAME,
        view === 'notes' ? PANEL_NOTES_WIDTH_CLASS_NAME : PANEL_SUMMARY_WIDTH_CLASS_NAME,
        view !== 'summary' && PANEL_BORDERED_CLASS_NAME
      )}
      data-testid="update-panel"
      data-view={view}
      role="group"
    >

      <div
        className={
          view === 'notes'
            ? PANEL_HEADER_NOTES_CLASS_NAME
            : failed
              ? PANEL_HEADER_FAILED_CLASS_NAME
              : PANEL_HEADER_CLASS_NAME
        }
      >
        {/* 徽标是装饰性的，不是控件：设计稿用 Button 实例只是画了个圆角底座。
            summary 稿是火箭，failed 稿换成告警图标，notes 稿没有徽标。 */}
        {view === 'summary' && (
          <span aria-hidden className={PANEL_HERO_CLASS_NAME}>
            <img alt="" className={PANEL_HERO_GLYPH_CLASS_NAME} src={rocketGlyph} />
          </span>
        )}
        {view === 'failed' && (
          <span aria-hidden className={PANEL_HERO_CLASS_NAME}>
            <IconFont className={PANEL_HERO_ICON_CLASS_NAME} type={PANEL_HERO_ICON_TYPE} />
          </span>
        )}

        <span className={PANEL_HEADING_CLASS_NAME}>
          <h2 className={PANEL_TITLE_CLASS_NAME} data-testid="update-panel-title" id={titleId}>
            {title}
          </h2>
          {/* notes 稿把版本行挪进内容区并配「新版本」tag，头部只留标题。 */}
          {view !== 'notes' && candidate && (
            <span
              className={failed ? PANEL_VERSION_MUTED_CLASS_NAME : PANEL_VERSION_CLASS_NAME}
              data-testid="update-panel-version"
            >
              <UpdateMetadata candidate={candidate} />
            </span>
          )}
        </span>

        <IconButton
          className={PANEL_CLOSE_CLASS_NAME}
          data-testid="update-panel-close"
          icon={<X />}
          label={uiText('close')}
          onClick={onDismiss}
          size="md"
          variant="ghostIcon"
        />
      </div>

      {downloading ? (
        <ProgressBar
          className={PANEL_PROGRESS_CLASS_NAME}
          data-testid="update-panel-progress"
          value={state?.percent ?? 0}
        />
      ) : (
        <Divider className={PANEL_DIVIDER_CLASS_NAME} data-testid="update-panel-divider" />
      )}

      {view === 'failed' && (
        <div className={PANEL_BODY_FAILED_CLASS_NAME}>
          <span className={PANEL_ERROR_CLASS_NAME}>
            <span className={PANEL_ERROR_TEXT_CLASS_NAME} data-testid="update-panel-error">
              {failure && updateFailureText(failure, t, accountUpdateText)}
            </span>
            {candidate && phase === 'failed' && (
              <span data-testid="update-panel-resumable">
                {state?.resumable === false
                  ? t('update.failedDiscarded')
                  : t('update.failedRetained')}
              </span>
            )}
            {/* 安装失败但暂存包还在（相位停在 ready）：把「包还在、重试的是安装」补回来，
                否则用户以为要重新下载几百 MB。 */}
            {stage === 'ready' && (
              <span data-testid="update-panel-retry-hint">
                {t('update.installRetryHint')}
              </span>
            )}
          </span>

          <div className={PANEL_ACTIONS_CLASS_NAME}>
            <Button
              className={PANEL_ACTION_CLASS_NAME}
              data-testid="update-panel-dismiss"
              onClick={onDismiss}
              variant="outline"
            >
              {secondaryLabel}
            </Button>
            {showPrimary && (
              <Button
                className={PANEL_ACTION_CLASS_NAME}
                data-testid="update-panel-action"
                onClick={runPrimary}
                variant="danger"
              >
                {primaryLabel}
              </Button>
            )}
          </div>
        </div>
      )}

      {view === 'notes' && (
        <div className={PANEL_BODY_NOTES_CLASS_NAME}>
          {candidate && (
            <span className={PANEL_VERSION_ROW_CLASS_NAME}>
              <span
                className={PANEL_VERSION_ROW_TEXT_CLASS_NAME}
                data-testid="update-panel-version"
              >
                <UpdateMetadata candidate={candidate} />
              </span>
              <Tag className={PANEL_TAG_CLASS_NAME} data-testid="update-panel-tag" tone="brand">
                {t('update.notesNewTag')}
              </Tag>
            </span>
          )}

          <div className={PANEL_LIST_NOTES_CLASS_NAME} data-testid="update-panel-list">
            {notes.length > 0 ? (
              noteItems
            ) : (
              <span className={PANEL_EMPTY_CLASS_NAME}>{t('update.notesEmpty')}</span>
            )}
          </div>

          {status && (
            <span className={PANEL_STATUS_CLASS_NAME} data-testid="update-panel-hint">
              {status}
            </span>
          )}

          <div className={PANEL_ACTIONS_NOTES_CLASS_NAME}>
            <Button
              data-testid="update-panel-dismiss"
              disabled={downloading}
              onClick={onDismiss}
              variant="outline"
            >
              {secondaryLabel}
            </Button>
            {showPrimary && (
              <Button
                data-testid="update-panel-action"
                disabled={downloading}
                onClick={runPrimary}
                variant="primary"
              >
                {primaryLabel}
              </Button>
            )}
          </div>
        </div>
      )}

      {view === 'summary' && (
        <div className={PANEL_BODY_CLASS_NAME}>
          <div className={PANEL_NOTES_GROUP_CLASS_NAME}>
            <div className={PANEL_LIST_CLASS_NAME} data-testid="update-panel-list">
              {notes.length > 0 ? (
                noteItems
              ) : (
                <span className={PANEL_EMPTY_CLASS_NAME}>{t('update.notesEmpty')}</span>
              )}

              {showMore && (
                <Button
                  className={PANEL_MORE_CLASS_NAME}
                  data-testid="update-panel-more"
                  onClick={() => setExpanded(true)}
                  variant="link"
                >
                  {t('update.viewMoreNotes')}
                </Button>
              )}
            </div>

            {status && (
              <span className={PANEL_STATUS_CLASS_NAME} data-testid="update-panel-hint">
                {status}
              </span>
            )}
          </div>

          <div className={PANEL_ACTIONS_CLASS_NAME}>
            <Button
              className={PANEL_ACTION_CLASS_NAME}
              data-testid="update-panel-dismiss"
              disabled={downloading}
              onClick={onDismiss}
              variant="outline"
            >
              {secondaryLabel}
            </Button>
            {showPrimary && (
              <Button
                className={PANEL_ACTION_CLASS_NAME}
                data-testid="update-panel-action"
                disabled={downloading}
                onClick={runPrimary}
                variant="primary"
              >
                {primaryLabel}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
