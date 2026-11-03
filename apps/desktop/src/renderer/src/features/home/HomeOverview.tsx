import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronLeft, ChevronRight, Folder, MessageCircle, Plus } from 'lucide-react'

import { listAllSessions, type Project, type ServeSession } from '../../api'
import brandMark from '../../assets/logo.svg'
import projectEmpty from '../../assets/project-empty.webp'
import emptyFolder from '../../assets/empty_img.webp'
import homeBook from '../../assets/home_book.webp'
import { ProjectActionsMenu } from '../../components/business/ProjectActions'
import { IconFont } from '../../components/primitive/Iconfont'
import {
  Alert,
  Button,
  Card,
  EllipsisText,
  EmptyState,
  IconButton,
  Page,
  PageBody,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SearchBox,
  Spinner,
} from '../../components/ui'
import { TaskStatus } from '../../components/business/TaskStatus'
import { findSessionNode, serveSessionNode } from '../../tree'
import { sessionNeedsAttention } from '../../attention'
import { useAttention } from '../assistant/attention'
import { createFormatters } from '../../../../localization/format'
import { isProjectAvailable } from '../../project'
import { sessionDisplayTitle } from '../../session'
import { useApp } from '../../store'
import { PROJECT_POPOVER_CONTENT_CLASS, ProjectMenu } from '../../shell/ProjectMenu'
import {
  activityLabel,
  HOME_PROJECT_PAGE_SIZE,
  HOME_TASK_LIMIT,
  HOME_TASK_PAGE_SIZE,
  orderedProjects,
  projectActivity,
  recentTasks,
  taskActivity,
} from './catalog'

