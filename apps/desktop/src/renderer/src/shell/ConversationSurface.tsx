import { sessionDisplayTitle } from '../session'
import React from 'react'
import { useTranslation } from 'react-i18next'

import { Composer } from '../components/business/Composer'
import {
  ConversationControls,
  Stream
} from '../components/business/Stream'
import { TaskMonitor } from '../components/business/TaskMonitor'
import { WorkspaceFiles } from '../components/business/WorkspaceFiles'
import { Progress } from '../components/primitive/Progress'
import { Button, IconButton } from '../components/ui'
import { cx } from '../components/ui'
import { Home } from '../features/home/Home'
import { DocumentDock } from '../features/workbench/Dock'
import { useDocumentWorkspace } from '../features/workbench/workspace'
import { Icon } from '../icons'
import type { DeliveryCardMember } from '../model'
import { blocksRuntimePreflight, effectiveReadiness } from '../runtime'
import { activeThread, useApp } from '../store'

const RUNTIME_ACTION_KEYS = {
  install: 'preflight.actions.install',
  login: 'preflight.actions.login',
  upgrade: 'preflight.actions.upgrade',
  configure: 'preflight.actions.configure',
  retry: 'preflight.actions.retry',
} as const
const HEADER_TITLE_MAX_CHARS = 15
const CONVERSATION_COLUMN_CLASS_NAME = 'relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--paper)]'
const CONVERSATION_DRAG_STRIP_CLASS_NAME = 'absolute left-[var(--vds-space-0)] right-[var(--vds-space-0)] top-[var(--vds-space-0)] z-[var(--vds-z-local-control)] h-[15px] [-webkit-app-region:drag]'
const CONVERSATION_CONTENT_CLASS_NAME = 'flex h-full min-h-0 min-w-0 flex-[1_1_auto] overflow-hidden'
const CONVERSATION_WITH_MONITOR_CLASS_NAME = 'flex-row gap-[var(--vds-space-0)]'
const CONVERSATION_MAIN_CLASS_NAME = 'flex h-full min-h-0 min-w-0 flex-[1_1_auto] flex-col overflow-hidden'
const CONVERSATION_FILE_PREVIEW_CLASS_NAME = 'flex-[0_0_clamp(var(--conversation-split-min-width),34%,620px)] border-r border-[var(--border-soft)]'
const CONVERSATION_HEADER_CLASS_NAME = 'relative z-[var(--vds-z-sticky-header)] flex h-[58px] flex-none items-center border-b border-[var(--border-soft)] bg-[var(--paper)] px-[20px] [-webkit-app-region:drag] [.vds-app-shell.is-sidebar-collapsed_&]:pl-[174px] [.vds-app-shell.is-sidebar-collapsed_&]:[-webkit-app-region:no-drag]'
const CONVERSATION_HEADER_IDENTITY_CLASS_NAME = 'relative top-[-3px] flex min-w-0 flex-[1_1_auto] items-center gap-[var(--vds-space-2)] overflow-hidden whitespace-nowrap'
const CONVERSATION_HEADER_DOT_CLASS_NAME = 'size-[6px] flex-none rounded-[var(--vds-radius-circle)] bg-[var(--accent)]'
const CONVERSATION_HEADER_BUSY_DOT_CLASS_NAME = 'animate-[progress-beacon_1.35s_ease-out_infinite] shadow-[0_0_0_0_color-mix(in_oklch,var(--accent)_48%,transparent)]'
const CONVERSATION_HEADER_TITLE_CLASS_NAME = 'min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] leading-[var(--vds-lh-body-lv1)] text-[var(--text)] [-webkit-app-region:no-drag]'
const CONVERSATION_HEADER_META_CLASS_NAME = 'flex-none overflow-hidden text-ellipsis whitespace-nowrap text-[9.5px] leading-[var(--vds-lh-caption)] text-[var(--text-3)]'
const CONVERSATION_HEADER_SESSION_CLASS_NAME = 'font-[var(--font-mono)]'
const CONVERSATION_HEADER_ICON_CLASS_NAME = 'no-drag'
const CONVERSATION_MAIN_BODY_CLASS_NAME = 'flex min-h-0 min-w-0 flex-[1_1_auto] flex-col overflow-hidden'
const RUNTIME_PREFLIGHT_CLASS_NAME = 'absolute inset-[var(--vds-space-0)] z-[var(--vds-z-surface-gate)] grid place-items-center bg-[color-mix(in_oklch,var(--bg)_88%,transparent)] p-[24px]'
const RUNTIME_PREFLIGHT_CARD_CLASS_NAME = 'w-[min(430px,92%)] rounded-[14px] border border-[var(--border)] bg-[var(--surface)] px-[24px] py-[22px] shadow-[0_18px_48px_rgb(0_0_0_/_18%)]'
const RUNTIME_PREFLIGHT_TITLE_ROW_CLASS_NAME = 'mb-[10px] flex items-center gap-[9px]'
const RUNTIME_PREFLIGHT_DOT_CLASS_NAME = 'size-[9px] rounded-[var(--vds-radius-circle)] bg-[var(--c-tension)]'
const RUNTIME_PREFLIGHT_TITLE_CLASS_NAME = 'text-[14px] font-[var(--vds-fw-semibold)] text-[var(--text)]'
const RUNTIME_PREFLIGHT_CODE_CLASS_NAME = 'mb-[6px] text-[10px] leading-[var(--vds-lh-caption)] text-[var(--text-3)]'
const RUNTIME_PREFLIGHT_MESSAGE_CLASS_NAME = 'mb-[var(--vds-space-2)] text-[12px] leading-[1.55] text-[var(--text-2)]'
const RUNTIME_PREFLIGHT_ACTION_CLASS_NAME = 'mb-[var(--vds-space-4)] text-[11px] leading-[1.5] text-[var(--text-3)]'

