import { Onboarding } from '../contracts/onboarding'
import React from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpenText, Folders, House, LibraryBig, ListTodo } from 'lucide-react'

import { accountDisplayText } from '../account'
import { featureRegistry } from '../app/composition'
import type { ActivityItem } from '../contracts/features'
import {
  AccountMenu,
  openCloudPage,
  useAccountIdentity,
  useAccountLogout
} from '../components/business/AccountMenu'
import { Feedback } from '../components/business/Feedback'
import { TaskCenter } from '../components/business/Tasks'
import { useTaskCenter } from '../components/business/taskCenterContext'
import { UpdateEntry } from '../components/business/UpdateEntry'
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip
} from '../components/ui'
import { cx } from '../components/ui'
import { Icon } from '../icons'
import { hasProjectScope, useApp } from '../store'

const MENU_ICON_SIZE = 16
/**
 * 首页空间入口由 Shell 自己贡献：它不属于任何业务 Feature（原型 home space
 * 的房子图标），且必须排在所有 Feature 条目之前。
 */
const HOME_ACTIVITY_ITEM: ActivityItem = {
  key: 'home',
  label: (i18n, { hasProject }) => i18n.getFixedT(null, 'shell')(
    hasProject ? 'navigation.returnHome' : 'navigation.projects'
  ),
  icon: 'home',
  order: 0
}
/** 首页空间只保留全局面条目：无项目上下文的图标表达不了「进入某个项目」。 */
const HOME_SPACE_KEYS = ['home', 'literature']
const ACTIVITY_ICON_BY_KEY: Partial<Record<string, React.JSX.Element>> = {
  home: <House size={MENU_ICON_SIZE} strokeWidth={1.45} />,
  literature: <LibraryBig size={MENU_ICON_SIZE} strokeWidth={1.45} />,
  resource: <Folders size={MENU_ICON_SIZE} strokeWidth={1.45} />
}
const activityIconFor = (
  key: string,
  icon: ActivityItem['icon'],
  hasProject: boolean
): React.JSX.Element => {
  if (key === 'literature' && hasProject) {
    return <BookOpenText size={MENU_ICON_SIZE} strokeWidth={1.45} />
  }
  return ACTIVITY_ICON_BY_KEY[key] ?? (
    <Icon name={icon} size={MENU_ICON_SIZE} sw={1.45} />
  )
}
// 活动栏层级用 --vds-z-rail 而不是 elevated: 头像菜单要向右溢出栏宽浮在模块面板
// 之上, 同层级下 DOM 在后的面板会盖住本栏子元素; 但必须留在浮层带 (60 起) 之下,
// 否则项目切换弹层/全局搜索遮罩会被本栏盖住。见 design/zindex.css 的不变量注释。
const ACTIVITY_RAIL_CLASS_NAME =
  'vds-activity-rail relative z-[var(--vds-z-rail)] has-[.vds-tooltip--open]:z-[var(--vds-z-tooltip)] box-border flex w-14 flex-none flex-col items-center gap-2 border-r border-[var(--vds-divider-default)] bg-[var(--vds-bg-gray-default)] px-2 py-6'
const ACTIVITY_RAIL_MAIN_CLASS_NAME =
  'grid content-start justify-items-center gap-2'
const ACTIVITY_RAIL_FOOTER_CLASS_NAME =
  'mt-auto grid justify-items-center gap-2'
const ACTIVITY_BUTTON_CLASS_NAME =
  'vds-activity-btn relative grid size-10 place-items-center rounded-[8px] border border-transparent text-[var(--vds-text-tertiary)] transition-[background-color,border-color,color,opacity] duration-150 ease-[var(--vds-ease-standard)] hover:bg-[var(--vds-bg-gray-hover-transparent)] hover:text-[var(--vds-brand-text-primary)] disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[var(--vds-text-tertiary)]'
// 选中态字色加 important: 基类 text-[var(--vds-text-tertiary)] 在编译后样式表中排在
// text-[var(--vds-brand-text-primary)] 之后, 同特异性下会压掉选中态字色, 导致选中图标
// 仍是灰色而 hover 是品牌色; 两者必须一致(取 hover 的品牌色)。
const ACTIVITY_BUTTON_ACTIVE_CLASS_NAME =
  'is-active bg-[var(--vds-bg-gray-active)] !text-[var(--vds-brand-text-primary)]'
