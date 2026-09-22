import React from 'react'
import { useTranslation } from 'react-i18next'

import rocketGlyph from '../../assets/update-rocket.png'
import {
  isUpdateEntryVisible,
  updateFailureOf,
  useUpdateAnnouncement,
  useUpdateState
} from '../../features/updates/state'
import { IconButton, Popover, PopoverContent, PopoverTrigger, ProgressBar, Tooltip } from '../ui'
import { UpdatePanel } from './UpdatePanel'

// UpdateEntry.tsx — 活动栏底部的「更新」入口（PRD 第 1-7 条）。
//
// 入口在通知与头像之上、更新完成前常驻；未发现新版本时整个入口不渲染，用户仍可从
// 「关于书深」手动检查。
//
// 表达方式与活动栏其它条目一致：一枚设计系统的 IconButton（lg 档 = 栏内 40px 命中区），
//
// 首次检测到新版本时弹窗与卡片一起打开（PRD 第 1 条的「右侧打开状态」+「更新内容」
// 行的「默认先给弹窗」）；用户关掉弹窗后卡片留在原位，之后只剩这个常驻入口。

// z 高于 tooltip：活动栏在 tooltip 打开时会把自身抬到 --vds-z-tooltip（见 ActivityRail），
// 本弹层仍挂在栏上触发，若停在 popover 带会被栏盖掉一角。
//
// 这里只做定位，**不定宽、不画视觉**：宽度由 UpdatePanel 按版式自己决定（summary/failed
// 是 360，展开的「更新内容」是 480），底色/圆角/投影也归它自己；容器再画一层就会出现
// 双重投影，overflow-hidden 还会把浮窗的 elevation 投影切掉。POPOVER 基座自带
// w-max / max-w-320 / gap / p-1 / 底色 / 投影，逐项用 important 盖掉。
const ENTRY_POPOVER_CLASS_NAME = [
  'no-drag !z-[calc(var(--vds-z-tooltip)+1)]',
  '!max-w-none !gap-0 !p-0 !border-0 !bg-transparent !shadow-none'
].join(' ')
const ENTRY_BUTTON_CLASS_NAME = 'no-drag relative flex-none overflow-hidden'
// 图片按图标槽尺寸铺满（槽位 = --vds-icon-button-glyph），槽位自带居中，
// object-contain 保证非方形素材也不被拉变形。
const ENTRY_GLYPH_CLASS_NAME = 'size-full object-contain'
const ENTRY_DOT_CLASS_NAME =
  'absolute right-[var(--vds-update-ready-dot-offset)] top-[var(--vds-update-ready-dot-offset)] size-[var(--vds-update-ready-dot-size)] rounded-[var(--vds-radius-circle)] border-[length:var(--vds-update-ready-dot-border)] border-solid border-[var(--vds-bg-white-default)] bg-[var(--vds-brand-gold-highlight)]'
const ENTRY_DOT_ALERT_CLASS_NAME = 'bg-[var(--vds-error-bg-default)]'

export function UpdateEntry(): React.JSX.Element | null {
  const { t } = useTranslation('components')
  const state = useUpdateState()
  const announcement = useUpdateAnnouncement()
  const [open, setOpen] = React.useState(false)

  // 首次检测到新版本时自动展开浮窗（PRD 第 1 条）；用户收起后不再自动弹，只留常驻入口。
  React.useEffect(() => {
    if (announcement.pending) setOpen(true)
  }, [announcement.pending])

  if (!isUpdateEntryVisible(state)) return null

  // 收起就是「稍后」：记一次已处理，之后不再自动弹，但入口与下载任务都留着。
  const close = (): void => {
    announcement.acknowledge()
    setOpen(false)
  }

  const phase = state?.phase ?? 'idle'
  const percent = state?.percent ?? 0
  const downloading = phase === 'downloading'
  // 与浮窗同一份判据：安装失败时相位停在 ready，入口不能继续报「待重启」的正常态。
  const failed = updateFailureOf(state) !== null
  const label = downloading
    ? t('update.entryPercent', { percent })
    : failed
      ? t('update.entryFailed')
      : phase === 'ready'
        ? `${t('update.entry')} · ${t('update.entryReady')}`
        : t('update.entry')

  return (
    <>
      <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <PopoverTrigger asChild>
          <Tooltip content={label} side="right">
            <IconButton
              size="lg"
              variant="ghost"
              className={ENTRY_BUTTON_CLASS_NAME}
              label={label}
              // tooltip 由外层 Tooltip（side=right，与活动栏其它条目同侧）提供，
              // 这里清掉 IconButton 默认的原生 title，免得两个提示叠着出。
              title={undefined}
              data-testid="activity-update"
              icon={
                <>
                  {downloading
                    ? <ProgressBar shape="circle" className="size-full" value={percent} label={label} />
                    : <img alt="" className={ENTRY_GLYPH_CLASS_NAME} src={rocketGlyph} />}
                  {(phase === 'ready' || failed) && (
                    <span
                      className={
                        failed
                          ? `${ENTRY_DOT_CLASS_NAME} ${ENTRY_DOT_ALERT_CLASS_NAME}`
                          : ENTRY_DOT_CLASS_NAME
                      }
                    />
                  )}
                </>
              }
            />
          </Tooltip>
        </PopoverTrigger>
        {/* 浮窗在按钮右侧、底部与按钮底部对齐（side=right + align=end）。 */}
        <PopoverContent align="end" className={ENTRY_POPOVER_CLASS_NAME} side="right">
          <UpdatePanel onDismiss={close} />
        </PopoverContent>
      </Popover>
    </>
  )
}