function displayHeaderTitle(title: string): string {
  const chars = Array.from(title)
  if (chars.length <= HEADER_TITLE_MAX_CHARS) return title
  return `${chars.slice(0, HEADER_TITLE_MAX_CHARS).join('')}...`
}

/**
 * The ScholarSeed MVP centre column. It has exactly two states: 首页 (PRD 2.1.2)
 * when no session is selected, and 对话页 (PRD 2.1.3) once one is. Product
 * overlays (skills and project files) stack on top of either. In a selected
 * conversation, file preview is a PRD split pane: the transcript remains on
 * the left and the preview replaces the task-monitor pane on the right.
 */
export function Conversation(): React.JSX.Element {
  const { state, set, act } = useApp()
  const { t } = useTranslation('conversation')
  const { t: assistantText } = useTranslation('assistant')
  const documents = useDocumentWorkspace()
  const documentOpen = Object.keys(documents.tabs).length > 0
  const thread = activeThread(state)
  const home = state.activeSession === null
  const resuming = !home && thread.resumeState === 'pending'
  // 阻断卡与发送门禁必须同源: 会话自己的 readiness 优先于运行时全局预检。
  const surfaceReadiness = effectiveReadiness(thread, state.runtimeReadiness)
  const blockedReadiness = blocksRuntimePreflight(surfaceReadiness) ? surfaceReadiness : null
  const [taskMonitorOpen, setTaskMonitorOpen] = React.useState(true)
  const threadProject = thread.projectPath
    ? state.projects.find((project) => project.path === thread.projectPath)?.name
    : null
  const openDelivery = (member: DeliveryCardMember): void => {
    if (!member.workspacePath) return
    act.openFilePreview({
      path: member.workspacePath,
      title: member.title,
      ...(member.titleFallback ? { titleFallback: 'untitledArtifact' as const } : {}),
      mediaType: member.mediaType
    })
  }
  const homeSurface = state.turnLaunch ? (
    <Stream />
  ) : (
    // 0.1 双栏只挂在 'conversation' 视图上；'home' 已是工作台首页空间。
    <Home />
  )

  return (
    <div className={CONVERSATION_COLUMN_CLASS_NAME}>
      {/* 顶部窗口拖动带: 侧栏那一行原本是全窗唯一能拖动的地方。 */}
      <div className={CONVERSATION_DRAG_STRIP_CLASS_NAME} aria-hidden />
      {home ? homeSurface : (
        <>
          <div className={cx(CONVERSATION_CONTENT_CLASS_NAME, CONVERSATION_WITH_MONITOR_CLASS_NAME)}>
            <div className={cx(CONVERSATION_MAIN_CLASS_NAME, documentOpen && CONVERSATION_FILE_PREVIEW_CLASS_NAME)}>
              <header className={CONVERSATION_HEADER_CLASS_NAME}>
                <div className={CONVERSATION_HEADER_IDENTITY_CLASS_NAME}>
                  <span className={cx(CONVERSATION_HEADER_DOT_CLASS_NAME, resuming && CONVERSATION_HEADER_BUSY_DOT_CLASS_NAME)} />
                  <span className={CONVERSATION_HEADER_TITLE_CLASS_NAME} title={sessionDisplayTitle(thread, assistantText)}>{displayHeaderTitle(sessionDisplayTitle(thread, assistantText))}</span>
                  <span className={CONVERSATION_HEADER_META_CLASS_NAME}>· {threadProject || t('header.recent')}</span>
                  {thread.sessionId && (
                    <span className={cx(CONVERSATION_HEADER_META_CLASS_NAME, CONVERSATION_HEADER_SESSION_CLASS_NAME)}>
                      {t('header.session', { id: thread.sessionId.slice(0, 8) })}
                    </span>
                  )}
                </div>
                <IconButton
                  type="button"
                  className={CONVERSATION_HEADER_ICON_CLASS_NAME}
                  data-testid="conversation-clear-selection"
                  icon={<Icon name="close" size={16} />}
                  label={t('header.home')}
                  onClick={act.clearSessionSelection}
                  size="sm"
                  variant="ghostIcon"
                />
                {!taskMonitorOpen && !documentOpen && (
                  <IconButton
                    type="button"
                    aria-pressed={false}
                    className={CONVERSATION_HEADER_ICON_CLASS_NAME}
                    data-testid="task-monitor-toggle"
                    icon={<Icon name="panel-right" size={16} />}
                    label={t('header.monitor')}
                    onClick={() => setTaskMonitorOpen(true)}
                    size="sm"
                    variant="ghostIcon"
                  />
                )}
              </header>
              <div className={CONVERSATION_MAIN_BODY_CLASS_NAME} aria-busy={resuming}>
                {resuming ? (
                  <Progress
                    surface="conversation"
                    title={t('resume.title')}
                    detail={thread.resumeMessage?.key === 'resume.retry'
                      ? t('resume.retry', thread.resumeMessage)
                      : thread.resumeMessage ? t(thread.resumeMessage.key) : t('resume.codex')}
                  />
                ) : (
                  <>
                    <Stream home={false} onOpenDelivery={openDelivery} />
                    <ConversationControls>
                      <Composer />
                    </ConversationControls>
                  </>
                )}
              </div>
            </div>
            {documentOpen
              ? <DocumentDock />
              : taskMonitorOpen && !resuming && <TaskMonitor onToggle={() => setTaskMonitorOpen(false)} />}
          </div>
        </>
      )}

      {state.workspaceFilesOpen && <WorkspaceFiles />}
      {home && documentOpen && <DocumentDock />}
      {blockedReadiness && (
        <div
          className={RUNTIME_PREFLIGHT_CLASS_NAME}
          data-testid="runtime-preflight-blocked"
          role="alert"
        >
          <div className={RUNTIME_PREFLIGHT_CARD_CLASS_NAME}>
            <div className={RUNTIME_PREFLIGHT_TITLE_ROW_CLASS_NAME}>
              <span aria-hidden className={RUNTIME_PREFLIGHT_DOT_CLASS_NAME} />
              <strong className={RUNTIME_PREFLIGHT_TITLE_CLASS_NAME}>{t('preflight.title')}</strong>
            </div>
            <div className={RUNTIME_PREFLIGHT_CODE_CLASS_NAME} data-testid="runtime-preflight-code">
              {blockedReadiness.code || 'runtime_not_ready'}
            </div>
            <div className={RUNTIME_PREFLIGHT_MESSAGE_CLASS_NAME} data-testid="runtime-preflight-message">
              {blockedReadiness.message || t('preflight.message')}
            </div>
            <div className={RUNTIME_PREFLIGHT_ACTION_CLASS_NAME} data-testid={`runtime-preflight-action-${blockedReadiness.action || 'retry'}`}>
              {blockedReadiness.action && Object.prototype.hasOwnProperty.call(RUNTIME_ACTION_KEYS, blockedReadiness.action)
                ? t(RUNTIME_ACTION_KEYS[blockedReadiness.action])
                : t('preflight.actions.retry')}
            </div>
            <Button
              type="button"
              data-testid="runtime-preflight-open-settings"
              onClick={() => {
                set({ modelMenuOpen: false, notifPanelOpen: false })
                act.openSettings('account')
              }}
              size="sm"
            >
              {t('preflight.settings')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
