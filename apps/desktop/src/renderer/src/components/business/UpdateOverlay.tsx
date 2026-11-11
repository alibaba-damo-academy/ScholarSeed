import React from 'react'
import { useTranslation } from 'react-i18next'

import scholarseedLogoMark from '../../assets/logo.svg'
import { releaseNoteLines, releaseNotesOf, useUpdateState } from '../../features/updates/state'
import {
  installationDuration,
  installationStepText,
  useInstallationClock,
} from '../../features/updates/installation'
import { Button, Divider, ProgressBar } from '../ui'
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
const OVERLAY_TEXT_CLASS_NAME = 'text-[12px] leading-[1.6] text-[var(--vds-text-secondary)]'
const OVERLAY_LOGO_CLASS_NAME =
  'block size-[var(--vds-space-10)] rounded-[var(--vds-radius-5)] object-cover'
const OVERLAY_PROGRESS_CLASS_NAME = 'w-full'
const OVERLAY_CANCEL_CLASS_NAME = 'w-full'

export function UpdateOverlay(): React.JSX.Element | null {
  const { t, i18n } = useTranslation('components')
  const { t: accountText } = useTranslation('account')
  const state = useUpdateState()
  const notes = releaseNoteLines(
    releaseNotesOf(state?.candidate, i18n.resolvedLanguage || i18n.language)
  )
  const phase = state?.phase
  const installation = state?.installation
  const now = useInstallationClock(phase === 'installing')
  const starting = state?.startupVerification === 'starting'
  if (
    !starting &&
    (phase === 'preparing' ||
      (phase !== 'installing' && phase !== 'restarting' && !state?.restartPending))
  )
    return null

  const restarting = phase === 'restarting' || state?.installStage === 'restarting'
  const saving = installation?.step === 'saving' || state?.installStage === 'handoff'
  const cancelling = installation?.cancelling === true
  const cleaning = installation?.step === 'cleanup'
  const label = starting
    ? accountText('update.starting')
    : saving
      ? accountText('update.saving')
      : cancelling
        ? t('update.cancelling')
        : restarting
          ? t('update.restarting')
          : state?.installStage === 'copying'
            ? t('update.preparingApp')
            : t('update.installing')
  // 准备/拷贝阶段安装还在本进程里跑，取消能真的 abort；restarting 之后安装器已脱离本进程，
  // 给取消按钮只会制造「点了却没反应」的假控件（bug 87253073：用户必须有可见的恢复路径）。
  const cancellable =
    !starting &&
    state?.installStage !== 'handoff' &&
    (phase === 'installing' || state?.restartPending) &&
    !restarting &&
    !cleaning
  const description = starting
    ? accountText('update.startingDetail')
    : saving
      ? accountText('update.savingDetail')
      : cancelling
        ? t('update.cancellingDescription')
        : restarting
          ? t('update.installDescription')
          : cleaning
            ? t('update.cleanupDescription')
            : state?.restartPending && phase !== 'installing'
              ? t('update.waitingForLatest')
              : t('update.preparingDescription')

  return (
    <div
      className={OVERLAY_CLASS_NAME}
      role="status"
      aria-live="polite"
      data-testid="update-overlay"
    >
      <div className={OVERLAY_CARD_CLASS_NAME}>
        <img className={OVERLAY_LOGO_CLASS_NAME} src={scholarseedLogoMark} alt="" aria-hidden />
        <span className={OVERLAY_TITLE_CLASS_NAME}>{label}</span>
        <span className={OVERLAY_TEXT_CLASS_NAME} data-testid="update-overlay-version">
          <UpdateMetadata candidate={state?.candidate} />
        </span>
        <span className={OVERLAY_TEXT_CLASS_NAME} data-testid="update-overlay-description">
          {description}
        </span>
        {installation && (
          <div className="grid w-full gap-[var(--vds-space-2)]">
            <span className={OVERLAY_TEXT_CLASS_NAME} data-testid="update-overlay-step">
              {installationStepText(installation, t, accountText)}
            </span>
            <span
              className={OVERLAY_TEXT_CLASS_NAME}
              data-testid="update-overlay-elapsed"
              aria-live="off"
            >
              {t('update.installElapsed', {
                step: installationDuration(now - installation.stepStartedAt),
                total: installationDuration(now - installation.startedAt),
              })}
            </span>
            {installation.timeoutMs !== undefined && (
              <span className={OVERLAY_TEXT_CLASS_NAME} data-testid="update-overlay-limit">
                {t('update.installLimit', { limit: installationDuration(installation.timeoutMs) })}
              </span>
            )}
          </div>
        )}
        <ProgressBar
          className={OVERLAY_PROGRESS_CLASS_NAME}
          data-testid="update-overlay-progress"
          indeterminate
        />
        {cancellable && (
          <Button
            className={OVERLAY_CANCEL_CLASS_NAME}
            data-testid="update-overlay-cancel"
            disabled={cancelling}
            onClick={() => void window.scholarseed.cancelUpdate()}
            variant="outline"
          >
            {cancelling ? t('update.cancelling') : t('update.cancelInstall')}
          </Button>
        )}
        <Divider />
        <div className="grid w-full min-h-0 gap-[var(--vds-space-3)] overflow-y-auto text-left">
          <span className={OVERLAY_TITLE_CLASS_NAME}>{t('update.notesTitle')}</span>
          {notes.length > 0 ? (
            <ul className="list-disc pl-[var(--vds-space-4)]" data-testid="update-overlay-notes">
              {notes.map((note, index) => (
                <li className={OVERLAY_TEXT_CLASS_NAME} key={index}>
                  {note}
                </li>
              ))}
            </ul>
          ) : (
            <span className={OVERLAY_TEXT_CLASS_NAME}>{t('update.notesEmpty')}</span>
          )}
        </div>
      </div>
    </div>
  )
}
