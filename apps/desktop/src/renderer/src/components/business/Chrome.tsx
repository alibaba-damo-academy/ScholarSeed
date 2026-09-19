import { Onboarding } from '../../contracts/onboarding'
import React from 'react'
import { useTranslation } from 'react-i18next'

import { accountDisplayText } from '../../account'
import {
  isUpdateEntryVisible,
  updateFailureOf,
  useUpdateAnnouncement,
  useUpdateState
} from '../../features/updates/state'
import { useApp } from '../../store'
import { IconFont } from '../primitive'
import { Button } from '../ui'
import { cx } from '../ui/utils'
import {
  AccountMenu,
  AnonymousAvatar,
  openCloudPage,
  useAccountIdentity,
  useAccountLogout,
  UserAvatar
} from './AccountMenu'
import { Feedback } from './Feedback'
import { UpdatePanel } from './UpdatePanel'

// Chrome.tsx — 0.1 侧栏底部的账户与版本更新入口。
// PRD 将两种职责明确分开：头像只展开账户小卡片；齿轮直接进入完整设置页。
//
// 更新态不在这里存：工作台活动栏 (ActivityRail) 与本表面按 mainView 互斥挂载，PRD
// 第 12 条却要求两边显示同一个任务的同一个状态，所以状态只从 features/updates 的那
// 一份订阅读，卡片本体也共用 UpdatePanel —— 这里只拥有侧栏自己的药丸与弹层几何。

const CHROME_ACCOUNT_CLASS_NAME = 'relative flex flex-none items-center gap-[2px] border-t border-[var(--border-soft)] px-[10px] py-[8px]'
const CHROME_ACCOUNT_IDENTITY_CLASS_NAME = 'flex min-w-0 flex-1 items-center justify-start gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] border-0 bg-transparent px-[6px] py-[var(--vds-space-1)] text-left shadow-none transition-[background,color,border-color] duration-150 hover:bg-[var(--hover-bg)] hover:text-[var(--text)] focus-visible:bg-[var(--hover-bg)]'
const CHROME_ACCOUNT_NAME_CLASS_NAME = 'grid min-w-0 gap-[var(--vds-space-0)]'
const CHROME_ACCOUNT_LABEL_CLASS_NAME = 'overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv1)] text-[var(--text)]'
const CHROME_ACCOUNT_VERSION_CLASS_NAME = 'text-[9px] leading-[var(--vds-lh-caption)] tabular-nums text-[var(--text-3)]'
/** 菜单的视觉基座归 AccountMenu 所有, 这里只给侧栏的锚点: chip 上方、与侧栏同宽。 */
const CHROME_ACCOUNT_MENU_POSITION_CLASS_NAME = 'absolute bottom-[calc(100%+6px)] left-[10px] right-[10px]'
const CHROME_UPDATE_CONTROL_CLASS_NAME = 'no-drag vds-control relative flex items-center p-[var(--vds-space-0)]'
const CHROME_UPDATE_ENTRY_CLASS_NAME = 'no-drag flex items-center gap-[6px] border-0 bg-transparent px-[11px] py-[5px] shadow-none hover:bg-transparent'
const CHROME_UPDATE_DOT_CLASS_NAME = 'size-[7px] flex-none rounded-full motion-reduce:animate-none'
const CHROME_UPDATE_DOT_BUSY_CLASS_NAME = 'animate-[update-activity-pulse_1.1s_ease-in-out_infinite]'
const CHROME_UPDATE_SPINNER_CLASS_NAME = 'inline-block size-[14px] flex-none animate-[update-activity-spin_0.82s_linear_infinite] rounded-full border-2 border-[color-mix(in_srgb,var(--accent)_30%,var(--border))] border-t-[var(--accent-ink)] motion-reduce:animate-none'
const CHROME_UPDATE_LABEL_CLASS_NAME = 'text-[11.5px]'
const CHROME_UPDATE_PROGRESS_CLASS_NAME = 'inline-block h-[4px] w-[42px] overflow-hidden rounded-[2px] bg-[var(--border)]'
const CHROME_UPDATE_PROGRESS_BAR_CLASS_NAME = 'block h-full bg-[var(--accent)] transition-[width] duration-200 ease-[var(--vds-ease-standard)]'
// 位置保持侧栏原有行为（药丸上方、左缘对齐）；宽度不定，由 UpdatePanel 按版式自己
// 决定（360 / 展开后 480），absolute 容器会自适应内容宽。底色/圆角/投影同样归浮窗自己，
// 容器再画一层会双重投影，overflow-hidden 还会把 elevation 投影切掉。
const CHROME_UPDATE_POPOVER_CLASS_NAME = 'absolute bottom-[36px] left-[var(--vds-space-0)] z-[90] animate-[cardIn_0.14s_ease_both]'
const CHROME_SETTINGS_ICON_CLASS_NAME = 'text-[15px]'
const CHROME_SCRIM_CLASS_NAME = 'fixed inset-[var(--vds-space-0)] z-[70]'
const CHROME_UPDATE_SCRIM_CLASS_NAME = 'fixed inset-[var(--vds-space-0)] z-[80]'

