import React from 'react'
import { useTranslation } from 'react-i18next'

import { IMPORT_PICKER_TARGET } from '../../../../picker'
import { Button, Checkbox, Input } from '../../components/ui'
import { PROJECT_NAME_MAX } from '../../contracts/content'
import type { ExternalRootRef, ProjectRef } from '../../contracts/content'
import { useApp } from '../../store'
import {
  authorizeRoot,
  createProject,
  listExternalRoots,
  listProjects,
  loadMigrationPlan,
  loadTrashHistory,
  loadWorkspaceRoot,
  renameProject,
  runMigration,
  saveWorkspaceRoot,
  type MigrationPlan,
  type WorkspaceRootState
} from './api'
import { createFormatters } from '../../../../localization/format'

/**
 * 项目面板（开发 1 拥有）。
 *
 * 三件事：新建（只填名字）、改名（只改显示名）、根设置（只影响新建）。
 *
 * 刻意**不**提供「选一个本地目录当项目」：那是 0.2 之前的旧定义，会让绝对
 * 路径重新变成项目身份，改名/移动即断（proposal 47 §5.2）。存量项目仍在列表
 * 里，标 `存量` 徽标。
 */

/** 后端错误码 → 用户能看懂的提示。UI 按码分支，不按文案。 */
const ERROR_KEYS = {
  mount_conflict: 'errors.mount_conflict',
  mount_required: 'errors.mount_required',
  invalid_mount: 'errors.invalid_mount',
  root_exists: 'errors.root_exists',
  unknown_root: 'errors.unknown_root',
  root_already_revoked: 'errors.root_already_revoked',
  source_not_supported: 'errors.source_not_supported',
  source_inside_project: 'errors.source_inside_project',
  source_contains_project: 'errors.source_contains_project',
  name_required: 'errors.name_required',
  no_workspace_root: 'errors.no_workspace_root',
  project_directory_exists: 'errors.project_directory_exists',
  project_create_failed: 'errors.project_create_failed',
  unknown_project: 'errors.unknown_project',
  workspace_root_not_found: 'errors.workspace_root_not_found',
  source_not_found: 'errors.source_not_found',
  already_managed: 'errors.already_managed',
  root_unavailable: 'errors.root_unavailable',
  too_many_entries: 'errors.too_many_entries',
  cannot_forget_current_project: 'errors.cannot_forget_current_project',
  name_too_long: 'errors.name_too_long'
} as const

/** 字节数 → 人能读的量级。迁移清单要让用户判断「这一下要搬多少」。 */
function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

type Notice =
  | { kind: 'error'; code: string }
  | { kind: 'created'; name: string }
  | { kind: 'renamed' | 'savedRestart' | 'saved' | 'linked' | 'planFailed' | 'managed' | 'migrated' }
  | { kind: 'partial'; moved: number; failed: number; paths: string }

function errorNotice(code?: string): Notice | null {
  return code ? { kind: 'error', code } : null
}

