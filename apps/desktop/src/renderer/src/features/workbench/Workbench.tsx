import React, { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpenText, Folders } from 'lucide-react'

import { featureRegistry } from '../../app/composition'
import { Button, Popover, PopoverContent, PopoverTrigger } from '../../components/ui'
import { Icon } from '../../icons'
import { Pending } from '../../shell/Pending'
import { PROJECT_POPOVER_CONTENT_CLASS, ProjectMenu } from '../../shell/ProjectMenu'
import { hasProjectScope, selectedProject, useApp } from '../../store'
import { DocumentDock } from './Dock'
import { FIXED_TAB_BY_VIEW, OVERVIEW_TAB, tabMatchesProject, viewerForPath } from './tabs'
import { documentNavigationView, useDocumentWorkspace } from './workspace'

/**
 * 中央工作区：按当前激活标签渲染对应视图。
 *
 * 改造前这里有两串 switch（标签种类 + 文件扩展名）。现在两者都改为查
 * `featureRegistry.viewers` —— 架构文档 §4.3 明令不得在 Shell 按文件扩展名、
 * 库类型或业务状态写硬编码分支。
 *
 * 总览页仍留在本文件：它是 Shell 自己的空态页（项目信息 + 引导），
 * 不属于任何一个业务 Feature。
 */
export function Workbench(): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const { state, set } = useApp()
  const documents = useDocumentWorkspace()
  const activeTab = state.tabs.find((entry) => entry.id === state.activeTab && tabMatchesProject(entry, state.homeSelectedProjectId))
  const focusedTab = documents.focusedTabId ? documents.tabs[documents.focusedTabId] : undefined
  const focusedSession = focusedTab ? documents.sessions[focusedTab.sessionId] : undefined
  const focusedDocument = focusedTab && focusedSession
    && documentNavigationView(focusedTab, focusedSession) === state.mainView
      ? focusedTab
      : undefined
  const fallbackTabId = focusedDocument?.id
    ?? FIXED_TAB_BY_VIEW[state.mainView]?.id
    ?? OVERVIEW_TAB.id
  const activeTabNeedsSync = !activeTab && !documents.tabs[state.activeTab]
  const tab = activeTab ?? (
    activeTabNeedsSync && !focusedDocument
      ? state.tabs.find((entry) => entry.id === fallbackTabId)
      : undefined
  )
  const kind = tab?.kind === 'file' ? viewerForPath(tab.id) : tab?.kind
  const viewer = kind ? featureRegistry.viewers.get(kind) : undefined
  const contributedViewActive = Boolean(tab && tab.kind !== 'file' && viewer)

  useEffect(() => {
    if (!activeTabNeedsSync) return
    set((current) => (
      current.activeTab === fallbackTabId
        ? current
        : { ...current, activeTab: fallbackTabId }
    ))
  }, [activeTabNeedsSync, fallbackTabId, set])

  // Closing a split document updates the document workspace first. The app-level
  // activeTab may briefly still point at the removed projection, so keep rendering
  // the focused document pane instead of falling through to the overview.
  if (documents.tabs[state.activeTab]) return <DocumentDock />
  if (activeTabNeedsSync && focusedDocument) return <DocumentDock />
  if (!tab || tab.kind === 'overview') return <Overview />

  // 业务 Feature 自己贡献的 viewer 优先展示；否则恢复仍打开的文档会话。
  // 这里不枚举文献库/搜索等业务 kind，新增 viewer 不需要再扩 Shell 分支。
  if (!contributedViewActive && Object.keys(documents.tabs).length > 0) {
    return <DocumentDock />
  }

  // 文件标签的 viewer 由扩展名得出；其余标签种类本身就是 viewer 名
  // （literature / review），因此两者统一成一个 kind 后查同一张表。
  if (!viewer) {
    return (
      <Pending
        feature={t('unavailable.tab')}
        owner={t('unavailable.workspace')}
        detail={t('unavailable.viewer', { kind: kind ?? '' })}
      />
    )
  }
  return <>{viewer.render({ active: true, path: tab.id, tabId: tab.id })}</>
}

