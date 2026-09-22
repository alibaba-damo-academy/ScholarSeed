import React from 'react'
import { useTranslation } from 'react-i18next'

import { releaseNoteLines, useUpdateState } from '../../features/updates/state'
import { Divider, Spinner } from '../ui'
import { UpdateMetadata } from './UpdateMetadata'

// UpdateOverlay.tsx — 安装/重启期间的全屏遮罩。
//
// 必须挂在两种视图都覆盖得到的层级：安装可以从活动栏入口发起（工作台视图），也可以
// 从 0.1 侧栏底部或「关于书深」发起（对话视图 / 设置弹层），而这两个表面按 mainView
// 互斥挂载 —— 放在任何一个里面都会在另一个视图里静默失效。

const OVERLAY_CLASS_NAME =
  'no-drag fixed inset-0 z-[var(--vds-z-loading)] grid place-items-center bg-[color-mix(in_srgb,var(--vds-bg-gray-default)_92%,transparent)] p-[24px]'
const OVERLAY_CARD_CLASS_NAME =
  'grid max-h-full min-h-0 overflow-y-auto w-[min(100%,390px)] justify-items-center gap-[12px] rounded-[16px] border border-[var(--vds-divider-default)] bg-[var(--vds-bg-gray-default)] p-[28px] text-center shadow-[var(--vds-shadow-2-center)]'
const OVERLAY_TITLE_CLASS_NAME =
  'text-[16px] font-[var(--vds-fw-semibold)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]'
const OVERLAY_TEXT_CLASS_NAME =
  'text-[12px] leading-[1.6] text-[var(--vds-text-secondary)]'
const OVERLAY_HINT_CLASS_NAME =
  'text-[11px] leading-[1.6] text-[var(--vds-text-tertiary)]'

export function UpdateOverlay(): React.JSX.Element | null {
  const { t } = useTranslation('components')
  const state = useUpdateState()
  const notes = releaseNoteLines(state?.candidate?.release_notes)
  const phase = state?.phase
  if (phase !== 'installing' && phase !== 'restarting') return null

  const label = phase === 'restarting' || state?.installStage === 'restarting'
    ? t('update.restarting')
    : state?.installStage === 'copying'
      ? t('update.preparingApp')
      : t('update.installing')

  return (
    <div className={OVERLAY_CLASS_NAME} role="status" aria-live="polite" data-testid="update-overlay">
      <div className={OVERLAY_CARD_CLASS_NAME}>
        <Spinner size="lg" />
        <span className={OVERLAY_TITLE_CLASS_NAME}>{label}</span>
        <span className={OVERLAY_TEXT_CLASS_NAME} data-testid="update-overlay-version">
          <UpdateMetadata candidate={state?.candidate} />
        </span>
        <span className={OVERLAY_TEXT_CLASS_NAME}>{t('update.installDescription')}</span>
        <Divider />
        <div className="grid w-full min-h-0 gap-[var(--vds-space-3)] overflow-y-auto text-left">
          <span className={OVERLAY_TITLE_CLASS_NAME}>{t('update.notesTitle')}</span>
          {notes.length > 0 ? (
            <ul className="list-disc pl-[var(--vds-space-4)]" data-testid="update-overlay-notes">
              {notes.map((note, index) => <li className={OVERLAY_TEXT_CLASS_NAME} key={index}>{note}</li>)}
            </ul>
          ) : <span className={OVERLAY_TEXT_CLASS_NAME}>{t('update.notesEmpty')}</span>}
        </div>
        <span className={OVERLAY_HINT_CLASS_NAME}>{t('update.installHint')}</span>
      </div>
    </div>
  )
}
