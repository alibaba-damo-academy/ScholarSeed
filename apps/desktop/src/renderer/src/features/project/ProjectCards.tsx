import React from 'react'
import { useTranslation } from 'react-i18next'

import { createFormatters } from '../../../../localization/format'
import { Project } from '../../api'
import { Button, IconButton, Input } from '../../components/ui'
import { Icon } from '../../icons'
import { filterProjects, projectFileLabel, projectSummary, projectTimeLabel } from '../../project'
import { useApp } from '../../store'


function ProjectCard({ project }: { project: Project }): React.JSX.Element {
  const { t, i18n } = useTranslation('project')
  const format = createFormatters(i18n.resolvedLanguage === 'en' ? 'en' : 'zh')
  const { state, set, act } = useApp()
  const summary = projectSummary(project, state.sessions)
  const updated = projectTimeLabel(summary.activityAt, t, format)

  return (
    <article className="project-card" data-testid={`project-card-${project.name}`}>
      <Button
        className="project-card-main"
        // 不能用 startDraft：它走 HOME_RESET（含 mainView: 'home'），会把用户从
        // 工作台弹回 0.1 双栏。选中语义与顶栏项目菜单保持一致。
        onClick={() => {
          act.selectProject(project.id)
          act.openWorkbenchView('resource')
        }}
        title={t('cards.enter', { name: project.name })}
        variant="ghost"
      >
        <span className="project-card-head">
          <span className="project-card-icon"><Icon name="folder" size={17} /></span>
          <strong>{project.name}</strong>
        </span>
        <span className="project-card-description">{t('cards.description')}</span>
        <span className="project-card-path" title={project.path}>{project.path}</span>
        <span className="project-card-footer">
          <span>{t('cards.chats', { total: summary.chats })}</span>
          <span>{projectFileLabel(project, t)}{updated ? ` · ${updated}` : ''}</span>
        </span>
      </Button>
      <IconButton
        className="hov project-card-edit"
        data-testid={`project-card-edit-${project.name}`}
        icon={<Icon name="more-horizontal" size={14} />}
        label={t('cards.edit', { name: project.name })}
        onClick={() => set({ projectForm: { mode: 'edit', project } })}
        variant="ghost"
      />
    </article>
  )
}

export function ProjectCards(): React.JSX.Element {
  const { t } = useTranslation('project')
  const { state, set } = useApp()
  const [query, setQuery] = React.useState('')
  const visible = filterProjects(state.projects, query).sort((left, right) => (
    projectSummary(right, state.sessions).activityAt
    - projectSummary(left, state.sessions).activityAt
  ))

  return (
    <div className="projects-page" data-testid="projects-page">
      <header className="projects-header">
        <div className="projects-heading">
          <h1>{t('cards.title')}</h1>
          <span>{t('cards.total', { total: state.projects.length })}</span>
          <span className="projects-scope">{t('cards.scope')}</span>
        </div>
        <div className="projects-search">
          <Icon name="search" size={14} />
          <Input
            type="search"
            value={query}
            data-testid="projects-search"
            placeholder={t('cards.search')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button
          className="projects-create"
          data-testid="projects-create"
          onClick={() => set({ projectForm: { mode: 'create' } })}
        >
          <Icon name="plus" size={14} color="currentColor" />
          {t('cards.create')}
        </Button>
      </header>

      <main className="projects-body">
        {visible.map((project) => <ProjectCard key={project.path} project={project} />)}
        {!query.trim() && (
          <Button
            className="project-card project-card-add"
            data-testid="project-card-create"
            onClick={() => set({ projectForm: { mode: 'create' } })}
            variant="ghost"
          >
            <Icon name="plus" size={19} />
            <strong>{t('cards.create')}</strong>
            <span>{t('cards.createHint')}</span>
          </Button>
        )}
        {query.trim() && visible.length === 0 && (
          <div className="projects-empty" data-testid="projects-empty">{t('cards.noMatch')}</div>
        )}
      </main>
    </div>
  )
}