/** 项目总览页（对齐原型截图 1）。 */
function Overview(): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const { state, set, act } = useApp()
  const activeProject = selectedProject(state)
  if (!hasProjectScope(state)) return <BlankProject />
  // 标题取名优先级：已选项目名 > 后端实际解析出的工作区目录名。
  // 只看 projects 列表会在「用 SCHOLARSEED_DEFAULT_WORKSPACE 直接打开一个本地目录」
  // 时显示「未选择项目」，而旁边的文件树却已经列出了真实文件 —— 两边矛盾。
  const workspaceName = state.resource.root
    ? (state.resource.root.split('/').filter(Boolean).pop() ?? '')
    : ''
  const title = activeProject?.name || workspaceName
  // PRD「新建项目」: 空项目要给「暂无资料或文献」与两个接入入口, 不能说「已关联」。
  const empty = state.resource.tree.length === 0 && state.literature.total === 0

  return (
    <div className="vds-overview" data-testid="workbench-overview">
      <div className="vds-overview-inner">
        <div className="vds-overview-kicker">
          <Icon name="folder" size={13} />
          <span>{t('overview.currentProject')}</span>
        </div>
        <h1 className="vds-overview-title cursor-text select-text">{title}</h1>
        {state.resource.root && (
          <div className="vds-overview-path cursor-text select-text" title={state.resource.root}>
            {state.resource.root}
          </div>
        )}
        {empty ? (
          <>
            <p className="vds-overview-empty cursor-text select-text" data-testid="workbench-overview-empty">{t('overview.empty')}</p>
            <div className="vds-overview-acts">
              <Button
                data-testid="overview-import-literature"
                icon={<BookOpenText size={14} strokeWidth={1.6} />}
                onClick={() => {
                  // 复用文献库已有的导入流程: 切到文献视图并保留当前项目作用域，
                  // 落在本项目的「文献库」而不是清空作用域跳到全局「文献总览」，再展开导入菜单。
                  act.openWorkbenchView('literature', { preserveProject: true })
                  act.patchLiterature({ importMenuOpen: true })
                }}
                variant="outline"
              >
                {t('overview.importLiterature')}
              </Button>
              <Button
                data-testid="overview-import-resource"
                icon={<Folders size={14} strokeWidth={1.6} />}
                onClick={() => set({ resource: { ...state.resource, importDialog: { phase: 'select', targetDir: '' } } })}
              >
                {t('overview.importResources')}
              </Button>
            </div>
          </>
        ) : (
          <p className="vds-overview-desc cursor-text select-text">
            {t('overview.description')}
          </p>
        )}

      </div>
    </div>
  )
}

/**
 * 未选择项目时的工作台内容（对齐原型 welcome 面）。
 *
 * 「打开」就地展开项目选择下拉，而不是选一个本机文件夹：0.2 起项目身份是
 * 登记表里的 id，绝对路径当身份会在改名/移动后立刻断链（proposal 47 §5.2）。
 * 下拉的开合是这颗按钮自己的局部状态 —— 它锚定按钮下方，不是顶栏那一份。
 */
function BlankProject(): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const { set } = useApp()
  const [pickerOpen, setPickerOpen] = React.useState(false)

  return (
    <div className="vds-blank" data-testid="workbench-blank">
      <div className="vds-blank-sheet">
        <div className="vds-blank-brand">{t('welcome.brand')}</div>
        <p className="vds-blank-lead">{t('welcome.description')}</p>
        <div className="vds-blank-acts">
          <Button
            className="vds-blank-action"
            data-testid="workbench-blank-create"
            icon={<Icon name="plus" size={16} color="currentColor" />}
            onClick={() => set({ projectForm: { mode: 'create' } })}
          >
            {t('welcome.create')}
          </Button>
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <div className="vds-blank-open">
              <PopoverTrigger asChild>
                <Button
                  className="vds-blank-action"
                  data-testid="workbench-blank-open"
                  aria-haspopup="menu"
                  icon={<Icon name="folder" size={16} />}
                  variant="outline"
                >
                  {t('welcome.open')}
                </Button>
              </PopoverTrigger>
              <PopoverContent className={`${PROJECT_POPOVER_CONTENT_CLASS} text-left`}>
                <ProjectMenu
                  onClose={() => setPickerOpen(false)}
                  createEntry={false}
                />
              </PopoverContent>
            </div>
          </Popover>
        </div>
      </div>
    </div>
  )
}
