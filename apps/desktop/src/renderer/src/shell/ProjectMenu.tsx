import React from 'react'
import { useTranslation } from 'react-i18next'
import { Box, Check, House, LibraryBig } from 'lucide-react'

import { IconFont } from '../components/primitive'
import { Button } from '../components/ui'
import { cx } from '../components/ui'
import { useApp } from '../store'

/** Project selection is a navigation flyout: above chrome, below modal surfaces. */
export const PROJECT_POPOVER_CONTENT_CLASS = [
  'z-[var(--vds-z-inline-flyout)] w-auto'
].join(' ')

const PROJECT_MENU_ITEM_CLASS_NAME =
  'flex h-[36px] max-h-[36px] min-h-[36px] w-full items-center justify-start gap-2 rounded-[7px] border-0 px-3 py-0 text-left text-[14px] transition-[background-color] duration-150 hover:bg-[var(--vds-bg-gray-hover-transparent)]'
const PROJECT_MENU_ITEM_ACTIVE_CLASS_NAME =
  '![background:var(--vds-brand-light-bg-default)] !text-[var(--vds-brand-bg-default)] hover:![background:var(--vds-brand-light-bg-default)] active:![background:var(--vds-brand-light-bg-default)]'
const PROJECT_MENU_LABEL_CLASS_NAME =
  'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--vds-text-primary)]'
const PROJECT_MENU_LABEL_ACTIVE_CLASS_NAME =
  '!text-[var(--vds-brand-bg-default)]'
const PROJECT_MENU_SECTION_LABEL_CLASS_NAME =
  'px-3 pb-1 pt-1 text-[12px] text-[var(--vds-text-placeholder)]'

/**
 * 项目切换下拉（顶栏、0.1 首页与工作台空态共用）。
 *
 * 只包"菜单"这一半，不包触发按钮：各处按钮形态不同（顶栏是 pill，首页是
 * 输入框旁的小胶囊，空态是一颗大按钮），但菜单内容与选中语义完全一致。
 *
 * 开合与定位由调用方的 Popover 原子组件负责；这里仅渲染内容，避免业务菜单
 * 自己维护绝对定位、遮罩和点外部关闭。
 *
 * `createEntry` 让调用方关掉底部的「新建项目」：空态那一处紧挨着就有一颗
 * 「新建项目」按钮，菜单里再来一条是同一个动作的第二个入口。
 */
export function ProjectMenu({
  onClose,
  createEntry = true
}: {
  onClose: () => void
  createEntry?: boolean
}): React.JSX.Element {
  const { state, set, act } = useApp()
  const { t } = useTranslation('shell')

  // 顺序来自服务端: `/api/content/projects` 已按创建时间倒序返回。
  const ordered = state.projects
  const activeProjectId =
    state.mainView === 'home' ? null : state.homeSelectedProjectId

  return (
    <div
      className="flex max-h-[320px] w-[196px] flex-col"
      data-testid="project-menu"
    >
      <Button
        className={cx(
          PROJECT_MENU_ITEM_CLASS_NAME,
          state.mainView === 'home' && PROJECT_MENU_ITEM_ACTIVE_CLASS_NAME
        )}
        data-testid="project-menu-overview"
        onClick={() => {
          onClose()
          act.openWorkbenchView('home')
        }}
        variant="ghost"
      >
        <House size={16} strokeWidth={1.45} />
        <span
          className={cx(
            PROJECT_MENU_LABEL_CLASS_NAME,
            state.mainView === 'home' && PROJECT_MENU_LABEL_ACTIVE_CLASS_NAME
          )}
        >
          {t('chrome.projectOverview')}
        </span>
      </Button>
      <Button
        className={cx(
          PROJECT_MENU_ITEM_CLASS_NAME,
          state.mainView === 'literature' &&
            !state.homeSelectedProjectId &&
            PROJECT_MENU_ITEM_ACTIVE_CLASS_NAME
        )}
        data-testid="project-menu-literature"
        onClick={() => {
          onClose()
          act.openWorkbenchView('literature')
        }}
        variant="ghost"
      >
        <LibraryBig size={16} strokeWidth={1.45} />
        <span
          className={cx(
            PROJECT_MENU_LABEL_CLASS_NAME,
            state.mainView === 'literature' &&
              !state.homeSelectedProjectId &&
              PROJECT_MENU_LABEL_ACTIVE_CLASS_NAME
          )}
        >
          {t('chrome.literatureOverview')}
        </span>
      </Button>
      {ordered.length > 0 && (
        <div className="mx-2 my-2 h-px shrink-0 bg-[var(--vds-divider-default)]" />
      )}
      <div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
        {ordered.map((project) => {
          const active = project.id === activeProjectId

          return (
            <Button
              key={project.id}
              className={cx(
                PROJECT_MENU_ITEM_CLASS_NAME,
                active && PROJECT_MENU_ITEM_ACTIVE_CLASS_NAME
              )}
              data-testid={`project-menu-option-${project.name}`}
              onClick={() => {
                onClose()
                act.selectProject(project.id)
                act.openWorkbenchView('resource')
              }}
              variant="ghost"
            >
              <Box size={16} strokeWidth={1.45} />
              <span
                className={cx(
                  PROJECT_MENU_LABEL_CLASS_NAME,
                  active && PROJECT_MENU_LABEL_ACTIVE_CLASS_NAME
                )}
                title={project.path}
              >
                {project.name}
              </span>
              {active && (
                <Check
                  aria-hidden="true"
                  className="shrink-0 text-[var(--vds-brand-bg-default)]"
                  size={18}
                  strokeWidth={1.8}
                />
              )}
            </Button>
          )
        })}
      </div>
      {createEntry && (
        <>
          <div className="mx-2 my-2 h-px shrink-0 bg-[var(--vds-divider-default)]" />
          <Button
            className={cx(PROJECT_MENU_ITEM_CLASS_NAME, 'justify-start')}
            data-testid="project-menu-create"
            onClick={() => {
              onClose()
              set({ projectForm: { mode: 'create' } })
            }}
            variant="ghost"
          >
            <IconFont type="line-operation-add" />
            <span className={PROJECT_MENU_LABEL_CLASS_NAME}>
              {t('projectMenu.create')}
            </span>
          </Button>
        </>
      )}
    </div>
  )
}
