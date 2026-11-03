import React from 'react'
import { useTranslation } from 'react-i18next'
import { Box, Check } from 'lucide-react'

import { IconFont } from '../components/primitive'
import { Button } from '../components/ui'
import { cx } from '../components/ui'
import { ProjectActionsMenu } from '../components/business/ProjectActions'
import { useApp } from '../store'

/** Project selection is a navigation flyout: above chrome, below modal surfaces. */
export const PROJECT_POPOVER_CONTENT_CLASS = ['z-[var(--vds-z-inline-flyout)] w-auto'].join(' ')

const PROJECT_MENU_ITEM_CLASS_NAME =
  'flex h-[var(--vds-control-height-standard)] max-h-[var(--vds-control-height-standard)] min-h-[var(--vds-control-height-standard)] w-full items-center justify-start gap-[var(--vds-space-2)] rounded-[var(--vds-project-menu-item-radius)] border-0 px-[var(--vds-space-3)] py-0 text-left text-[length:var(--vds-font-body-lv2)] transition-[background-color] duration-150 hover:bg-[var(--vds-bg-gray-hover-transparent)]'
const PROJECT_MENU_SUBMENU_GAP = '--vds-project-submenu-gap'
const PROJECT_MENU_ITEM_ACTIVE_CLASS_NAME =
  '![background:var(--vds-brand-light-bg-default)] !text-[var(--vds-brand-bg-default)] hover:![background:var(--vds-brand-light-bg-default)] active:![background:var(--vds-brand-light-bg-default)]'
const PROJECT_MENU_LABEL_CLASS_NAME =
  'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--vds-text-primary)]'
const PROJECT_MENU_LABEL_ACTIVE_CLASS_NAME = '!text-[var(--vds-brand-bg-default)]'

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
  createEntry = true,
}: {
  onClose: () => void
  createEntry?: boolean
}): React.JSX.Element {
  const { state, set, act } = useApp()
  const { t } = useTranslation('shell')
  const { t: layoutText } = useTranslation('layout')
  const horizontalAnchorRef = React.useRef<HTMLElement | null>(null)

  // 顺序来自服务端: `/api/content/projects` 已按创建时间倒序返回。
  const ordered = [...state.projects].sort(
    (left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
  )
  const homeActive = state.mainView === 'home'
  const activeProjectId = homeActive ? null : state.homeSelectedProjectId

  return (
    <div
      className="flex max-h-[320px] w-[196px] flex-col"
      data-testid="project-menu"
      ref={(element) => {
        horizontalAnchorRef.current = element?.parentElement ?? null
      }}
    >
      <Button
        className={cx(
          PROJECT_MENU_ITEM_CLASS_NAME,
          'shrink-0',
          homeActive && PROJECT_MENU_ITEM_ACTIVE_CLASS_NAME
        )}
        aria-current={homeActive ? 'page' : undefined}
        data-testid="project-menu-home"
        onClick={() => {
          onClose()
          act.openProjectCenter({ overview: true })
        }}
        variant="ghost"
      >
        <Box
          className={homeActive ? 'text-[var(--vds-brand-bg-default)]' : 'text-[var(--vds-text-7)]'}
        />
        <span
          className={cx(
            PROJECT_MENU_LABEL_CLASS_NAME,
            homeActive && PROJECT_MENU_LABEL_ACTIVE_CLASS_NAME
          )}
        >
          {layoutText('projects')}
        </span>
        {homeActive && (
          <Check
            aria-hidden="true"
            className="shrink-0 text-[var(--vds-brand-bg-default)]"
            size={18}
            strokeWidth={1.8}
          />
        )}
      </Button>
      <div className="mx-[var(--vds-space-2)] my-[var(--vds-space-2)] h-px shrink-0 bg-[var(--vds-divider-default)]" />
      <div className="flex min-h-0 flex-col gap-[var(--vds-space-1)] overflow-y-auto">
        {ordered.map((project) => {
          const active = project.id === activeProjectId

          return (
            <div
              key={project.id}
              className="group/project-row relative rounded-[var(--vds-project-menu-item-radius)] has-[[aria-expanded=true]]:bg-[var(--vds-bg-gray-hover-transparent)]"
            >
              <Button
                className={cx(
                  PROJECT_MENU_ITEM_CLASS_NAME,
                  active && PROJECT_MENU_ITEM_ACTIVE_CLASS_NAME
                )}
                data-testid={`project-menu-option-${project.name}`}
                aria-current={active ? 'page' : undefined}
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
                {project.pinned && (
                  <IconFont
                    type="line-tool-pin"
                    role="img"
                    aria-hidden={false}
                    aria-label={layoutText('pinned')}
                    className="inline-flex size-[var(--vds-icon-7)] shrink-0 items-center justify-center !text-[length:var(--vds-icon-7)] !leading-none text-[var(--vds-brand-text-primary)]"
                  />
                )}
                <span className="flex w-[var(--vds-control-height-sm)] shrink-0 items-center justify-end">
                  {active && (
                    <Check
                      aria-hidden="true"
                      className="shrink-0 text-[var(--vds-brand-bg-default)] group-hover/project-row:hidden group-has-[[aria-expanded=true]]/project-row:hidden group-has-[button:focus-visible]/project-row:hidden"
                      size={18}
                      strokeWidth={1.8}
                    />
                  )}
                </span>
              </Button>
              <ProjectActionsMenu
                idPrefix="project-menu-"
                project={project}
                side="right"
                horizontalAnchorRef={horizontalAnchorRef}
                sideOffset={PROJECT_MENU_SUBMENU_GAP}
                triggerClassName="absolute inset-y-0 my-auto right-[var(--vds-space-1)] opacity-0 transition-opacity group-hover/project-row:opacity-100 focus-visible:opacity-100 aria-[expanded=true]:opacity-100"
                triggerTestId={`project-menu-actions-${project.id}`}
                onAction={onClose}
              />
            </div>
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
            <span className={PROJECT_MENU_LABEL_CLASS_NAME}>{t('projectMenu.create')}</span>
          </Button>
        </>
      )}
    </div>
  )
}
