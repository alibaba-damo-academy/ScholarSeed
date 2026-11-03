import React from 'react'
import emptyImage from '../../assets/empty_img.webp'
import { createFormatters } from '../../../../localization/format'
import {
  Ellipsis,
  Folders,
  Hammer,
  LockKeyhole,
  MessageCircle,
  RotateCw,
  Trash2,
  Upload,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import {
  SkillDocumentError,
  SkillCatalogError,
  deleteSkill,
  getSkillDocument,
  getSkills,
  setSkillActive,
  SKILL_ERROR_DUPLICATE,
  type SkillInfo,
  type SkillAttributionInfo,
  type MarketplaceSkill,
  uploadSkillFile,
  previewSkillFile,
  type SkillUploadPreview,
} from '../../api'
import { SKILL_SURFACE_SETTINGS } from '../../../../skills'
import { PluginPreview, PluginPreviewDialog, type PluginPreviewRequest } from './Plugin'
import type { PluginReport, PluginInstallationReceipt } from '../../../../plugins'
import { Icon } from '../../icons'
import {
  productSkillGroup,
  skillActivationControl,
  skillDescription,
  skillName,
  skillDocumentBody,
  SKILL_GROUPS,
  type SkillInstallNotice,
  skillMutationMessage,
  type SkillMutationMessage,
  skillUseFailureMessage,
  type TaskStarterSkillFailure,
} from '../../skill'
import { useApp } from '../../store'
import { resolveTaskStarterSkill } from '../../skill'
import { useAccountAccess } from './access'
import { LoginPrompt } from './LoginPrompt'
import { useMarketplace, useSkillUpdates } from './marketplace'
import { Classification } from './Classification'
import { droppedSkillFiles, packageSkillDirectory } from './skillupload'
import { Markdown } from '../primitive/Markdown'
import { IconFont } from '../primitive/Iconfont'
import { FileFormatIcon } from '../primitive/FileIcon'
import {
  Alert,
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogPortal,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  Input,
  SearchBox,
  ScrollArea,
  Spinner,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Label,
  Textarea,
  Switch,
  Tag,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  useToast,
} from '../ui'

const TAB_MARKETPLACE = 'marketplace'
const TAB_SYSTEM = 'scholarseed'
const TAB_USER = 'user'
const PLUGIN_PREVIEW_VISIBLE = false
const HIDDEN_SYSTEM_SKILLS: ReadonlySet<string> = new Set(['plugin-create'])
const SKILL_TABS = [
  { id: TAB_MARKETPLACE, labelKey: 'groups.all' },
  { id: TAB_SYSTEM, labelKey: 'groups.scholarseed' },
  { id: TAB_USER, labelKey: 'groups.user' },
] as const
const UPLOAD_ACCEPT = '.zip,.md'
const PAGE_CLASS = 'relative flex h-full min-h-0 w-full min-w-0 flex-col'
const CONTENT_CLASS =
  'mx-auto w-full max-w-[calc(var(--vds-skills-content-width)+var(--vds-skills-page-inset,var(--vds-space-0))*2)] px-[var(--vds-skills-page-inset,var(--vds-space-0))]'
const LIST_SCROLL_CLASS = 'h-full min-h-0 overflow-y-auto'
const LOADING_TEXT_CLASS =
  'text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]'
const SEARCH_EMPTY_CLASS =
  'min-h-[var(--vds-skills-empty-height)] flex-1 w-full content-center [&_.vds-empty-state\\_\\_title]:text-[length:var(--vds-font-body-lv2)] [&_.vds-empty-state\\_\\_title]:text-[var(--vds-text-secondary)]'
const GRID_CLASS = 'grid grid-cols-1 gap-[var(--vds-space-4)] md:grid-cols-2 lg:grid-cols-3'
const CARD_CLASS =
  'group relative isolate flex flex-col gap-[var(--vds-space-3)] !rounded-[var(--vds-radius-6)] !bg-transparent hover:!bg-[var(--vds-bg-gray-default-transparent)] py-[var(--vds-space-3)] !shadow-none'
const DIALOG_CLASS =
  '!w-[var(--vds-skills-detail-viewport-width)] !max-w-none font-[var(--vds-fw-regular)] [&_*]:!font-[var(--vds-fw-regular)]'
const DOCUMENT_CLASS = [
  'min-h-0 min-w-0 flex-1 overflow-auto rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)] p-[var(--vds-space-4)] leading-[var(--vds-lh-body-lv1)] [overflow-wrap:anywhere]',
  'text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)] [&_*]:!text-[length:var(--vds-font-body-lv1)] [&_*]:!text-[var(--vds-text-secondary)]',
  '[&_.md-h]:!text-[length:var(--vds-font-body-lv2)] [&_.md-h1]:!text-[length:var(--vds-font-subhead)] [&_.md-h2]:!text-[length:var(--vds-font-subhead)]',
  '[&_pre]:max-w-full [&_pre]:overflow-x-auto',
].join(' ')

function groupLabel(skill: SkillInfo, t: TFunction<'skills'>): string {
  const key = SKILL_GROUPS.find((group) => group.id === skill.group)?.labelKey
  return key ? t(key) : ''
}

function installationLabel(skill: SkillInfo, t: TFunction<'skills'>): string {
  if (skill.group === TAB_SYSTEM) return t('attribution.official')
  switch (skill.installationSource) {
    case 'upload':
      return t('attribution.uploaded')
    case 'marketplace':
    case 'github':
      return t('marketplace.github')
    default:
      return t('attribution.local')
  }
}

function SkillUseFailure({
  failure,
  skill,
}: {
  failure: TaskStarterSkillFailure
  skill: SkillInfo
}): React.JSX.Element {
  const { t: translate } = useTranslation('skills')
  return <>{skillUseFailureMessage(translate, failure, skillName(skill))}</>
}

function SkillAttribution({ skill }: { skill: SkillAttributionInfo }): React.JSX.Element {
  const { t } = useTranslation('skills')
  const attribution = skill.attribution
  const url = attribution?.repository_url
  const unavailable =
    skill.attributionStatus === 'invalid' || skill.attributionStatus === 'unavailable'
  const repository = url ? null : (
    <span>{t(unavailable ? 'attribution.unavailable' : 'attribution.missing')}</span>
  )
  return (
    <span className="flex min-w-0 flex-1 items-center gap-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]">
      {url && (
        <Badge
          size="sm"
          variant="secondary"
          className="!rounded-[var(--vds-radius-2)] !bg-[var(--vds-bg-gray-default-transparent)] !font-[var(--vds-fw-regular)] !text-[var(--vds-text-tertiary)]"
        >
          {t('marketplace.github')}
        </Badge>
      )}
      {repository}
    </span>
  )
}

function AddSkillButton({
  onUpload,
  compact = false,
}: {
  onUpload: () => void
  compact?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('skills')

  return (
    <Button
      variant={compact ? 'outline' : 'primary'}
      size={compact ? 'sm' : 'md'}
      icon={<Icon name="plus" size={14} color="currentColor" />}
      data-testid={compact ? 'skills-add-empty' : 'skills-add'}
      onClick={onUpload}
    >
      {t('add')}
    </Button>
  )
}

/** One device-wide settings surface; Composer reuses the same upload dialog. */
type SkillPageNotice =
  | {
      key: 'loadFailed' | 'toggleFailed' | 'documentFailed' | 'deleteFailed' | 'deleted'
      detail?: string
    }
  | { key: 'enabled' | 'disabled'; name: string }
  | SkillInstallNotice
  | SkillMutationMessage

function SkillNotice({ notice }: { notice: SkillPageNotice | string }): React.JSX.Element {
  const { t } = useTranslation('skills')
  if (typeof notice === 'string') return <>{notice}</>
  return (
    <>
      {'name' in notice ? (
        t(notice.key, { name: notice.name })
      ) : (
        <>
          {t(notice.key)}
          {'detail' in notice && notice.detail && <span> {notice.detail}</span>}
        </>
      )}
    </>
  )
}

function SkillLoading(): React.JSX.Element {
  const { t } = useTranslation('skills')
  return (
    <div className="flex flex-1 items-center justify-center">
      <div
        role="status"
        data-testid="skills-loading"
        className={`flex flex-col items-center gap-[var(--vds-space-3)] ${LOADING_TEXT_CLASS}`}
      >
        <Spinner size="md" role="presentation" aria-hidden="true" />
        <span>{t('loading')}</span>
      </div>
    </div>
  )
}

export function Skills(): React.JSX.Element {
  const { state, act } = useApp()
  const { authenticated, revision } = useAccountAccess(state.backendReady)
  const { t, i18n } = useTranslation('skills')
  const language = i18n.resolvedLanguage || i18n.language
  const { t: ui } = useTranslation('ui')
  const { toast } = useToast()
  const [skills, setSkills] = React.useState<SkillInfo[]>([])
  const [tab, setTab] = React.useState(TAB_MARKETPLACE)
  const [queries, setQueries] = React.useState<Record<string, string>>({})
  const query = queries[tab] ?? ''
  const updateQuery = (value: string): void => {
    setQueries((current) => ({ ...current, [tab]: value }))
  }
  const searchRef = React.useRef<HTMLInputElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const paginationRef = React.useRef<HTMLDivElement>(null)
  const [loading, setLoading] = React.useState(true)
  const loaded = React.useRef(false)
  const [loadError, setLoadError] = React.useState<SkillPageNotice | null>(null)
  const loadRequest = React.useRef(0)
  const [notice, setNotice] = React.useState<SkillPageNotice | string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [toggling, setToggling] = React.useState<ReadonlySet<string>>(new Set())
  const [detail, setDetail] = React.useState<{ skill: SkillInfo; document: string } | null>(null)
  const [adding, setAdding] = React.useState(false)
  const [using, setUsing] = React.useState<SkillInfo | null>(null)
  const [enablingUse, setEnablingUse] = React.useState<SkillInfo | null>(null)
  const [useProject, setUseProject] = React.useState('')
  const [useDescription, setUseDescription] = React.useState('')
  const [removing, setRemoving] = React.useState<SkillInfo | null>(null)
  const [preview, setPreview] = React.useState<PluginPreviewRequest | null>(null)
  const [loginSkill, setLoginSkill] = React.useState<string | null>(null)
  const activationRevision = React.useRef(0)
  const activationChanges = React.useRef(
    new Map<string, { enabled: boolean; revision: number; pending: boolean }>()
  )

  const load = React.useCallback(async (): Promise<void> => {
    const request = ++loadRequest.current
    const activation = activationRevision.current
    setLoading(!loaded.current)
    try {
      const rows = await getSkills(SKILL_SURFACE_SETTINGS, language)
      if (request !== loadRequest.current) return
      const next = rows
        .filter(
          (row) =>
            productSkillGroup(row.group) !== null &&
            !(row.group === TAB_SYSTEM && HIDDEN_SYSTEM_SKILLS.has(row.name))
        )
        .map((row) => {
          const change = activationChanges.current.get(row.name)
          return change && (change.pending || change.revision > activation)
            ? { ...row, enabled: change.enabled }
            : row
        })
      for (const [name, change] of activationChanges.current) {
        if (!change.pending && change.revision <= activation) activationChanges.current.delete(name)
      }
      setSkills(next)
      loaded.current = true
      setLoadError(null)
    } catch (error) {
      if (request !== loadRequest.current) return
      toast({ tone: 'error', title: t('loadFailed') })
      if (!loaded.current)
        setLoadError({
          key: 'loadFailed',
          detail:
            error instanceof SkillCatalogError
              ? undefined
              : error instanceof Error
                ? error.message
                : undefined,
        })
    } finally {
      if (request === loadRequest.current) setLoading(false)
    }
  }, [toast, t, language])
  const updates = useSkillUpdates(skills, load)
  React.useEffect(() => {
    if (tab === TAB_USER) void load()
  }, [tab, load])
  const market = useMarketplace({
    enabled: tab === TAB_MARKETPLACE,
    query,
    skills,
    onInstalled: load,
  })
  React.useEffect(() => {
    if (tab !== TAB_MARKETPLACE || market.loading || market.failed || !market.catalogue?.nextCursor)
      return
    const target = paginationRef.current
    if (!target || !listRef.current) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect()
          void market.more()
        }
      },
      { root: listRef.current }
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [tab, market])
  React.useEffect(() => {
    void load()
    return () => {
      loadRequest.current += 1
    }
  }, [load, revision])

  const toggle = async (skill: SkillInfo): Promise<void> => {
    if (!skill.toggleable || activationChanges.current.get(skill.name)?.pending) return
    const nextEnabled = !skill.enabled
    activationChanges.current.set(skill.name, {
      enabled: nextEnabled,
      revision: ++activationRevision.current,
      pending: true,
    })
    setToggling((current) => new Set(current).add(skill.name))
    let enabled = skill.enabled
    setSkills((current) =>
      current.map((item) => (item.name === skill.name ? { ...item, enabled: nextEnabled } : item))
    )
    try {
      if (!(await setSkillActive(skill.name, nextEnabled))) {
        setSkills((current) =>
          current.map((item) =>
            item.name === skill.name ? { ...item, enabled: skill.enabled } : item
          )
        )
        toast({ tone: 'error', title: t('toggleFailed') })
        return
      }
      enabled = nextEnabled
      setNotice(null)
      toast({
        tone: 'success',
        title: t(skill.enabled ? 'disabled' : 'enabled', { name: skillName(skill) }),
      })
    } catch (error) {
      setSkills((current) =>
        current.map((item) =>
          item.name === skill.name ? { ...item, enabled: skill.enabled } : item
        )
      )
      toast({
        tone: 'error',
        title: t('toggleFailed'),
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      activationChanges.current.set(skill.name, {
        enabled,
        revision: ++activationRevision.current,
        pending: false,
      })
      setToggling((current) => {
        const next = new Set(current)
        next.delete(skill.name)
        return next
      })
    }
  }

  const view = async (skill: SkillInfo): Promise<void> => {
    setBusy(true)
    try {
      setDetail({ skill, document: await getSkillDocument(skill.name) })
    } catch (error) {
      toast({
        tone: 'error',
        title: (
          <SkillNotice
            notice={{
              key: 'documentFailed',
              detail:
                error instanceof SkillDocumentError
                  ? undefined
                  : error instanceof Error
                    ? error.message
                    : undefined,
            }}
          />
        ),
      })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!removing) return
    setBusy(true)
    try {
      const result = await deleteSkill(removing.name)
      if (!result.ok) {
        toast({
          tone: 'error',
          title: (
            <SkillNotice notice={skillMutationMessage(result.code, result.error, 'deleteFailed')} />
          ),
        })
        return
      }
      setRemoving(null)
      setDetail(null)
      await load()
    } catch (error) {
      toast({
        tone: 'error',
        title: t('deleteFailed'),
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBusy(false)
    }
  }

  const openPlugin = (name: string): void =>
    setPreview({ operation: 'plugin-preview-installed', name })

  const keyword = query.trim().toLocaleLowerCase()
  const selectedLabel = tab === TAB_MARKETPLACE ? market.label : ''
  const illustratedEmpty =
    !keyword && !selectedLabel && (tab === TAB_USER || tab === TAB_MARKETPLACE)
  const visible =
    tab === TAB_MARKETPLACE
      ? []
      : skills.filter(
          (skill) =>
            skill.group === tab &&
            (!selectedLabel || skill.labels?.some((label) => label.slug === selectedLabel)) &&
            (!keyword ||
              `${skill.name}\n${skillDescription(skill, language)}`
                .toLocaleLowerCase()
                .includes(keyword))
        )
  const detailSkill = market.selected
    ? (market.installed(market.selected) ?? null)
    : detail
      ? (skills.find((skill) => skill.name === detail.skill.name) ?? detail.skill)
      : null
  const activeDetail = market.selected ?? detailSkill
  const detailTitle = market.selected?.name ?? (detailSkill ? skillName(detailSkill) : '')
  const detailEnabled = detailSkill?.enabled ?? false
  const detailUpdate = !market.selected
    ? updates.available.find((skill) => skill.name === detailSkill?.name)
    : undefined
  const detailVersion =
    market.selected?.version ?? detailSkill?.hub?.version ?? detailSkill?.version
  const detailAttribution = market.selected?.attribution ?? detailSkill?.attribution
  const detailAuthor = detailAttribution?.repository_name.split('/')[0]
  const closeDetail = (): void => {
    setDetail(null)
    market.select(null)
  }
  const openSkillUse = (skill: SkillInfo): void => {
    closeDetail()
    if (!skill.enabled) {
      setEnablingUse(skill)
      return
    }
    setUseProject(state.homeSelectedProjectId ?? state.projects[0]?.id ?? '')
    setUseDescription('')
    setUsing(skill)
  }
  const marketInstall = (skill: MarketplaceSkill, compact = false): React.JSX.Element => {
    const local = market.installed(skill)
    if (compact && local) {
      return (
        <Tooltip content={t('marketplace.installedShort')}>
          <span
            role="img"
            aria-label={t('marketplace.installedShort')}
            tabIndex={0}
            className="inline-flex size-[var(--vds-control-height-mini)] items-center justify-center text-[var(--vds-brand-text-primary)]"
            data-testid={`marketplace-install-${skill.slug}`}
          >
            <IconFont
              type="line-operation-select"
              className="!text-[length:var(--vds-icon-6)] font-[var(--vds-fw-regular)]"
            />
          </span>
        </Tooltip>
      )
    }
    if (compact) {
      return (
        <IconButton
          variant="tertiary"
          size="mini"
          icon={<IconFont type="line-operation-add" />}
          label={t(market.installing === skill.slug ? 'upload.installing' : 'upload.install')}
          loading={market.installing === skill.slug}
          disabled={Boolean(market.installing || !skill.version || skill.moderation === 'blocked')}
          onClick={() => void market.install(skill)}
          data-testid={`marketplace-install-${skill.slug}`}
        />
      )
    }
    return (
      <Button
        variant="primary"
        size="md"
        disabled={Boolean(market.installing || !skill.version || skill.moderation === 'blocked')}
        onClick={() => (local ? openSkillUse(local) : void market.install(skill))}
        data-testid={`marketplace-install-${skill.slug}`}
      >
        {local
          ? t('marketplace.use')
          : market.installing === skill.slug
            ? t('upload.installing')
            : t('upload.install')}
      </Button>
    )
  }
  const actions = (
    <>
      <SearchBox
        ref={searchRef}
        containerClassName="w-[var(--vds-skills-search-width)]"
        value={query}
        onChange={(event) => updateQuery(event.target.value)}
        placeholder={t('search')}
        aria-label={t('search')}
        data-testid="skills-search"
        trailing={
          query ? (
            <IconButton
              size="xs"
              variant="ghost"
              label={t('clearSearch')}
              icon={<Icon name="close" size={14} />}
              onClick={() => {
                updateQuery('')
                searchRef.current?.focus()
              }}
            />
          ) : undefined
        }
      />
      <AddSkillButton onUpload={() => setAdding(true)} />
    </>
  )

  return (
    <section className={PAGE_CLASS} data-testid="skills-page">
      <div className="shrink-0">
        <div
          className={`${CONTENT_CLASS} mb-[var(--vds-space-4)] flex shrink-0 flex-wrap items-center gap-[var(--vds-space-2)]`}
        >
          <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
            <TabsList aria-label={t('groups.label')}>
              {SKILL_TABS.map((group) => (
                <TabsTrigger key={group.id} value={group.id} data-testid={`skills-tab-${group.id}`}>
                  {t(group.labelKey)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="ml-auto flex shrink-0 items-center gap-[var(--vds-space-2)]">
            {tab === TAB_USER && (
              <>
                {updates.available.length > 0 && (
                  <Button
                    variant="tertiary"
                    size="md"
                    data-testid="skills-update-all"
                    icon={
                      <RotateCw className="!size-[var(--vds-icon-7)] text-[var(--vds-icon-outline-default)]" />
                    }
                    loading={Boolean(updates.updating)}
                    disabled={loading || busy || toggling.size > 0 || !updates.available.length}
                    onClick={() => void updates.update(updates.available)}
                  >
                    {t('updates.all')}
                  </Button>
                )}
              </>
            )}
          </div>
          {actions}
        </div>
        {tab === TAB_MARKETPLACE && (
          <div
            className={`${CONTENT_CLASS} mb-[var(--vds-space-4)] flex shrink-0 flex-col gap-[var(--vds-space-2)]`}
          >
            <div className="flex min-w-0 items-center gap-[var(--vds-space-3)]">
              <div className="min-w-0 flex-1">
                <Classification
                  labels={market.labels}
                  value={market.label}
                  disabled={market.labelsLoading}
                  onValueChange={market.setLabel}
                />
              </div>
              {market.labelsLoading && (
                <span role="status" className={`shrink-0 ${LOADING_TEXT_CLASS}`}>
                  {t('classification.loading')}
                </span>
              )}
            </div>
            {market.labelsFailed && (
              <Button variant="ghost" size="sm" onClick={market.refresh}>
                {t('retry')}
              </Button>
            )}
          </div>
        )}
      </div>
      {notice && (
        <div role="status" className="flex items-center gap-[var(--vds-space-2)] text-sm">
          <SkillNotice notice={notice} />
          <Button variant="ghost" onClick={() => setNotice(null)} aria-label={t('dismiss')}>
            <Icon name="close" size={14} />
          </Button>
        </div>
      )}
      <ScrollArea
        overlay
        className="min-h-0 flex-1"
        viewportRef={listRef}
        viewportClassName={LIST_SCROLL_CLASS}
        viewportProps={{ 'data-testid': 'skills-list', 'aria-label': t('groups.label') }}
      >
        <div className={`${CONTENT_CLASS} flex min-h-full flex-col`}>
          {tab === TAB_MARKETPLACE ? (
            market.loading && !market.catalogue ? (
              <SkillLoading />
            ) : (
              <>
                {market.failed && (
                  <div className="flex flex-1 items-center justify-center">
                    <EmptyState
                      data-testid="skills-load-error"
                      title={t('marketplace.loadFailed')}
                      action={
                        <Button
                          variant="outline"
                          onClick={() => (market.catalogue ? void market.more() : market.refresh())}
                        >
                          {t('retry')}
                        </Button>
                      }
                    />
                  </div>
                )}
                {!market.failed && market.catalogue?.items.length === 0 && (
                  <EmptyState
                    data-testid="skills-empty"
                    variant={keyword || selectedLabel ? 'default' : 'compact'}
                    className={
                      keyword || selectedLabel
                        ? SEARCH_EMPTY_CLASS
                        : 'min-h-[var(--vds-skills-empty-height)] w-full rounded-[var(--vds-radius-6)] bg-[var(--vds-surface-hover)] [&>[aria-hidden]]:bg-[var(--vds-surface-active)]'
                    }
                    image={keyword || selectedLabel ? { src: emptyImage, alt: '' } : undefined}
                    icon={keyword || selectedLabel ? undefined : <Hammer strokeWidth={1.45} />}
                    title={keyword || selectedLabel ? t('noMatch') : t('marketplaceEmpty')}
                  />
                )}
                <div className={GRID_CLASS}>
                  {market.catalogue?.items.map((skill) => (
                    <Card
                      key={skill.slug}
                      padding="none"
                      className={CARD_CLASS}
                      data-testid={`marketplace-card-${skill.slug}`}
                    >
                      <Tooltip
                        content={skill.description || t('description')}
                        className="!absolute inset-0 !w-full"
                      >
                        <Button
                          unstyled
                          className="absolute inset-0 cursor-pointer rounded-[var(--vds-radius-6)] border-0 bg-transparent p-0 focus-visible:shadow-[var(--vds-focus-brand)]"
                          disabled={Boolean(market.installing)}
                          onClick={() => market.select(skill)}
                          aria-label={t('open', { name: skill.name })}
                        />
                      </Tooltip>
                      <CardHeader className="pointer-events-none !mb-0 px-[var(--vds-space-4)]">
                        <div className="flex min-w-0 items-center gap-[var(--vds-space-2)]">
                          <CardTitle className="flex-1 truncate !text-[length:var(--vds-font-body-lv2)] !leading-[var(--vds-lh-body-lv2)]">
                            {skill.name}
                          </CardTitle>
                          <div className="pointer-events-auto relative z-[var(--vds-z-local-raised)] shrink-0">
                            {marketInstall(skill, true)}
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="pointer-events-none min-h-0 flex-1 px-[var(--vds-space-4)]">
                        <CardDescription className="line-clamp-2 !font-[var(--vds-fw-regular)] !text-[var(--vds-text-tertiary)]">
                          {skill.description || t('description')}
                        </CardDescription>
                      </CardContent>
                      {skill.attribution?.repository_url && (
                        <CardFooter className="pointer-events-none !mt-0 mx-[var(--vds-space-4)] !flex-nowrap !justify-start gap-[var(--vds-space-1)] border-t border-[var(--vds-divider-default)] pt-[var(--vds-space-2)]">
                          <span className="min-w-0 flex-1 truncate">
                            <SkillAttribution skill={skill} />
                          </span>
                        </CardFooter>
                      )}
                    </Card>
                  ))}
                </div>
                {market.catalogue?.nextCursor && (
                  <div
                    ref={paginationRef}
                    className="flex min-h-[var(--vds-space-6)] items-center justify-center pt-[var(--vds-space-3)] pb-[var(--vds-space-2)]"
                    data-testid="marketplace-pagination"
                  >
                    {market.loading && <Spinner size="sm" />}
                  </div>
                )}
              </>
            )
          ) : loading && skills.length === 0 ? (
            <SkillLoading />
          ) : loadError && skills.length === 0 ? (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState
                data-testid="skills-load-error"
                title={<SkillNotice notice={loadError} />}
                action={
                  <Button
                    variant="outline"
                    disabled={loading}
                    onClick={() => void load()}
                    data-testid="skills-load-retry"
                  >
                    {t('retry')}
                  </Button>
                }
              />
            </div>
          ) : (
            <>
              {loaded.current && !loadError && visible.length === 0 && (
                <div
                  className={
                    illustratedEmpty
                      ? ''
                      : keyword || selectedLabel
                        ? 'flex flex-1'
                        : 'flex flex-1 items-center justify-center'
                  }
                >
                  <EmptyState
                    data-testid="skills-empty"
                    variant={illustratedEmpty ? 'compact' : 'default'}
                    className={
                      illustratedEmpty
                        ? 'min-h-[var(--vds-skills-empty-height)] w-full rounded-[var(--vds-radius-6)] bg-[var(--vds-surface-hover)] [&>[aria-hidden]]:bg-[var(--vds-surface-active)]'
                        : keyword || selectedLabel
                          ? SEARCH_EMPTY_CLASS
                          : undefined
                    }
                    image={keyword || selectedLabel ? { src: emptyImage, alt: '' } : undefined}
                    icon={illustratedEmpty ? <Hammer strokeWidth={1.45} /> : undefined}
                    title={
                      keyword || selectedLabel ? (
                        t('noMatch')
                      ) : illustratedEmpty ? (
                        <span className="text-[var(--vds-text-primary)]">{t('userEmpty')}</span>
                      ) : (
                        t(tab === TAB_MARKETPLACE ? 'marketplaceEmpty' : 'empty')
                      )
                    }
                    action={
                      tab === TAB_USER && !keyword && !selectedLabel ? (
                        <AddSkillButton compact onUpload={() => setAdding(true)} />
                      ) : undefined
                    }
                  />
                </div>
              )}
              {SKILL_GROUPS.filter(
                (group) => tab === group.id && visible.some((skill) => skill.group === group.id)
              ).map((group) => (
                <section key={group.id} className="mt-[var(--vds-space-6)] first:mt-0">
                  <div className="grid grid-cols-1 gap-[var(--vds-space-4)] md:grid-cols-2">
                    {visible
                      .filter((skill) => skill.group === group.id)
                      .map((skill) => {
                        const control = skillActivationControl(skill)
                        const loginRequired = !authenticated && skill.requires_login
                        const description = skillDescription(skill, language) || t('description')
                        return (
                          <Card
                            key={skill.name}
                            padding="none"
                            className={CARD_CLASS}
                            data-testid={`skill-card-${skill.name}`}
                            data-skill-group={skill.group}
                            data-toggleable={skill.toggleable}
                          >
                            <Tooltip content={description} className="!absolute inset-0 !w-full">
                              <Button
                                unstyled
                                className="absolute inset-0 cursor-pointer rounded-[var(--vds-radius-6)] border-0 bg-transparent p-0 focus-visible:shadow-[var(--vds-focus-brand)]"
                                disabled={busy}
                                onClick={() => void view(skill)}
                                aria-label={t('open', { name: skillName(skill) })}
                                data-testid={`skill-view-${skill.name}`}
                              />
                            </Tooltip>
                            <CardHeader className="pointer-events-none !mb-0 px-[var(--vds-space-4)]">
                              <div className="flex min-w-0 items-center gap-[var(--vds-space-2)]">
                                <div className="flex min-w-0 flex-1 items-center gap-[var(--vds-space-2)]">
                                  <CardTitle className="min-w-0 truncate !text-[length:var(--vds-font-body-lv2)] !leading-[var(--vds-lh-body-lv2)]">
                                    {skillName(skill)}
                                  </CardTitle>
                                  {skill.updateStatus === 'available' &&
                                    skill.group === TAB_USER && (
                                      <Tag
                                        size="small"
                                        tone="success"
                                        className="shrink-0 font-[var(--vds-fw-regular)]"
                                        data-testid={`skill-update-status-${skill.name}`}
                                      >
                                        {t('updates.available')}
                                      </Tag>
                                    )}
                                </div>
                                <div className="pointer-events-auto relative z-[var(--vds-z-local-raised)] flex shrink-0 items-center">
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <IconButton
                                        size="xs"
                                        variant="ghost"
                                        label={t('more', { name: skillName(skill) })}
                                        icon={<Ellipsis className="size-[var(--vds-icon-6)]" />}
                                        disabled={busy || Boolean(updates.updating)}
                                        className="hover:!bg-[var(--vds-bg-gray-active)]"
                                        data-testid={`skill-more-${skill.name}`}
                                      />
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      {skill.group === TAB_USER &&
                                        skill.updateStatus === 'available' && (
                                          <DropdownMenuItem
                                            disabled={
                                              Boolean(updates.updating) || busy || toggling.size > 0
                                            }
                                            onSelect={() => void updates.update([skill])}
                                            data-testid={`skill-update-${skill.name}`}
                                          >
                                            <RotateCw />
                                            {t('updates.single')}
                                          </DropdownMenuItem>
                                        )}
                                      <DropdownMenuItem
                                        disabled={busy || Boolean(updates.updating)}
                                        onSelect={() =>
                                          loginRequired
                                            ? setLoginSkill(skill.name)
                                            : openSkillUse(skill)
                                        }
                                        data-testid={`skill-use-${skill.name}`}
                                      >
                                        <MessageCircle />
                                        {t('use')}
                                      </DropdownMenuItem>
                                      {skill.group === TAB_USER && skill.removable && (
                                        <DropdownMenuItem
                                          destructive
                                          onSelect={() => setRemoving(skill)}
                                          data-testid={`skill-remove-${skill.name}`}
                                        >
                                          <Trash2 className="size-[var(--vds-icon-6)]" />
                                          {t('delete')}
                                        </DropdownMenuItem>
                                      )}
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </div>
                                <div className="pointer-events-auto relative z-[var(--vds-z-local-raised)] flex shrink-0 items-center gap-[var(--vds-space-2)]">
                                  {loginRequired ? (
                                    <Button
                                      variant="outline"
                                      size="xs"
                                      className="shrink-0 !border-[var(--vds-brand-light-border)] !bg-[var(--vds-brand-light-bg-default)] !text-[var(--vds-brand-text-primary)] hover:!border-[var(--vds-brand-bg-default)]"
                                      icon={<LockKeyhole className="size-[var(--vds-icon-6)]" />}
                                      onClick={() => setLoginSkill(skill.name)}
                                      data-testid={`skill-login-${skill.name}`}
                                    >
                                      {t('loginAvailable')}
                                    </Button>
                                  ) : null}
                                  <Tooltip content={t('alwaysOnHint')} disabled={!control.disabled}>
                                    <span
                                      className="inline-flex"
                                      tabIndex={control.disabled ? 0 : undefined}
                                    >
                                      <Switch
                                        checked={control.checked}
                                        disabled={
                                          control.disabled ||
                                          toggling.has(skill.name) ||
                                          Boolean(updates.updating)
                                        }
                                        label={
                                          control.disabled
                                            ? t('alwaysOn', { name: skillName(skill) })
                                            : skill.enabled
                                              ? t('disable', { name: skillName(skill) })
                                              : t('enable', { name: skillName(skill) })
                                        }
                                        onCheckedChange={() => void toggle(skill)}
                                        data-testid={`skill-toggle-${skill.name}`}
                                      />
                                    </span>
                                  </Tooltip>
                                </div>
                              </div>
                            </CardHeader>
                            <CardContent className="pointer-events-none min-h-0 flex-1 px-[var(--vds-space-4)]">
                              <CardDescription className="line-clamp-2 !font-[var(--vds-fw-regular)] !text-[var(--vds-text-tertiary)]">
                                {description}
                              </CardDescription>
                            </CardContent>
                            <CardFooter className="pointer-events-none !mt-0 mx-[var(--vds-space-4)] !justify-start border-t border-[var(--vds-divider-default)] pt-[var(--vds-space-2)]">
                              {PLUGIN_PREVIEW_VISIBLE && skill.plugin && (
                                <Button
                                  variant="ghost"
                                  className="pointer-events-auto relative z-[var(--vds-z-local-raised)]"
                                  disabled={!skill.enabled}
                                  onClick={() => void openPlugin(skill.name)}
                                >
                                  {t('plugin.open')}
                                </Button>
                              )}
                              <Badge
                                size="sm"
                                variant="secondary"
                                className="!rounded-[var(--vds-radius-2)] !bg-[var(--vds-bg-gray-default-transparent)] !font-[var(--vds-fw-regular)] !text-[var(--vds-text-tertiary)]"
                                data-testid={`skill-source-${skill.name}`}
                              >
                                {installationLabel(skill, t)}
                              </Badge>
                            </CardFooter>
                          </Card>
                        )
                      })}
                  </div>
                </section>
              ))}
            </>
          )}
        </div>
      </ScrollArea>
      <LoginPrompt
        open={loginSkill !== null}
        onOpenChange={(open) => {
          if (!open) setLoginSkill(null)
        }}
        skill={loginSkill ?? undefined}
      />
      <Dialog
        open={Boolean(activeDetail)}
        onOpenChange={(open) => {
          if (!open && !market.installing && !updates.updating) closeDetail()
        }}
      >
        <DialogPortal>
          <DialogContent
            className="!w-[var(--vds-skills-detail-viewport-width)] !max-w-none h-[var(--vds-skills-detail-viewport-height)] !flex flex-col !gap-[var(--vds-space-3)] !px-[var(--vds-space-5)] !pt-[var(--vds-space-3)] !pb-[var(--vds-space-5)] !z-[var(--vds-z-modal-nested)]"
            closeButtonClassName="!top-[var(--vds-space-3)] !right-[var(--vds-space-2)] !p-0"
            overlayClassName="!z-[var(--vds-z-modal-nested-overlay)]"
            overlayProps={{
              onClick: () => {
                if (!market.installing && !updates.updating) closeDetail()
              },
            }}
            data-testid="skill-detail"
          >
            {activeDetail && (
              <>
                <DialogHeader className="shrink-0 !gap-[var(--vds-space-1)] !text-left">
                  <div className="flex min-w-0 items-center justify-between gap-[var(--vds-space-4)] pr-[calc(var(--vds-control-height-md)+var(--vds-space-1)+var(--vds-space-2)-var(--vds-space-5))]">
                    <DialogTitle className="flex min-h-[var(--vds-control-height-md)] min-w-0 items-center !text-[length:var(--vds-font-subhead)] !leading-[var(--vds-lh-subhead)] [overflow-wrap:anywhere]">
                      {detailTitle}
                    </DialogTitle>
                    {detailSkill && (
                      <div
                        className="flex shrink-0 items-center gap-[var(--vds-space-2)]"
                        data-testid="skill-detail-preference"
                      >
                        <span className="text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-secondary)]">
                          {t('taskPreference')}
                        </span>
                        <Switch
                          checked={detailEnabled}
                          disabled={
                            Boolean(market.installing) ||
                            Boolean(updates.updating) ||
                            (detailSkill !== null &&
                              (skillActivationControl(detailSkill).disabled ||
                                toggling.has(detailSkill.name)))
                          }
                          label={
                            detailEnabled
                              ? t('disable', { name: skillName(activeDetail) })
                              : t('enable', { name: skillName(activeDetail) })
                          }
                          onCheckedChange={() => void toggle(detailSkill)}
                          data-testid={`skill-detail-toggle-${detailSkill.name}`}
                        />
                      </div>
                    )}
                  </div>
                  <DialogDescription className="flex flex-wrap items-center gap-[var(--vds-space-2)] !text-[length:var(--vds-font-body-lv1)] !leading-[var(--vds-lh-body-lv1)] !font-[var(--vds-fw-regular)] !text-[var(--vds-text-tertiary)]">
                    <span>
                      {market.selected || detail?.skill.hub
                        ? t('marketplace.github')
                        : detail
                          ? groupLabel(detail.skill, t)
                          : ''}
                    </span>
                    <span
                      aria-hidden="true"
                      className="h-[var(--vds-space-3)] w-[var(--vds-border-width-1)] bg-[var(--vds-divider-default)]"
                    />
                    {detailAuthor && (
                      <>
                        <span data-testid="skill-detail-author">@{detailAuthor}</span>
                        <span
                          aria-hidden="true"
                          className="h-[var(--vds-space-3)] w-[var(--vds-border-width-1)] bg-[var(--vds-divider-default)]"
                        />
                      </>
                    )}
                    <span className="inline-flex items-center gap-[var(--vds-space-1)]">
                      <Folders
                        aria-hidden="true"
                        className="size-[var(--vds-icon-7)] shrink-0"
                        data-testid="detail-version-icon"
                      />
                      {detailVersion ? t('version', { version: detailVersion }) : t('noVersion')}
                    </span>
                    {detailUpdate && (
                      <Tag
                        size="small"
                        tone="success"
                        className="font-[var(--vds-fw-regular)]"
                        data-testid="skill-detail-update-status"
                      >
                        {t('updates.available')}
                      </Tag>
                    )}
                  </DialogDescription>
                  <p className="text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)] [overflow-wrap:anywhere]">
                    {market.selected
                      ? market.selected.description
                      : detail
                        ? skillDescription(detailSkill ?? detail.skill, i18n.language)
                        : ''}
                  </p>
                </DialogHeader>
                <div className={DOCUMENT_CLASS} data-testid="skill-document">
                  {market.selected ? (
                    <>
                      {market.detail?.moderation === 'blocked' && (
                        <p role="note">{t('marketplace.blocked')}</p>
                      )}
                      {market.detailFailed ? (
                        <EmptyState
                          title={t('documentFailed')}
                          action={
                            <Button variant="outline" onClick={market.retryDetail}>
                              {t('retry')}
                            </Button>
                          }
                        />
                      ) : market.detail ? (
                        <Markdown text={market.detail.document || t('marketplace.noDocument')} />
                      ) : (
                        <div
                          role="status"
                          className="flex h-full min-h-[var(--vds-skills-empty-height)] flex-col items-center justify-center gap-[var(--vds-space-3)] font-[var(--vds-fw-regular)]"
                        >
                          <Spinner size="sm" role="presentation" aria-hidden="true" />
                          <span>{t('documentLoading')}</span>
                        </div>
                      )}
                    </>
                  ) : (
                    detail && <Markdown text={skillDocumentBody(detail.document)} />
                  )}
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    disabled={Boolean(market.installing) || Boolean(updates.updating)}
                    onClick={closeDetail}
                  >
                    {ui('cancel')}
                  </Button>
                  {detailUpdate && (
                    <Button
                      variant="secondary"
                      loading={updates.updating === detailUpdate.name}
                      disabled={Boolean(updates.updating) || busy || toggling.size > 0}
                      onClick={() =>
                        void updates.update([detailUpdate]).then(() => view(detailUpdate))
                      }
                      data-testid="skill-detail-update"
                    >
                      {t('updates.action')}
                    </Button>
                  )}
                  {market.selected ? (
                    marketInstall(market.detail || market.selected)
                  ) : (
                    <Button
                      variant="primary"
                      disabled={!detailSkill || busy || Boolean(updates.updating)}
                      onClick={() => {
                        if (!detailSkill) return
                        openSkillUse(detailSkill)
                      }}
                    >
                      {t('use')}
                    </Button>
                  )}
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </DialogPortal>
      </Dialog>
      {preview && <PluginPreviewDialog request={preview} onClose={() => setPreview(null)} />}
      <Dialog
        open={using !== null}
        onOpenChange={(open) => {
          if (!open) setUsing(null)
        }}
      >
        <DialogPortal>
          <DialogContent headerLayout="aligned" className={DIALOG_CLASS}>
            <DialogHeader>
              <DialogTitle>{t('try.title', { name: using ? skillName(using) : '' })}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-[var(--vds-space-4)]">
              <div className="flex flex-col gap-[var(--vds-space-2)]">
                <Label className="!font-[var(--vds-fw-regular)]" htmlFor="skill-use-project">
                  {t('try.project')}
                </Label>
                <Select value={useProject} onValueChange={setUseProject}>
                  <SelectTrigger id="skill-use-project">
                    <SelectValue placeholder={t('try.selectProject')} />
                  </SelectTrigger>
                  <SelectContent>
                    {state.projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-[var(--vds-space-2)]">
                <Label
                  className="!font-[var(--vds-fw-regular)]"
                  htmlFor="skill-use-description"
                  required
                >
                  {t('try.description')}
                </Label>
                <Textarea
                  id="skill-use-description"
                  required
                  rows={5}
                  placeholder={t('try.placeholder')}
                  value={useDescription}
                  onChange={(event) => setUseDescription(event.target.value)}
                />
              </div>
              {!state.projects.length && (
                <DialogDescription>{t('try.noProjects')}</DialogDescription>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setUsing(null)}>
                {ui('cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={
                  !useDescription.trim() ||
                  !state.projects.some((project) => project.id === useProject)
                }
                onClick={() => {
                  if (!using || !state.projects.some((project) => project.id === useProject)) return
                  const result = resolveTaskStarterSkill(skills, using.name)
                  if (!result.reference) {
                    toast({
                      tone: 'error',
                      title: <SkillUseFailure failure={result.failure} skill={using} />,
                      dedupeKey: `skill-use:${using.name}:${result.failure}`,
                    })
                    return
                  }
                  act.startDraft({
                    submit: true,
                    projectId: useProject,
                    composerText: useDescription,
                    composerRefs: [result.reference],
                  })
                  setUsing(null)
                }}
              >
                {t('try.start')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </DialogPortal>
      </Dialog>
      <AlertDialog
        open={enablingUse !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setEnablingUse(null)
        }}
      >
        <AlertDialogPortal>
          <AlertDialogContent>
            <AlertDialogTitle>{t('enableUse.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('enableUse.description', { name: enablingUse ? skillName(enablingUse) : '' })}
            </AlertDialogDescription>
            <AlertDialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => setEnablingUse(null)}>
                {ui('cancel')}
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  if (!enablingUse || busy) return
                  setBusy(true)
                  try {
                    if (!(await setSkillActive(enablingUse.name, true))) {
                      toast({ tone: 'error', title: t('toggleFailed') })
                      return
                    }
                    await load()
                    const selected = enablingUse
                    setEnablingUse(null)
                    openSkillUse({ ...selected, enabled: true })
                  } catch {
                    toast({ tone: 'error', title: t('toggleFailed') })
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {t('enableUse.confirm')}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogPortal>
      </AlertDialog>
      {adding && (
        <SkillAdd
          onClose={() => setAdding(false)}
          onDone={async (message) => {
            setAdding(false)
            setNotice(null)
            toast({
              tone: 'success',
              title:
                message.key === 'plugin.uiUpdated'
                  ? t('plugin.uiUpdated')
                  : t(message.key, { name: message.name }),
            })
            await load()
          }}
        />
      )}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null)
        }}
      >
        <AlertDialogPortal>
          <AlertDialogContent
            className="!z-[var(--vds-z-modal-nested)]"
            overlayClassName="!z-[var(--vds-z-modal-nested-overlay)]"
            data-testid="skill-remove-confirm"
            showCloseButton={!busy}
          >
            <AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('deleteDescription', { name: removing ? skillName(removing) : '' })}
            </AlertDialogDescription>
            <AlertDialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>
                {ui('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => void remove()}
                data-testid="skill-remove-ok"
              >
                {busy ? t('deleting') : t('confirmDelete')}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogPortal>
      </AlertDialog>
    </section>
  )
}

export function PluginInstallation({
  report,
  done,
  busy,
  session,
  request,
  onAnswer,
}: {
  report: PluginReport
  done: boolean
  busy: boolean
  session: string | null
  request: string
  answer?: string
  onAnswer?: (receipt: PluginInstallationReceipt | null) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('skills')
  const [reviewing, setReviewing] = React.useState(false)
  const [preview, setPreview] = React.useState(false)
  const [checked, setChecked] = React.useState(report)
  const [working, setWorking] = React.useState(false)
  const [error, setError] = React.useState('')
  const [state, setState] = React.useState<{
    status: 'pending' | 'skipped' | 'failed' | 'installed' | 'unknown' | 'installing'
    receipt?: PluginInstallationReceipt
    error?: string
  }>({ status: 'unknown' })
  const delivery = React.useCallback(
    async (action: 'status' | 'check' | 'skip' | 'directory') => {
      if (!session) throw new Error('plugin_delivery_session_unavailable')
      const response = await window.scholarseed.deviceSkills({
        operation: 'plugin-delivery',
        session,
        request,
        action,
      })
      if (response.status >= 400) throw new Error(response.body)
      return JSON.parse(response.body) as typeof state & { report?: PluginReport }
    },
    [session, request]
  )
  React.useEffect(() => {
    let active = true
    void delivery('status')
      .then((result) => {
        if (active) setState(result)
      })
      .catch((reason) => {
        if (active) {
          setState({ status: 'unknown' })
          setError(String(reason))
        }
      })
    return () => {
      active = false
    }
  }, [delivery])
  const act = async (action: 'preview' | 'install' | 'skip' | 'directory'): Promise<void> => {
    if (working || busy) return
    setWorking(true)
    setError('')
    try {
      const result = await delivery(
        action === 'skip' ? 'skip' : action === 'directory' ? 'directory' : 'check'
      )
      setState(result)
      if (action === 'skip') {
        if (!done) await onAnswer?.(result.receipt ?? null)
        return
      }
      if (action === 'directory') return
      if (result.report) setChecked(result.report)
      if (action === 'preview' && result.report) setPreview(true)
      if (
        action === 'install' &&
        result.status !== 'unknown' &&
        result.status !== 'installed' &&
        result.report
      )
        setReviewing(true)
    } catch (reason) {
      setError(String(reason))
    } finally {
      setWorking(false)
    }
  }
  const installed = state.status === 'installed' ? state.receipt : undefined
  const statusLabels = {
    pending: t('installation.states.pending'),
    skipped: t('installation.states.skipped'),
    failed: t('installation.states.failed'),
    installed: t('installation.states.installed'),
    unknown: t('installation.states.unknown'),
    installing: t('installation.states.installing'),
  }
  const previewRequest = React.useMemo<PluginPreviewRequest | null>(
    () =>
      checked.candidate
        ? { operation: 'plugin-preview', candidate: checked.candidate, sha256: checked.sha256 }
        : null,
    [checked.candidate, checked.sha256]
  )
  return (
    <Card data-testid="plugin-installation-card">
      <CardHeader>
        <CardTitle>{t('installation.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-[var(--vds-space-3)] break-words">
        <p>
          <Button
            unstyled
            disabled={working}
            onClick={() => void act('directory')}
            className="underline underline-offset-2"
          >
            {report.descriptor?.id} · {report.descriptor?.version}
          </Button>{' '}
          · {t(installed ? 'installation.installedDirectory' : 'installation.generatedDirectory')}
        </p>
        <p role="status">{statusLabels[state.status]}</p>
        {(error || state.error) && <p role="alert">{error || state.error}</p>}
        <div className="flex flex-wrap justify-end gap-[var(--vds-space-2)]">
          {!done && !installed && state.status !== 'skipped' && (
            <Button variant="outline" disabled={busy || working} onClick={() => void act('skip')}>
              {t('installation.defer')}
            </Button>
          )}
          {PLUGIN_PREVIEW_VISIBLE && !!report.descriptor?.components.length && (
            <Button
              variant="outline"
              disabled={busy || working}
              onClick={() => void act('preview')}
            >
              {t('plugin.preview')}
            </Button>
          )}
          {!installed && (
            <Button disabled={busy || working || !report.valid} onClick={() => void act('install')}>
              {t(
                state.status === 'failed'
                  ? 'installation.retry'
                  : state.status === 'unknown'
                    ? 'installation.reconcile'
                    : 'installation.install'
              )}
            </Button>
          )}
          {!done && installed && onAnswer && (
            <Button disabled={busy} onClick={() => void onAnswer(installed)}>
              {t('installation.returnResult')}
            </Button>
          )}
        </div>
      </CardContent>
      {preview && previewRequest && (
        <PluginPreviewDialog request={previewRequest} onClose={() => setPreview(false)} />
      )}
      {reviewing && (
        <SkillAdd
          initialReport={checked}
          onClose={() => {
            setReviewing(false)
            void delivery('status')
              .then(setState)
              .catch((reason) => setError(String(reason)))
          }}
          onDone={async () => undefined}
          onFailure={async (failure) => {
            setReviewing(false)
            setError(failure)
            try {
              const result = await delivery('status')
              setState(
                result.status === 'pending' || result.status === 'skipped'
                  ? { ...result, status: 'failed' }
                  : result
              )
            } catch (reason) {
              setState({ status: 'unknown' })
              setError(`${failure}; ${String(reason)}`)
            }
          }}
          onInstalled={async (result) => {
            setState({ status: 'installed', receipt: result })
            setReviewing(false)
            if (!done) await onAnswer?.(result)
          }}
        />
      )}
    </Card>
  )
}

export function SkillAdd({
  onClose,
  onDone,
  initialReport,
  onInstalled,
  onFailure,
}: {
  onClose: () => void
  onDone: (message: SkillInstallNotice) => Promise<void>
  initialReport?: PluginReport
  onInstalled?: (receipt: PluginInstallationReceipt) => Promise<void>
  onFailure?: (failure: string) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('skills')
  const { t: ui } = useTranslation('ui')
  const { state } = useApp()
  const { toast } = useToast()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const directoryRef = React.useRef<HTMLInputElement>(null)
  const [file, setFile] = React.useState<File | null>(null)
  const [over, setOver] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [preview, setPreview] = React.useState<PluginPreviewRequest | null>(null)
  const [report, setReport] = React.useState<PluginReport | null>(initialReport ?? null)
  const [slotConflict, setSlotConflict] = React.useState(false)
  const [uploadPreview, setUploadPreview] = React.useState<SkillUploadPreview | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const pick = async (source: readonly File[] | DataTransfer, directory = false): Promise<void> => {
    if ((Array.isArray(source) && !source.length) || busy) return
    setPreview(null)
    setReport(null)
    setSlotConflict(false)
    setUploadPreview(null)
    setError(null)
    setFile(null)
    setBusy(true)
    try {
      const selection = 'items' in source ? await droppedSkillFiles(source) : source
      directory ||= selection.some((item) => Boolean(item.webkitRelativePath))
      const incoming = directory ? await packageSkillDirectory(selection) : selection[0]
      if (
        !incoming ||
        (selection.length !== 1 && !directory) ||
        !/^(SKILL\.md|.+\.zip)$/i.test(incoming.name)
      ) {
        setError(t('upload.rejected'))
        return
      }
      setFile(incoming)
      setUploadPreview(await previewSkillFile(incoming))
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message !== 'invalid_directory'
          ? failure.message
          : t(directory ? 'upload.directoryFailed' : 'upload.failed')
      )
    } finally {
      setBusy(false)
    }
  }
  const install = async (): Promise<void> => {
    if (!file || !uploadPreview || uploadPreview.plugin || busy) return
    setBusy(true)
    try {
      const result = await uploadSkillFile(file)
      if (!result.ok) {
        setError(
          result.code === SKILL_ERROR_DUPLICATE
            ? t('upload.conflictHint')
            : result.error || t('upload.failed')
        )
        toast({
          tone: 'error',
          title: (
            <SkillNotice
              notice={skillMutationMessage(result.code, result.error, 'upload.failed')}
            />
          ),
          description:
            result.code === SKILL_ERROR_DUPLICATE
              ? t('upload.conflictHint')
              : t('upload.retryHint'),
        })
        return
      }
      await onDone({ namespace: 'skills', key: 'installed', name: result.name || file.name })
    } catch (error) {
      toast({
        tone: 'error',
        title: t('upload.failed'),
        description: error instanceof Error ? error.message : t('upload.retryHint'),
      })
    } finally {
      setBusy(false)
    }
  }
  const pluginOperation = async (
    operation: 'check' | 'preview' | 'confirm',
    enable = true
  ): Promise<void> => {
    if (busy || (operation === 'check' ? !file : !report?.candidate)) return
    setBusy(true)
    try {
      const request =
        operation === 'check'
          ? {
              operation: 'plugin-check' as const,
              filename: file!.name,
              bytes: new Uint8Array(await file!.arrayBuffer()),
            }
          : operation === 'preview'
            ? {
                operation: 'plugin-preview' as const,
                candidate: report!.candidate!,
                sha256: report!.sha256,
              }
            : {
                operation: 'plugin-confirm' as const,
                candidate: report!.candidate!,
                sha256: report!.sha256,
                confirmed: true as const,
                grants: report!.kind === 'ui' ? [] : report!.descriptor!.capabilities,
                enable,
                update: report!.update ?? false,
              }
      if (request.operation === 'plugin-preview') {
        setPreview(request)
        return
      }
      const response = await window.scholarseed.deviceSkills(request)
      if (operation === 'confirm') setSlotConflict(response.status === 409 && !report?.update)
      if (response.status >= 400) throw new Error(response.body)
      if (operation === 'check') setReport(JSON.parse(response.body) as PluginReport)
      if (operation === 'confirm') {
        if (report?.kind === 'ui') {
          await onDone({ namespace: 'skills', key: 'plugin.uiUpdated' })
          return
        }
        const result = JSON.parse(response.body) as {
          installed: { name: string }
          enabled: boolean
          receipt: PluginInstallationReceipt
        }
        if (enable && !result.enabled) throw new Error(t('plugin.enableFailed'))
        if (onInstalled) {
          await onInstalled(result.receipt)
          return
        }
        await onDone({
          namespace: 'skills',
          key: result.enabled ? 'installed' : 'plugin.installedDisabled',
          name: result.installed.name,
        })
      }
    } catch (error) {
      toast({
        tone: 'error',
        title: t('upload.failed'),
        description: error instanceof Error ? error.message : t('upload.retryHint'),
      })
      if (operation === 'confirm' && onFailure)
        await onFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const uploadPicker = (trigger: React.JSX.Element): React.JSX.Element => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="!z-[var(--vds-z-modal-nested-flyout)]">
        <DropdownMenuItem onSelect={() => inputRef.current?.click()}>
          <Upload />
          {t('upload.select')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => directoryRef.current?.click()}>
          <Folders />
          {t('upload.selectDirectory')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogPortal>
        <DialogContent
          className="w-[var(--vds-skills-detail-width)] max-h-[var(--vds-skills-add-dialog-max-height)] overflow-y-auto !gap-[var(--vds-space-3)] !px-[var(--vds-space-5)] !pt-[var(--vds-space-3)] !pb-[var(--vds-space-5)] !z-[var(--vds-z-modal-nested)]"
          overlayClassName="!z-[var(--vds-z-modal-nested-overlay)]"
          portalClassName="z-[var(--vds-z-modal-interaction)]"
          data-testid="skill-add-modal"
          headerLayout="aligned"
          aria-busy={busy}
          hideCloseButton={busy}
        >
          <DialogHeader className="min-h-[var(--vds-control-height-md)] content-center">
            <DialogTitle>{t('add')}</DialogTitle>
          </DialogHeader>
          {!initialReport && (
            <div
              className="grid gap-[var(--vds-space-3)]"
              data-testid="skill-drop-zone"
              data-drag-over={over}
              onDragOver={(event) => {
                event.preventDefault()
                setOver(true)
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(event) => {
                event.preventDefault()
                setOver(false)
                void pick(event.dataTransfer)
              }}
            >
              {file ? (
                <div
                  className="flex items-center gap-[var(--vds-space-3)] rounded-[var(--vds-radius-4)] bg-[var(--vds-bg-gray-default-transparent)] p-[var(--vds-space-3)]"
                  data-testid="skill-upload-file"
                >
                  <FileFormatIcon
                    name={file.name}
                    className="!size-[var(--vds-skills-upload-icon-size)]"
                  />
                  <span className="grid min-w-0 flex-1 gap-[var(--vds-space-1)] break-words">
                    <span>{file.name}</span>
                    <span className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
                      {createFormatters(state.lang).bytes(file.size)}
                    </span>
                  </span>
                  {uploadPicker(
                    <Button variant="outline" disabled={busy}>
                      {t('upload.reselect')}
                    </Button>
                  )}
                </div>
              ) : (
                uploadPicker(
                  <Button
                    variant="dropzone"
                    disabled={busy}
                    aria-label={t('upload.select')}
                    data-drop-active={over}
                    className="!h-[var(--vds-skills-upload-height)] min-h-[var(--vds-skills-upload-height)] w-full flex-col gap-[var(--vds-space-3)] !rounded-[var(--vds-radius-4)] ![border-width:var(--vds-border-width-1)] !bg-[var(--vds-other-overlay-1)] !px-[var(--vds-space-3)] !py-0 hover:!bg-[var(--vds-other-overlay-2)] data-[drop-active=true]:!bg-[var(--vds-other-overlay-2)]"
                  >
                    <span className="flex size-[var(--vds-skills-upload-icon-size)] items-center justify-center rounded-[var(--vds-radius-4)] bg-[var(--vds-other-overlay-1)]">
                      <Upload className="size-[var(--vds-icon-8)]" aria-hidden="true" />
                    </span>
                    <span className="grid gap-[var(--vds-space-1)] text-center text-[var(--vds-text-secondary)]">
                      <span>{over ? t('upload.drop') : t('upload.drag')}</span>
                      <span className="text-[var(--vds-text-tertiary)]">{t('upload.formats')}</span>
                    </span>
                  </Button>
                )
              )}
              <Input
                ref={directoryRef}
                type="file"
                {...{ webkitdirectory: '' }}
                aria-label={t('upload.selectDirectory')}
                className="hidden"
                disabled={busy}
                data-testid="skill-upload-directory"
                onChange={(event) => {
                  void pick(Array.from(event.target.files ?? []), true)
                  event.target.value = ''
                }}
              />
              <Input
                ref={inputRef}
                type="file"
                aria-label={t('upload.select')}
                accept={UPLOAD_ACCEPT}
                className="hidden"
                disabled={busy}
                data-testid="skill-upload-input"
                onChange={(event) => {
                  void pick(Array.from(event.target.files ?? []))
                  event.target.value = ''
                }}
              />
            </div>
          )}
          {report && (
            <Card data-testid="plugin-report">
              <CardHeader>
                <CardTitle>
                  {report.kind === 'ui' ? t('plugin.updateUI') : t('plugin.report')}
                </CardTitle>
              </CardHeader>
              <CardContent className="max-h-[var(--vds-dialog-list-max-height)] overflow-y-auto break-words">
                <p>
                  {report.descriptor?.id} {report.descriptor?.version}
                </p>
                <p>{report.sha256}</p>
                {report.kind === 'ui' ? (
                  <p>{t('plugin.systemUI')}</p>
                ) : (
                  <p>
                    {t('plugin.grants')}:{' '}
                    {report.descriptor?.capabilities.join(', ') || t('plugin.none')}
                  </p>
                )}
                {report.kind !== 'ui' && <p>{t('plugin.warning')}</p>}
                {report.update && <p role="alert">{t('installation.updateWarning')}</p>}
                {report.issues.map((issue, index) => (
                  <p key={index}>
                    {issue.severity}: {issue.path} — {issue.message}
                  </p>
                ))}
              </CardContent>
            </Card>
          )}
          {preview && <PluginPreview request={preview} />}
          {error && <Alert tone="error" title={error} data-testid="skill-upload-error" />}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              {ui('cancel')}
            </Button>
            {report?.valid ? (
              <>
                {PLUGIN_PREVIEW_VISIBLE &&
                  report.valid &&
                  Boolean(report.descriptor?.components.length) && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void pluginOperation('preview')}
                    >
                      {t('plugin.preview')}
                    </Button>
                  )}
                <Button
                  disabled={busy || !report.valid || !report.candidate}
                  onClick={() => void pluginOperation('confirm')}
                >
                  {report.kind === 'ui' ? t('plugin.confirmUI') : t('plugin.confirm')}
                </Button>
                {slotConflict && !report.update && (
                  <Button
                    variant="outline"
                    disabled={busy || !report.valid || !report.candidate}
                    onClick={() => void pluginOperation('confirm', false)}
                  >
                    {t('plugin.installDisabled')}
                  </Button>
                )}
              </>
            ) : (
              <Button
                disabled={!file || !uploadPreview || busy}
                data-testid="skill-install"
                onClick={() => void (uploadPreview?.plugin ? pluginOperation('check') : install())}
              >
                {busy ? t('upload.installing') : t('upload.install')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