const ACTIVITY_AVATAR_CLASS_NAME =
  'grid size-[30px] place-items-center rounded-[var(--vds-radius-circle)] border border-[var(--vds-brand-light-border)] bg-[var(--vds-brand-light-bg-default)] text-[13px] font-[var(--vds-fw-semibold)] leading-none text-[var(--vds-brand-text-primary)] shadow-[0_0_0_2px_var(--vds-bg-gray-default)] transition-[border-color,box-shadow] duration-150 ease-[var(--vds-ease-standard)] hover:border-[var(--vds-brand-bg-default)] hover:shadow-[0_0_0_3px_var(--vds-brand-light-bg-hover)]'

const avatarText = (name: string): string =>
  Array.from(name)
    .slice(0, 1)
    .join('')
    .toUpperCase()

/**
 * 左侧活动栏：视图切换 + 任务中心 + 头像入口。
 *
 * 改造前这里有一张写死的 `ACTIVITY_VIEWS`。现在改为读
 * `featureRegistry.activityItems` —— 各 Feature 在自己的 `feature.tsx` 里
 * 声明入口，新增视图不再需要改本文件（架构文档 §4.3）。
 *
 * 「写作」PRD 整体列为 P1，因此本期无 Feature 贡献它的入口，
 * 自然不会出现在活动栏；写作负责人接手时只需在自己的 feature.tsx
 * 加一个 activityItem。
 *
 * 栏首的「项目全览」入口由 Shell 自己贡献（HOME_ACTIVITY_ITEM），首页空间
 * 里只保留全局面条目。打开已有会话走 'conversation' 视图（0.1 双栏）。
 *
 * 未选项目时禁用哪些入口同样不写死：只看条目自己的 `requiresProject`。
 *
 * 栏底是头像入口（PRD「账号入口与快捷设置」②）。这里**没有**回 0.1 全屏
 * 对话面的按钮：0.2 的对话由顶栏「AI 助手」/⌘J 面板承载，已有会话经全局搜索的
 * 会话命中打开全屏对话面（`openSession` 会切回 `mainView: 'home'`）。
 *
 * 头像入口按 PRD「账号入口与快捷设置」② 固定在栏底最下方，菜单在头像上方展开、
 * 向右溢出 56px 栏宽。身份与菜单来自 `components/business/AccountMenu`，与 0.1
 * 侧栏底部共用同一份实现 —— 两个表面按 mainView 互斥挂载，PRD 要求登录态变化时
 * 「任意模块」的头像入口都同步，所以这里不能各存一份身份 state。
 */