export function ProjectPanel(): React.JSX.Element {
  const { state, act } = useApp()
  const { t, i18n } = useTranslation('project')
  const format = createFormatters(i18n.resolvedLanguage === 'en' ? 'en' : 'zh')
  const [projects, setProjects] = React.useState<ProjectRef[]>([])
  const [current, setCurrent] = React.useState('')
  const [workspace, setWorkspace] = React.useState<WorkspaceRootState | null>(null)
  const [draftName, setDraftName] = React.useState('')
  const [renaming, setRenaming] = React.useState<string | null>(null)
  const [renameDraft, setRenameDraft] = React.useState('')
  const [rootDraft, setRootDraft] = React.useState('')
  const [links, setLinks] = React.useState<ExternalRootRef[]>([])
  const [plan, setPlan] = React.useState<MigrationPlan | null>(null)
  const [skipped, setSkipped] = React.useState<string[]>([])
  const [trashed, setTrashed] = React.useState<{ at: number; path: string }[]>([])
  // 撤销授权时是否连带中断正在跑的任务。默认不勾: 中断会打断用户的工作,
  // 但必须给这个选项 —— 已下发给 vendor 的那个 turn 无法中途剥夺写权限,
  // 「立即中断」是能做到的上界 (proposal 47 §6.9)。
  const [interruptOnRevoke, setInterruptOnRevoke] = React.useState(false)
  const [notice, setNotice] = React.useState<Notice | null>(null)

  const noticeText = (): string => {
    if (!notice) return ''
    switch (notice.kind) {
      case 'error': {
        const key = Object.prototype.hasOwnProperty.call(ERROR_KEYS, notice.code) ? ERROR_KEYS[notice.code as keyof typeof ERROR_KEYS] : null
        return key ? t(key, { max: PROJECT_NAME_MAX }) : t('notices.unknown', { code: notice.code })
      }
      case 'created': return t('notices.created', { name: notice.name })
      case 'partial': return t('notices.partial', { moved: notice.moved, failed: notice.failed, paths: notice.paths })
      case 'renamed': return t('notices.renamed')
      case 'savedRestart': return t('notices.savedRestart')
      case 'saved': return t('notices.saved')
      case 'linked': return t('notices.linked')
      case 'planFailed': return t('notices.planFailed')
      case 'managed': return t('notices.managed')
      case 'migrated': return t('notices.migrated')
    }
  }

  const reload = React.useCallback(async (): Promise<void> => {
    const listing = await listProjects()
    if (listing) {
      setProjects(listing.projects)
      setCurrent(listing.current)
    }
    const root = await loadWorkspaceRoot()
    if (root) {
      setWorkspace(root)
      setRootDraft(root.configured || root.root)
    }
    const current = listing?.current ?? ''
    if (current) {
      const roots = await listExternalRoots(current)
      setLinks(roots?.roots ?? [])
      setTrashed(await loadTrashHistory(current))
    }
  }, [])

  React.useEffect(() => {
    void reload()
  }, [reload, state.resource.tree])

  const submitCreate = async (): Promise<void> => {
    const name = draftName.trim()
    if (!name) {
      setNotice(errorNotice('name_required'))
      return
    }
    const result = await createProject(name)
    if (!result.ok) {
      setNotice(errorNotice(result.error))
      return
    }
    setDraftName('')
    setNotice({ kind: 'created', name: result.project?.name ?? name })
    await reload()
  }

  const submitRename = async (id: string): Promise<void> => {
    const name = renameDraft.trim()
    if (!name) {
      setNotice(errorNotice('name_required'))
      return
    }
    const result = await renameProject(id, name)
    setRenaming(null)
    if (!result.ok) {
      setNotice(errorNotice(result.error))
      return
    }
    setNotice({ kind: 'renamed' })
    await reload()
  }

  const submitRoot = async (): Promise<void> => {
    const result = await saveWorkspaceRoot(rootDraft.trim())
    if (!result.ok) {
      setNotice(errorNotice(result.error))
      return
    }
    setWorkspace(result.state ?? workspace)
    setNotice(
      result.state?.restartRequired
        ? { kind: 'savedRestart' }
        : { kind: 'saved' }
    )
  }

  const submitLink = async (): Promise<void> => {
    // 原生多选目录：关联的是项目外的真实目录，路径只能由主进程给出，
    // 让用户在输入框里手打绝对路径既易错又等于把任意路径交给渲染层。
    const picked = await window.scholarseed.pickImport(IMPORT_PICKER_TARGET.DIRECTORY)
    if (!picked.length) return
    for (const source of picked) {
      const mount = source.split('/').filter(Boolean).pop() ?? ''
      const result = await authorizeRoot(current, source, mount)
      if (!result.ok) {
        setNotice(errorNotice(result.error))
        return
      }
    }
    setNotice({ kind: 'linked' })
    await reload()
  }

  // 迁移向导：先 dry-run 给清单（搬什么、多大、有没有冲突），用户确认后才动文件。
  const openMigration = async (projectId: string): Promise<void> => {
    const next = await loadMigrationPlan(projectId)
    if (!next) {
      setNotice({ kind: 'planFailed' })
      return
    }
    if (next.blocked) {
      setNotice(errorNotice(next.blocked))
      return
    }
    setSkipped([])
    setPlan(next)
  }

  const confirmMigration = async (): Promise<void> => {
    if (!plan) return
    const result = await runMigration(plan.project_id, skipped)
    setPlan(null)
    if (!result.ok) {
      setNotice(errorNotice(result.error))
      return
    }
    const outcome = result.outcome
    const failed = outcome?.failed ?? []
    setNotice(
      failed.length
        ? { kind: 'partial', moved: outcome?.moved.length ?? 0, failed: failed.length, paths: failed.map((item) => item.source).join(', ') }
        : outcome?.layout === 'managed'
          ? { kind: 'managed' }
          : { kind: 'migrated' }
    )
    await reload()
  }

  return (
    <section className="vds-module-panel-body project-panel" aria-label={t('title')}>
      <div className="vds-panel-head">
        <h2 className="vds-panel-title">{t('title')}</h2>
      </div>

      <div className="project-create">
        <Input
          className="vds-input"
          placeholder={t('createPlaceholder')}
          value={draftName}
          maxLength={PROJECT_NAME_MAX}
          data-testid="project-create-name"
          onChange={(event) => setDraftName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submitCreate()
          }}
        />
        <Button
          className="vds-button"
          data-testid="project-create-submit"
          onClick={() => void submitCreate()}
        >
          {t('panel.create')}
        </Button>
      </div>

      <ul className="project-list" data-testid="project-list">
        {projects.map((project) => (
          <li
            key={project.id}
            className={`project-item${project.id === current ? ' is-current' : ''}`}
            data-testid={`project-item-${project.id}`}
            data-layout={project.layout}
          >
            {renaming === project.id ? (
              <div className="project-rename">
                <Input
                  className="vds-input"
                  value={renameDraft}
                  autoFocus
                  maxLength={PROJECT_NAME_MAX}
                  data-testid="project-rename-input"
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void submitRename(project.id)
                    if (event.key === 'Escape') setRenaming(null)
                  }}
                />
                <Button
                  className="vds-button"
                  data-testid="project-rename-submit"
                  onClick={() => void submitRename(project.id)}
                >
                  {t('panel.save')}
                </Button>
              </div>
            ) : (
              <Button
                className="project-item-name"
                title={project.root}
                data-testid={`project-open-${project.id}`}
                variant="ghost"
                onDoubleClick={() => {
                  setRenaming(project.id)
                  setRenameDraft(project.name)
                }}
              >
                <span className="project-item-label">{project.name}</span>
                {project.layout === 'legacy' ? (
                  <span className="project-item-badge">{t('legacy')}</span>
                ) : null}
                {project.available ? null : (
                  <span className="project-item-badge is-warning">{t('invalidDirectory')}</span>
                )}
              </Button>
            )}
            {project.layout === 'legacy' && renaming !== project.id ? (
              <Button
                className="project-link-revoke"
                data-testid={`project-migrate-${project.id}`}
                variant="ghost"
                onClick={() => void openMigration(project.id)}
              >
                {t('panel.migrate')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>

      {plan ? (
        <div className="project-migration" data-testid="project-migration-plan">
          <p className="project-root-label">
            {t('panel.migrationTitle', { name: plan.name, size: readableSize(plan.totalSize) })}
          </p>
          <ul className="project-list">
            {plan.entries.map((entry) => (
              <li key={entry.source} className="project-item">
                <Checkbox
                    className="project-item-label"
                    checked={!skipped.includes(entry.source)}
                    data-testid={`project-migration-entry-${entry.source}`}
                    label={`${entry.source} → ${entry.target}`}
                    title={`${entry.source} → ${entry.target}`}
                    onCheckedChange={(checked) =>
                      setSkipped((current) =>
                        checked
                          ? current.filter((item) => item !== entry.source)
                          : [...current, entry.source]
                      )
                    }
                  />
                <span className="project-item-badge">{readableSize(entry.size)}</span>
                {entry.conflict ? (
                  <span className="project-item-badge is-warning">{t('panel.conflict')}</span>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="project-root-hint">
            {t('panel.migrationHint')}
          </p>
          <div className="project-create">
            <Button
              className="vds-button"
              data-testid="project-migration-confirm"
              onClick={() => void confirmMigration()}
            >
              {t('panel.startMigration')}
            </Button>
            <Button
              className="project-link-revoke"
              data-testid="project-migration-cancel"
              variant="ghost"
              onClick={() => setPlan(null)}
            >
              {t('panel.cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="project-links">
        <div className="project-links-head">
          <span className="project-root-label">{t('linkedExternal')}</span>
          <Button
            className="vds-button"
            data-testid="project-link-add"
            onClick={() => void submitLink()}
          >
            {t('panel.link')}
          </Button>
        </div>
        <ul className="project-list" data-testid="project-link-list">
          {links.map((root) => (
            <li key={root.rootId} className="project-item" data-testid={`project-link-${root.rootId}`}>
              <span className="project-item-label" title={root.sourcePath}>
                {root.mountPath}
              </span>
              {root.available ? null : (
                <span className="project-item-badge is-warning">{t('invalidLink')}</span>
              )}
              <Button
                className="project-link-revoke"
                data-testid={`project-link-revoke-${root.rootId}`}
                variant="ghost"
                onClick={() => act.confirmResourceUnlink({
                  rootId: root.rootId,
                  mountPath: root.mountPath,
                  sourcePath: root.sourcePath,
                  name: root.mountPath.split('/').pop() ?? root.mountPath,
                  interruptRunning: interruptOnRevoke
                })}
              >
                {t('panel.revoke')}
              </Button>
            </li>
          ))}
          {links.length === 0 ? <li className="project-root-hint">{t('noLinks')}</li> : null}
        </ul>
        {links.length ? (
          <Checkbox
              className="project-root-hint"
              checked={interruptOnRevoke}
              data-testid="project-link-interrupt"
              label={t('panel.interrupt')}
              onCheckedChange={setInterruptOnRevoke}
            />
        ) : null}
      </div>

      <div className="project-root">
        <label className="project-root-label" htmlFor="project-workspace-root">
          {t('panel.root')}
        </label>
        <Input
          id="project-workspace-root"
          className="vds-input"
          value={rootDraft}
          placeholder={workspace?.root ?? ''}
          data-testid="project-root-input"
          onChange={(event) => setRootDraft(event.target.value)}
        />
        <Button
          className="vds-button"
          data-testid="project-root-submit"
          onClick={() => void submitRoot()}
        >
          {t('panel.save')}
        </Button>
        <p className="project-root-hint">
          {t('panel.effectiveRoot', { path: workspace?.root ?? '—' })}
          {workspace?.configured ? '' : t('panel.fromStartup')}
        </p>
      </div>

      {trashed.length ? (
        <div className="project-links" data-testid="project-trash-history">
          <div className="project-links-head">
            <span className="project-root-label">{t('trash')}</span>
            <Button
              className="vds-button"
              data-testid="project-open-trash"
              onClick={() => void window.scholarseed?.openTrash?.()}
            >
              {t('panel.openTrash')}
            </Button>
          </div>
          <p className="project-root-hint">
            {t('panel.trashHint')}
          </p>
          <ul className="project-list">
            {trashed.slice(0, 5).map((entry) => (
              <li key={`${entry.at}-${entry.path}`} className="project-item">
                <span className="project-item-label" title={entry.path}>
                  {entry.path.split('/').pop()}
                </span>
                <span className="project-item-badge">
                  {format.date(entry.at * 1000, { dateStyle: 'short', timeStyle: 'medium' })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {notice ? (
        <p className="project-notice" data-testid="project-notice">
          {noticeText()}
        </p>
      ) : null}
    </section>
  )
}