export function HomeOverview(): React.JSX.Element {
  const { state, set, act } = useApp()
  const reminders = useAttention()
  const { t } = useTranslation('layout')
  const { t: assistantText } = useTranslation('assistant')
  const [sessions, setSessions] = useState<ServeSession[]>([])
  const [query, setQuery] = useState('')
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [projectPage, setProjectPage] = useState(0)
  const [taskPage, setTaskPage] = useState(0)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [revision, setRevision] = useState(0)
  const format = createFormatters(state.lang)
  useEffect(() => {
    let active = true
    setPhase((current) => (current === 'ready' ? current : 'loading'))
    void listAllSessions(
      { scope: 'all', limit: HOME_TASK_LIMIT, includeAgentReplyAt: true },
      () => active
    ).then((rows) => {
      if (!active) return
      if (!rows) {
        setPhase('error')
        return
      }
      setSessions(rows)
      setPhase('ready')
    })
    return () => {
      active = false
    }
  }, [state.backendReady, state.sessionCatalogRevision, revision])
  const activity = projectActivity(sessions)
  const projects = orderedProjects(state.projects, query, activity)
  const recent = recentTasks(state.projects, sessions, '')
  const emptyProjects = state.projects.length === 0
  const showTasks = !emptyProjects && (phase !== 'ready' || recent.length > 0)
  const lastProjectPage = Math.max(0, Math.ceil(projects.length / HOME_PROJECT_PAGE_SIZE) - 1)
  const currentProjectPage = Math.min(projectPage, lastProjectPage)
  const lastTaskPage = Math.max(0, Math.ceil(recent.length / HOME_TASK_PAGE_SIZE) - 1)
  const currentTaskPage = Math.min(taskPage, lastTaskPage)
  const time = (value: number): string => activityLabel(value, format)
  const openProject = (project: Project): void => {
    act.selectProject(project.id)
    act.openWorkbenchView('resource')
  }
  return (
    <Page padding="none" className="h-full !gap-0" data-testid="project-center">
      <header className="flex h-[var(--vds-layout-overview-header-height)] shrink-0 items-center justify-end gap-[var(--vds-space-3)] border-b border-[var(--vds-divider-default)] pl-[var(--vds-space-5)] pr-[var(--vds-space-4)] [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]">
        <Popover open={projectMenuOpen} onOpenChange={setProjectMenuOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto"
              data-testid="home-project-selector"
            >
              {t('projects')}
              <ChevronDown />
            </Button>
          </PopoverTrigger>
          <PopoverContent className={PROJECT_POPOVER_CONTENT_CLASS}>
            <ProjectMenu onClose={() => setProjectMenuOpen(false)} />
          </PopoverContent>
        </Popover>
      </header>
      <PageBody
        scroll="content"
        className="px-[var(--vds-layout-page-padding)] pt-[var(--vds-layout-home-content-padding-top)] pb-[var(--vds-space-6)]"
      >
        <div
          className={`mx-auto grid w-full min-w-0 gap-[var(--vds-space-6)] ${emptyProjects ? 'max-w-[var(--vds-layout-home-empty-content-width)]' : 'max-w-[var(--vds-layout-home-content-width)]'}`}
        >
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-[var(--vds-space-3)]">
            <h1 className="flex items-center gap-[var(--vds-space-3)] font-[family-name:var(--vds-font-serif)] text-[length:var(--vds-font-display-lv4)] leading-[var(--vds-lh-display-lv4)] font-[var(--vds-fw-semibold)]">
              <img src={brandMark} alt="" className="size-[var(--vds-space-10)] shrink-0" />
              {t('welcome')}
            </h1>
            <div className="ml-auto flex items-center gap-[var(--vds-space-3)]">
              {!emptyProjects && (
                <SearchBox
                  size="md"
                  containerClassName="[-webkit-app-region:no-drag]"
                  className="w-[var(--vds-layout-home-search-width)]"
                  aria-label={t('search')}
                  placeholder={t('search')}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    setProjectPage(0)
                  }}
                />
              )}
              <Button
                onClick={() => set({ projectForm: { mode: 'create' } })}
                data-testid="home-project-create-top"
              >
                <Plus />
                {t('newProject')}
              </Button>
            </div>
          </div>
          <div
            className={`grid min-w-0 items-start gap-[var(--vds-space-6)] ${showTasks ? 'grid-cols-2' : 'grid-cols-1'}`}
          >
            <section
              className={`grid min-w-0 content-start ${emptyProjects ? 'gap-[var(--vds-space-3)]' : 'gap-[var(--vds-space-4)]'}`}
              aria-labelledby="home-projects-heading"
            >
              <div className="flex items-center justify-between gap-[var(--vds-space-2)]">
                <h2
                  id="home-projects-heading"
                  className="text-[length:var(--vds-font-subhead)] !font-[var(--vds-fw-medium)]"
                >
                  {t('myProjects')}
                </h2>
                {!emptyProjects && (
                  <div className="flex items-center gap-[var(--vds-space-1)]">
                    <IconButton
                      variant="ghostIcon"
                      size="xs"
                      icon={<ChevronLeft strokeWidth={1.5} />}
                      className="!size-[var(--vds-icon-8)] !min-w-0 !border-0 !p-0 [&_svg]:!size-[var(--vds-icon-8)]"
                      label={t('previousProjects')}
                      data-testid="home-projects-previous"
                      disabled={currentProjectPage === 0}
                      onClick={() => setProjectPage(currentProjectPage - 1)}
                    />
                    <IconButton
                      variant="ghostIcon"
                      size="xs"
                      icon={<ChevronRight strokeWidth={1.5} />}
                      className="!size-[var(--vds-icon-8)] !min-w-0 !border-0 !p-0 [&_svg]:!size-[var(--vds-icon-8)]"
                      label={t('nextProjects')}
                      data-testid="home-projects-next"
                      disabled={currentProjectPage === lastProjectPage}
                      onClick={() => setProjectPage(currentProjectPage + 1)}
                    />
                  </div>
                )}
              </div>
              {emptyProjects && (
                <div
                  className="relative grid min-h-[var(--vds-layout-home-empty-height)] items-center overflow-hidden rounded-[var(--vds-radius-6)] bg-[var(--vds-bg-page)]"
                  data-testid="home-projects-empty"
                >
                  <EmptyState
                    className="!gap-[var(--vds-space-2)] !p-0 font-[family-name:var(--vds-font-main)] [--vds-empty-state-image-height:var(--vds-layout-home-empty-image-size)] [--vds-empty-state-image-width:var(--vds-layout-home-empty-image-size)] [&>div:first-of-type]:max-w-none [&>div:first-of-type]:gap-[var(--vds-space-2)] [&>div>div:first-child]:text-[length:var(--vds-font-body-lv2)] [&>div>div:first-child]:leading-[var(--vds-lh-body-lv2)] [&>div>div:first-child]:font-[var(--vds-fw-medium)] [&>div>div:first-child]:text-[var(--vds-text-primary)] [&>div>div:last-child]:text-[length:var(--vds-font-body-lv2)] [&>div>div:last-child]:font-[var(--vds-fw-regular)] [&>div>div:last-child]:text-[var(--vds-text-tertiary)] [&>div>div:last-child]:leading-[var(--vds-control-label-line-height)]"
                    image={{ src: emptyFolder, alt: '' }}
                    title={t('firstProjectTitle')}
                    description={t('firstProjectDescription')}
                    action={
                      <Button
                        variant="outline"
                        size="sm"
                        className="!h-[var(--vds-control-height-md)] !gap-[var(--vds-layout-home-project-content-gap)] !border-[var(--vds-divider-default)] !leading-[var(--vds-control-label-line-height)] !font-[var(--vds-fw-regular)]"
                        data-testid="home-project-create-empty"
                        onClick={() => set({ projectForm: { mode: 'create' } })}
                      >
                        <Plus />
                        {t('newProject')}
                      </Button>
                    }
                  />
                  <img
                    src={homeBook}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                    className="pointer-events-none absolute right-[var(--vds-layout-home-empty-book-inset)] bottom-[var(--vds-layout-home-empty-book-bottom)] size-[var(--vds-layout-home-empty-book-size)]"
                  />
                </div>
              )}
              {!emptyProjects && !projects.length && (
                <EmptyState
                  data-testid="home-projects-no-results"
                  className="min-h-[var(--vds-layout-home-empty-height)] content-center !gap-[var(--vds-space-2)] !p-0 [--vds-empty-state-image-height:var(--vds-layout-home-empty-image-size)] [--vds-empty-state-image-width:var(--vds-layout-home-empty-image-size)] [&>div:first-of-type]:max-w-none [&>div>div:first-child]:text-[length:var(--vds-font-body-lv2)] [&>div>div:first-child]:leading-[var(--vds-lh-body-lv2)] [&>div>div:first-child]:font-[var(--vds-fw-medium)]"
                  image={{ src: projectEmpty, alt: '' }}
                  title={t('projectSearchNoResults')}
                />
              )}
              <div
                className="grid min-w-0 grid-cols-1 gap-[var(--vds-space-3)]"
                data-testid="home-projects-grid"
              >
                {projects
                  .slice(
                    currentProjectPage * HOME_PROJECT_PAGE_SIZE,
                    (currentProjectPage + 1) * HOME_PROJECT_PAGE_SIZE
                  )
                  .map((project) => {
                    const latest = activity.get(project.path) ?? 0
                    return (
                      <Card
                        key={project.id}
                        padding="md"
                        className="group relative flex min-h-[var(--vds-layout-home-project-card-height)] min-w-0 items-start gap-[var(--vds-space-2)] !border-[var(--vds-border-default)] !bg-transparent !shadow-none [--vds-card-radius:var(--vds-radius-6)] [--vds-card-padding-md:var(--vds-layout-home-project-card-padding)] hover:!bg-[var(--vds-bg-gray-default-transparent)]"
                      >
                        <Button
                          variant="ghost"
                          size="content"
                          className="!min-w-0 flex-1 !shrink !self-stretch !justify-start !border-0 !p-0 text-left hover:!bg-transparent"
                          disabled={!isProjectAvailable(project)}
                          data-testid={`home-project-${project.name}`}
                          onClick={() => openProject(project)}
                        >
                          <span className="grid min-w-0 w-full grid-cols-1 content-center gap-[var(--vds-layout-home-project-content-gap)]">
                            <span className="flex min-w-0 items-center justify-between gap-[var(--vds-space-half)]">
                              <span className="flex min-w-0 items-center gap-[var(--vds-layout-home-project-content-gap)]">
                                <EllipsisText
                                  wrapperClassName="min-w-0"
                                  className="text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-layout-home-project-title-line-height)] font-[var(--vds-fw-medium)] text-[var(--vds-text-primary)]"
                                >
                                  {project.name}
                                </EllipsisText>
                                {project.pinned && (
                                  <IconFont
                                    type="line-tool-pin"
                                    className="inline-flex size-[var(--vds-icon-7)] shrink-0 items-center justify-center !text-[length:var(--vds-icon-7)] !leading-none text-[var(--vds-brand-text-primary)]"
                                  />
                                )}
                              </span>
                              <span className="ml-auto min-w-[var(--vds-control-height-sm)] shrink-0 text-right text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-placeholder)] group-hover:invisible group-has-[:focus-visible]:invisible group-has-[[aria-expanded=true]]:invisible">
                                {latest ? time(latest) : null}
                              </span>
                            </span>
                            <EllipsisText
                              wrapperClassName="min-h-[var(--vds-lh-body-lv1)]"
                              className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]"
                            >
                              {project.description || t('noDescription')}
                            </EllipsisText>
                            <span className="flex min-w-0 items-center gap-[var(--vds-layout-home-project-content-gap)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]">
                              <Folder className="size-[var(--vds-icon-6)] shrink-0" />
                              <EllipsisText>{project.path}</EllipsisText>
                            </span>
                            {!isProjectAvailable(project) && <span>{t('unavailable')}</span>}
                          </span>
                        </Button>
                        <ProjectActionsMenu
                          project={project}
                          idPrefix="home-"
                          triggerOrientation="vertical"
                          triggerClassName="absolute right-[var(--vds-space-3)] top-[var(--vds-space-3)] z-[var(--vds-z-local-control)] shrink-0 opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 aria-expanded:opacity-100"
                          triggerTestId={`home-project-menu-${project.id}`}
                        />
                      </Card>
                    )
                  })}
              </div>
            </section>
            {showTasks && (
              <section
                className="grid min-w-0 content-start gap-[var(--vds-space-4)]"
                aria-labelledby="home-tasks-heading"
              >
                <div className="flex items-center justify-between gap-[var(--vds-space-2)]">
                  <h2
                    id="home-tasks-heading"
                    className="text-[length:var(--vds-font-subhead)] !font-[var(--vds-fw-medium)]"
                  >
                    {t('myTasks')}
                  </h2>
                  <div className="flex items-center gap-[var(--vds-space-1)]">
                    <IconButton
                      variant="ghostIcon"
                      size="xs"
                      icon={<ChevronLeft strokeWidth={1.5} />}
                      className="!size-[var(--vds-icon-8)] !min-w-0 !border-0 !p-0 [&_svg]:!size-[var(--vds-icon-8)]"
                      label={t('previousTasks')}
                      data-testid="home-tasks-previous"
                      disabled={currentTaskPage === 0}
                      onClick={() => setTaskPage(currentTaskPage - 1)}
                    />
                    <IconButton
                      variant="ghostIcon"
                      size="xs"
                      icon={<ChevronRight strokeWidth={1.5} />}
                      className="!size-[var(--vds-icon-8)] !min-w-0 !border-0 !p-0 [&_svg]:!size-[var(--vds-icon-8)]"
                      label={t('nextTasks')}
                      data-testid="home-tasks-next"
                      disabled={currentTaskPage === lastTaskPage}
                      onClick={() => setTaskPage(currentTaskPage + 1)}
                    />
                  </div>
                </div>
                {phase === 'loading' && <Spinner />}
                {phase === 'error' && (
                  <Alert>
                    {t('loadFailed')}
                    <Button onClick={() => setRevision((current) => current + 1)}>
                      {t('retry')}
                    </Button>
                  </Alert>
                )}
                <Card
                  padding="none"
                  className="min-w-0 overflow-hidden !bg-transparent !shadow-none [--vds-card-radius:var(--vds-radius-6)]"
                  data-testid="home-tasks-list"
                >
                  {recent
                    .slice(
                      currentTaskPage * HOME_TASK_PAGE_SIZE,
                      (currentTaskPage + 1) * HOME_TASK_PAGE_SIZE
                    )
                    .map((session) => {
                      const project = state.projects.find(
                        (entry) => entry.path === session.project_path
                      )!
                      const node =
                        findSessionNode(state.sessions ?? [], session.session_id) ??
                        serveSessionNode(
                          session,
                          state.sessionActivitySeen ?? {},
                          state.activeSession
                        )
                      return (
                        <Button
                          key={session.session_id}
                          data-testid={`home-task-${session.session_id}`}
                          variant="ghost"
                          size="content"
                          className="relative w-full !h-[var(--vds-layout-home-task-height)] !items-start !justify-start !gap-[var(--vds-layout-home-task-gap)] !rounded-none !border-0 !px-[var(--vds-space-3)] !py-[var(--vds-space-3)] text-left !text-[length:var(--vds-font-body-lv2)] !leading-[var(--vds-layout-home-task-title-line-height)] !font-[var(--vds-fw-regular)] !text-[var(--vds-text-primary)] after:absolute after:inset-x-[var(--vds-space-3)] after:bottom-0 after:h-[var(--vds-border-width-1)] after:bg-[var(--vds-divider-default)] last:after:hidden"
                          onClick={() => {
                            openProject(project)
                            act.openSession(session.session_id)
                          }}
                        >
                          <span className="inline-flex h-[var(--vds-layout-home-task-title-line-height)] shrink-0 items-center">
                            <TaskStatus
                              node={node}
                              unread={sessionNeedsAttention(reminders.by_session[node.id] ?? 0)}
                              fallback={
                                <MessageCircle
                                  aria-hidden="true"
                                  strokeWidth={1.5}
                                  className="size-[var(--vds-icon-8)] text-[var(--vds-text-tertiary)]"
                                />
                              }
                            />
                          </span>
                          <span className="grid min-w-0 flex-1 grid-cols-1 gap-[var(--vds-layout-home-task-gap)]">
                            <span className="flex min-w-0 items-center justify-between gap-[var(--vds-layout-home-task-gap)]">
                              <EllipsisText
                                tooltipPortalled
                                wrapperClassName="min-w-0 flex-1"
                                className="text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-layout-home-task-title-line-height)] font-[var(--vds-fw-regular)] text-[var(--vds-text-primary)]"
                              >
                                {sessionDisplayTitle(session, assistantText)}
                              </EllipsisText>
                              <span className="shrink-0 text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-placeholder)]">
                                {time(taskActivity(session))}
                              </span>
                            </span>
                            <EllipsisText
                              tooltipPortalled
                              className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]"
                            >
                              {project.name}
                            </EllipsisText>
                          </span>
                        </Button>
                      )
                    })}
                </Card>
              </section>
            )}
          </div>
        </div>
      </PageBody>
    </Page>
  )
}