export function ActivityRail(): React.JSX.Element {
  const { state, set, act, closeMenus } = useApp()
  const { t, i18n } = useTranslation('shell')
  const { t: ui } = useTranslation('ui')
  const { t: accountText } = useTranslation('account')
  const scoped = hasProjectScope(state)
  const { user, profile, cloudBase } = useAccountIdentity(state.backendReady)
  const { busy: logoutBusy, error: logoutError, logout } = useAccountLogout()
  const {
    activeCount,
    open: taskCenterOpen,
    setOpen: setTaskCenterOpen
  } = useTaskCenter()

  const displayName = accountDisplayText(user, profile, accountText)

  const homeSpace = state.mainView === 'home'
  const projectLiterature = state.mainView === 'literature' && Boolean(state.homeSelectedProjectId)
  const contributed = homeSpace
    ? featureRegistry.activityItems.filter((view) =>
        HOME_SPACE_KEYS.includes(view.key)
      )
    : featureRegistry.activityItems.filter(
        (view) => (!view.hiddenIn?.includes(state.mainView) || projectLiterature) && (view.requiresProject === true ? scoped : true)
      )
  const items = [HOME_ACTIVITY_ITEM, ...contributed]
    .sort((left, right) => left.order - right.order)
  // 原型在项目空间里用一条短分隔线把全局面条目与项目模块条目分开。
  const dividerBefore = homeSpace
    ? null
    : (
      items.find(
        (view) => view.requiresProject === true
      )?.key ?? null
    )

  return (
    <>
      <nav
        className={ACTIVITY_RAIL_CLASS_NAME}
        aria-label={ui('navigation.modules')}
      >
        <div className={ACTIVITY_RAIL_MAIN_CLASS_NAME}>
          {items.map((view) => {
            const label = view.label(i18n, { hasProject: Boolean(state.homeSelectedProjectId) })
            const blocked = view.requiresProject === true && !scoped
            // 禁用时不画选中态：mainView 虽然仍停在这个视图，但它的面板已经隐藏、
            // 中央是品牌空态 —— 高亮加左侧指示条会让人以为它可点。
            const current = state.mainView === view.key && !blocked
            return (
              <React.Fragment key={view.key}>
                {view.key === dividerBefore && (
                  <span className="vds-rail-div" aria-hidden />
                )}
                <Tooltip
                  content={
                    blocked ? t('chrome.requiresProject', { label }) : label
                  }
                  side="right"
                >
                  <Button
                    unstyled
                    className={cx(
                      ACTIVITY_BUTTON_CLASS_NAME,
                      current && ACTIVITY_BUTTON_ACTIVE_CLASS_NAME
                    )}
                    aria-label={label}
                    aria-current={current}
                    data-testid={`activity-${view.key}`}
                    data-ob={`activity-${view.key}`}
                    disabled={blocked}
                    onClick={() => act.openWorkbenchView(view.key, { preserveProject: true })}
                  >
                    {activityIconFor(
                      view.key,
                      view.icon,
                      Boolean(state.homeSelectedProjectId)
                    )}
                  </Button>
                </Tooltip>
              </React.Fragment>
            )
          })}
        </div>

        <div className={ACTIVITY_RAIL_FOOTER_CLASS_NAME}>
          {/* PRD 第 1 条：更新入口在通知与头像之上；未发现新版本时它自己返回 null。 */}
          <UpdateEntry />
          <Popover open={taskCenterOpen} onOpenChange={setTaskCenterOpen}>
            <PopoverTrigger asChild>
              <Tooltip content={t('chrome.taskCenter')} side="right">
                <Button
                  unstyled
                  className={ACTIVITY_BUTTON_CLASS_NAME}
                  aria-label={activeCount ? t('chrome.taskCenterCount', { count: activeCount }) : t('chrome.taskCenter')}
                  data-testid="activity-tasks"
                >
                  <ListTodo size={MENU_ICON_SIZE} strokeWidth={1.45} />
                  {activeCount ? (
                    <span className="absolute -right-1 -top-1 grid min-w-4 place-items-center rounded-full bg-[var(--vds-error-bg-default)] px-1 text-[9px] leading-4 text-white">
                      {activeCount}
                    </span>
                  ) : null}
                </Button>
              </Tooltip>
            </PopoverTrigger>
            {/* z 高于 tooltip：同 UpdateEntry，栏在 tooltip 打开时抬到 --vds-z-tooltip 会盖住本弹层。 */}
            <PopoverContent className="no-drag !z-[calc(var(--vds-z-tooltip)+1)] !w-full p-0">
              <TaskCenter />
            </PopoverContent>
          </Popover>
          <Popover
            open={state.accountMenuOpen}
            onOpenChange={(open) => {
              if (open) set({ accountMenuOpen: true })
              else closeMenus()
            }}
          >
            <PopoverTrigger asChild>
              <Button
                unstyled
                className={ACTIVITY_AVATAR_CLASS_NAME}
                aria-label={ui('avatar.label', { name: displayName })}
                data-testid="activity-account"
              >
                {/* 已登录 = 颜色底色 + 昵称字符 (PRD ②)；未登录 = 通用人形图标，不是品牌字。 */}
                {user ? (
                  avatarText(displayName)
                ) : (
                  <Icon name="user" size={15} />
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="no-drag z-[var(--vds-z-popover)] !w-[220px]">
              <AccountMenu
                user={user}
                profile={profile}
                cloudBase={cloudBase}
                className=""
                embedded
                logoutBusy={logoutBusy}
                logoutError={logoutError}
                onLogin={() => {
                  // 登录层与反馈弹窗同理是独立表面: 先收菜单再开。
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
                  // 与设置入口共用引导中心。
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
            </PopoverContent>
          </Popover>
        </div>
      </nav>

      {state.feedbackOpen && (
        <Feedback
          phone={profile?.phone || ''}
          sessionId={state.activeSession}
          autoScreenshot={state.feedbackScreenshot}
          onClose={() => set({ feedbackOpen: false, feedbackScreenshot: null })}
        />
      )}
    </>
  )
}