export function Chrome(): React.JSX.Element {
  const { state, set, act, closeMenus } = useApp()
  const { user, profile, cloudBase } = useAccountIdentity(state.backendReady)
  const { busy: logoutBusy, error: logoutError, logout } = useAccountLogout()
  const { t } = useTranslation('components')
  const { t: accountText } = useTranslation('account')
  const displayName = accountDisplayText(user, profile, accountText)

  // ── version update ──────────────────────────────────────────────────────
  const update = useUpdateState()
  const announcement = useUpdateAnnouncement()
  const [upMenuOpen, setUpMenuOpen] = React.useState(false)

  React.useEffect(() => {
    if (state.accountMenuOpen || state.modelMenuOpen || state.notifPanelOpen || state.newChooser) {
      setUpMenuOpen(false)
    }
  }, [state.accountMenuOpen, state.modelMenuOpen, state.notifPanelOpen, state.newChooser])

  // 首次检测到新版本时自动展开浮窗（PRD 第 1 条）；用户收起后不再自动弹，只留常驻入口。
  React.useEffect(() => {
    if (announcement.pending) setUpMenuOpen(true)
  }, [announcement.pending])

  const phase = update?.phase ?? 'idle'
  const percent = update?.percent ?? 0
  const upVisible = isUpdateEntryVisible(update)
  const upBusy = phase === 'downloading' || phase === 'verifying' ||
    phase === 'installing' || phase === 'restarting'
  // 与活动栏胶囊、更新卡同一份判据：安装失败时相位停在 ready，这里不能继续报「待重启」。
  const upFailure = updateFailureOf(update)
  const upFailed = upFailure !== null
  const upPillLabel = phase === 'downloading'
    ? t('update.entryPercent', { percent })
    : phase === 'verifying'
      ? t('update.verifying')
      : phase === 'installing'
        ? t('update.installing')
        : phase === 'restarting'
          ? t('update.restarting')
          : upFailure?.rolledBack
            ? t('update.rolledBack')
            : upFailed
              ? t('update.entryFailed')
              : phase === 'ready'
                ? t('update.entryReady')
                : phase === 'manual'
                  ? t('update.manual')
                  : t('update.entry')

  // 收起就是「稍后」：记一次已处理，之后不再自动弹，但入口与下载任务都留着。
  const closeUpdatePanel = (): void => {
    announcement.acknowledge()
    setUpMenuOpen(false)
  }

  const toggleAccountMenu = (): void => {
    const open = !state.accountMenuOpen
    closeMenus()
    if (open) set({ accountMenuOpen: true })
  }

  return (
    <div className={CHROME_ACCOUNT_CLASS_NAME}>
      {upVisible && (
        <div className={CHROME_UPDATE_CONTROL_CLASS_NAME}>
          <Button
            type="button"
            data-testid="update-entry"
            onClick={() => {
              const open = !upMenuOpen
              if (open) closeMenus()
              else closeUpdatePanel()
              setUpMenuOpen(open)
            }}
            className={CHROME_UPDATE_ENTRY_CLASS_NAME}
            size="content"
            title={t('update.cardTitle')}
            variant="ghost"
          >
            <span
              className={cx(
                CHROME_UPDATE_DOT_CLASS_NAME,
                upBusy && CHROME_UPDATE_DOT_BUSY_CLASS_NAME,
                upFailed ? 'bg-[var(--vds-error-bg-default)]' : 'bg-[var(--accent)]'
              )}
            />
            <span className={cx(CHROME_UPDATE_LABEL_CLASS_NAME, phase === 'available' ? 'text-[var(--accent-ink)]' : 'text-[var(--text-2)]')}>{upPillLabel}</span>
            {phase === 'downloading' && (
              <span className={CHROME_UPDATE_PROGRESS_CLASS_NAME}>
                {/* 宽度来自更新快照的 percent，是运行期动态几何值。 */}
                <span className={CHROME_UPDATE_PROGRESS_BAR_CLASS_NAME} style={{ width: `${percent}%` }} />
              </span>
            )}
            {upBusy && phase !== 'downloading' && <span className={CHROME_UPDATE_SPINNER_CLASS_NAME} aria-hidden="true" />}
          </Button>
          {upMenuOpen && (
            <div className={CHROME_UPDATE_POPOVER_CLASS_NAME} data-testid="update-popover">
              <UpdatePanel onDismiss={closeUpdatePanel} />
            </div>
          )}
        </div>
      )}

      {state.accountMenuOpen && (
        <AccountMenu
          user={user}
          profile={profile}
          cloudBase={cloudBase}
          className={CHROME_ACCOUNT_MENU_POSITION_CLASS_NAME}
          logoutBusy={logoutBusy}
          logoutError={logoutError}
          onLogin={() => {
            // 登录层与反馈弹窗同理是独立表面: 先收菜单, 否则菜单遮罩会盖在它上面。
            closeMenus()
            set({ loginOpen: true })
          }}
          onLogout={() => void logout()}
          onOpenProfile={() => {
            closeMenus()
            openCloudPage('profile')
          }}
          onOpenCredits={(anchor) => {
            closeMenus()
            openCloudPage('credits', anchor)
          }}
          onGuide={() => {
            // 所有新手引导入口统一打开引导中心。
            closeMenus()
            Onboarding.openCenter()
          }}
          onFeedback={() => {
            // 弹窗是独立表面: 先收菜单, 再由 openFeedback 在弹窗挂载前抓当前窗口截图。
            closeMenus()
            void act.openFeedback()
          }}
          onSettings={() => {
            closeMenus()
            act.openSettings('preferences')
          }}
        />
      )}

      {state.feedbackOpen && (
        <Feedback
          phone={profile?.phone || ''}
          sessionId={state.activeSession}
          autoScreenshot={state.feedbackScreenshot}
          onClose={() => set({ feedbackOpen: false, feedbackScreenshot: null })}
        />
      )}

      <Button
        type="button"
        data-testid="account-chip"
        className={CHROME_ACCOUNT_IDENTITY_CLASS_NAME}
        aria-expanded={state.accountMenuOpen}
        aria-controls="account-menu"
        onClick={toggleAccountMenu}
        size="content"
        title={user ? displayName : t('chrome.brand')}
        variant="ghost"
      >
        {user ? <UserAvatar user={user} displayName={displayName} size={26} /> : <AnonymousAvatar />}
        <span className={CHROME_ACCOUNT_NAME_CLASS_NAME}>
          <span className={CHROME_ACCOUNT_LABEL_CLASS_NAME}>{user ? displayName : t('chrome.brand')}</span>
          <span className={CHROME_ACCOUNT_VERSION_CLASS_NAME}>{window.scholarseed?.version || 'v0.1'}</span>
        </span>
      </Button>

      <Button
        type="button"
        className="no-drag"
        data-testid="settings-toggle"
        onClick={() => {
          closeMenus()
          act.openSettings('account')
        }}
        title={t('chrome.settings')}
        aria-label={t('chrome.openSettings')}
        size="icon"
        variant="ghostIcon"
      >
        <IconFont className={CHROME_SETTINGS_ICON_CLASS_NAME} type="line-tool-setting" />
      </Button>

      {(state.newChooser || state.notifPanelOpen || state.accountMenuOpen) && (
        <div className={CHROME_SCRIM_CLASS_NAME} onClick={closeMenus} />
      )}
      {upVisible && upMenuOpen && (
        <div className={CHROME_UPDATE_SCRIM_CLASS_NAME} onClick={closeUpdatePanel} />
      )}
    </div>
  )
}
