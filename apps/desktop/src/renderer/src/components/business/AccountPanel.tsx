import { Onboarding } from '../../contracts/onboarding'
import { VersionScope } from './VersionScope'
import {
  DEFAULT_SELECTION_PROMPTS,
  MAX_SELECTION_PROMPT_CHARS,
  SELECTION_PROMPT_ACTIONS
} from '../../../../prompts'
import { profileFailureText, providerPresetText } from './profile'
import { modelDefaultEffort, reasoningLabel } from '../../reasoning'
import type { PersonalApiFailure, ModelInfo } from '../../api'
import { DEFAULT_LANGUAGE, LOCALES } from '../../../../localization/catalog'
import { createFormatters } from '../../../../localization/format'
import type { PreferenceLanguage } from '../../../../preferences'
import { SubscriptionConnections } from './SubscriptionConnections'
import React from 'react'
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Bell,
  BrainCircuit,
  CircleCheck,
  CircleQuestionMark,
  Files,
  // Keyboard,
  Mail,
  Plug,
  RotateCw,
  TriangleAlert,
  UserShield,
  Zap,
  type LucideIcon
} from 'lucide-react'
// 暂时隐藏「账号」「偏好设置」入口，恢复时一并恢复 UserRound / Palette
// import { Bell, BrainCircuit, Mail, Palette, UserRound, Zap, type LucideIcon } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import type {
  SystemPermissionId,
  SystemPermissionRecord,
  SystemPermissionStatus
} from '../../../../permissions'
import {
  CODE_COOLDOWN_SECONDS,
  CODE_PURPOSES,
  ERR_UNAUTHENTICATED,
  PASSWORD_MIN_LENGTH,
  AccountLogoutResult,
  type AccountFailure,
  accountFailureText,
  apiKeyDisplayName,
  AccountProfile,
  ApiKeyCreated,
  ApiKeySummary,
  accountBase,
  accountMe,
  changePhone,
  createApiKey,
  listApiKeys,
  maskPhone,
  resetPassword,
  revokeApiKey,
  rotateApiKey,
  sendCode,
  updateNickname
} from '../../account'
import {
  ModelProviderPreset,
  PersonalApiInput,
  PersonalApiModel,
  PersonalApiProfile,
  PersonalApiProfilesResp,
  PersonalApiWireApi,
  ModelSelectionResp,
  createPersonalApiProfile,
  deletePersonalApiProfile,
  ensureSkillCredential,
  getAuthStatus,
  getModels,
  getModelProviders,
  getPersonalApiProfiles,
  listPersonalApiModels,
  listProjects,
  probePersonalApi,
  refreshSkillCredential,
  setPersonalApiModelVisibility,
  setPersonalApiProfileEnabled,
  updatePersonalApiProfile
} from '../../api'
import {
  CODE_LENGTH,
  RESET_PASSWORD_DIALOG,
  resetPasswordSubmitReady
} from '../../dialogs'
import { Icon, IconName } from '../../icons'
import { AccountSettingsPage, useApp } from '../../store'
import {
  FILE_VERSION_MAX_SIZE_MB,
  FILE_VERSION_MIN_SIZE_MB,
  fileVersionSettingsChanges,
  fileVersionSizeKb,
  fileVersionSizeMbText,
  loadFileVersionSettings,
  saveFileVersionSettings,
  type FileVersionPolicy,
  type FileVersionScanSummary
} from '../../features/resources/settings'
import {
  formatInstallerSize,
  runUpdateAction,
  updateActionOf,
  updateFailureOf,
  updateFailureText,
  useUpdateState
} from '../../features/updates/state'
import {
  Alert,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDescription,
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  CopyButton,
  EllipsisText,
  IconButton,
  Input,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  PasswordInput,
  ProgressBar,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Slider,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  useToast
} from '../ui'
import { cx } from '../ui/utils'
import { writeClipboard } from '../primitive/clipboard'
import { PreferenceControls } from './Preferences'
import { Skills } from './Skills'
// import { Shortcuts } from './Shortcuts'
import { SettingsPage } from './Settings'
import type { ProjectRef } from '../../contracts/content'
import {
  forgetProject,
  listProjects as listProjectListings,
  setProjectArchived
} from '../../features/project/api'

const PHONE_PATTERN = /^1[3-9]\d{9}$/
const NICKNAME_MAX = 64
const API_KEY_NAME_MAX = 64
const FILE_VERSION_SCAN_REFRESH_MS = 300
const FILE_VERSION_MIN_COUNT = 1
const FILE_VERSION_MAX_COUNT = 1000
// Keep the existing advanced policy UI implemented, but hide its product entry until it is enabled here.
const FILE_VERSION_ADVANCED_CONFIGURATION_ENABLED = false
const CONTACT_MAIL = 'info.scholarseed@list.alibaba-inc.com'
// 官网营销页融合挂在账号服务根路径（同 origin），所以官网与用户手册地址从 serve 下发的
// account_base_url 派生；下发为空（未配地址）时回落到发行配置里的同一地址。
const SITE_FALLBACK_BASE_URL = 'https://scholarseed.damo.alibaba.com'
const MANUAL_PAGE_PATH = '/docs.html'
const MAIL_COPIED_HINT_MS = 1600
const FILE_VERSION_ERROR_KEYS = {
  policy_preview_required: 'fileSettings.policyPreviewRequired',
  invalid_version_mode: 'fileSettings.invalidMode',
  policy_impact_unbound: 'fileSettings.serviceUnavailable',
  projects_unavailable: 'fileSettings.projectsUnavailable',
  empty_version_include: 'fileSettings.emptyInclude',
  retention_preview_stale: 'fileSettings.previewStale',
  retention_preview_required: 'fileSettings.previewRequired',
  settings_request_failed: 'fileSettings.serviceUnavailable',
  invalid_max_file_size: 'fileSettings.fileSizeError'
} as const
type FileVersionNoticeKey =
  | 'fileSettings.loadFailed'
  | 'fileSettings.saved'
  | 'fileSettings.limitError'
  | 'fileSettings.fileSizeError'
  | 'fileSettings.notLoaded'
  | 'fileSettings.emptyInclude'
  | 'fileSettings.unchanged'
type RendererUpdateDiagnosis = Awaited<
  ReturnType<ScholarSeedBridge['diagnoseUpdate']>
>

// 诊断输出是协议对照（字段名即契约字段），按本地化规范不翻译。
function formatUpdateDiagnosis(diagnosis: RendererUpdateDiagnosis): string {
  const server = diagnosis.server
  const lines = [
    `url: ${diagnosis.url || '-'}`,
    `lane: ${diagnosis.releaseLane}`,
    `policy: product_id=${diagnosis.policy.productId} bundle_id=${diagnosis.policy.bundleId} team_id=${diagnosis.policy.expectedTeamId || '-'} channel=${diagnosis.policy.channel}`,
    server
      ? `server: version=${server.version} build=${server.buildNumber} product_id=${server.productId || '-'} bundle_id=${server.bundleId || '-'} team_id=${server.teamId || '-'} channel=${server.channel} arch=${server.archType}`
      : 'server: no newer published build',
    `mismatches: ${diagnosis.mismatches.length ? diagnosis.mismatches.join(', ') : 'none'}`
  ]
  if (diagnosis.error) lines.push(`error: ${diagnosis.error}`)
  return lines.join('\n')
}

type AccountPanelNavKey =
  | 'prompts'
  | 'account'
  | 'preferences'
  | 'notifications'
  | 'models'
  | 'skills'
  | 'developer'
  | 'files'
  | 'archives'
  | 'about'

function accountPanelNavLabel(
  key: AccountPanelNavKey,
  t: TFunction<'components'>
): string {
  switch (key) {
    case 'prompts':
      return t('accountPanel.nav.prompts')
    case 'account':
      return t('accountPanel.nav.account')
    case 'preferences':
      return t('accountPanel.nav.preferences')
    case 'notifications':
      return t('accountPanel.nav.notifications')
    case 'models':
      return t('accountPanel.nav.models')
    case 'skills':
      return t('accountPanel.nav.skills')
    case 'developer':
      return t('accountPanel.nav.developer')
    case 'files':
      return t('accountPanel.nav.files')
    case 'archives':
      return t('accountPanel.nav.archives')
    case 'about':
      return t('accountPanel.nav.about')
  }
}

const NAV_ITEMS: {
  id: AccountSettingsPage
  labelKey: AccountPanelNavKey | null
  icon?: IconName
  lucideIcon?: LucideIcon
}[] = [
  // TODO: 暂时隐藏「账号」「偏好设置」入口，后续恢复
  // { id: 'account', labelKey: 'account', lucideIcon: UserRound },
  // { id: 'preferences', labelKey: 'preferences', lucideIcon: Palette },
  { id: 'notifications', labelKey: 'notifications', lucideIcon: Bell },
  { id: 'prompts', labelKey: 'prompts', icon: 'sparkle' },
  { id: 'models', labelKey: 'models', lucideIcon: BrainCircuit },
  { id: 'skills', labelKey: 'skills', lucideIcon: Plug },
  { id: 'developer', labelKey: 'developer', lucideIcon: UserShield },
  { id: 'files', labelKey: 'files', lucideIcon: Files },
  // TODO: 暂时隐藏「键盘快捷键」页面，恢复时一并恢复 Keyboard / Shortcuts。
  // { id: 'shortcuts', labelKey: null, lucideIcon: Keyboard },
  { id: 'archives', labelKey: 'archives', lucideIcon: Archive },
  { id: 'about', labelKey: 'about', lucideIcon: CircleQuestionMark }
]

function visiblePage(page: AccountSettingsPage): AccountSettingsPage {
  if (page === 'model-settings') return 'models'
  // 隐藏页与未知页统一回落到第一个可见入口，保证侧栏选中项与右侧内容一致
  return NAV_ITEMS.some((item) => item.id === page)
    ? page
    : (NAV_ITEMS[0]?.id ?? 'account')
}

function SettingsNavIcon({
  icon,
  lucideIcon: LucideIconComponent,
  size
}: {
  icon?: IconName
  lucideIcon?: LucideIcon
  size: number
}): React.JSX.Element | null {
  if (LucideIconComponent) {
    return <LucideIconComponent size={size} strokeWidth={1.75} />
  }
  return icon ? <Icon name={icon} size={size} /> : null
}

function SettingsPageHeader({
  action,
  description,
  title
}: {
  action?: React.ReactNode
  description: string
  title: string
}): React.JSX.Element {
  return (
    <header className={SETTINGS_PAGE_HEADER_CLASS_NAME}>
      <div className={SETTINGS_PAGE_HEADER_COPY_CLASS_NAME}>
        <h1 className={SETTINGS_H1_CLASS_NAME}>{title}</h1>
        <p className={SETTINGS_LEAD_CLASS_NAME}>{description}</p>
      </div>
      {action && (
        <div className={SETTINGS_PAGE_HEADER_ACTION_CLASS_NAME}>{action}</div>
      )}
    </header>
  )
}

const SELECTION_PROMPT_LABELS = {
  explain: 'accountPanel.prompts.explain',
  translate: 'accountPanel.prompts.translate',
  polish: 'accountPanel.prompts.polish',
  figure: 'accountPanel.prompts.figure'
} as const

function PromptsPage(): React.JSX.Element {
  const { t } = useTranslation('components')
  const { state, act } = useApp()
  const [draft, setDraft] = React.useState(() => ({
    ...state.selectionPrompts
  }))
  const [saving, setSaving] = React.useState(false)
  const changed = SELECTION_PROMPT_ACTIONS.some(
    (action) => draft[action] !== state.selectionPrompts[action]
  )
  const valid = SELECTION_PROMPT_ACTIONS.every(
    (action) =>
      draft[action].trim() && draft[action].length <= MAX_SELECTION_PROMPT_CHARS
  )
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await act.saveSelectionPrompts({ ...draft })
    } finally {
      setSaving(false)
    }
  }
  return (
    <SettingsPage
      data-testid="account-settings-prompts"
      title={t('accountPanel.prompts.title')}
      description={t('accountPanel.prompts.description')}
    >
      <PageBody>
        {SELECTION_PROMPT_ACTIONS.map((action) => (
          <PageSection key={action}>
            <label className="grid gap-[var(--vds-space-1)]">
              <span className="text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] text-[var(--vds-text-primary)]">
                {t(SELECTION_PROMPT_LABELS[action])}
              </span>
              <span className="relative">
                <Textarea
                  rows={3}
                  value={draft[action]}
                  disabled={saving}
                  className="!rounded-[var(--vds-settings-prompt-radius)] pb-[var(--vds-space-7)]"
                  data-testid={`selection-prompt-${action}`}
                  maxLength={MAX_SELECTION_PROMPT_CHARS}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      [action]: event.target.value
                    }))
                  }
                />
                <span className="pointer-events-none absolute bottom-[var(--vds-space-2)] right-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
                  {draft[action].length}-{MAX_SELECTION_PROMPT_CHARS}
                </span>
              </span>
            </label>
            <div className="flex items-center justify-between gap-[var(--vds-space-2)]">
              <span />
              <Button
                size="sm"
                variant="ghost"
                disabled={
                  saving || draft[action] === DEFAULT_SELECTION_PROMPTS[action]
                }
                aria-label={t('accountPanel.prompts.restoreAction', {
                  action: t(SELECTION_PROMPT_LABELS[action])
                })}
                data-testid={`selection-prompt-restore-${action}`}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    [action]: DEFAULT_SELECTION_PROMPTS[action]
                  }))
                }
              >
                {t('accountPanel.prompts.restore')}
              </Button>
            </div>
          </PageSection>
        ))}
      </PageBody>
      <div className="flex justify-end">
        <Button
          variant="primary"
          loading={saving}
          disabled={!changed || !valid || saving}
          data-testid="selection-prompts-save"
          onClick={() => void save()}
        >
          {t('accountPanel.prompts.save')}
        </Button>
      </div>
    </SettingsPage>
  )
}

/**
 * 偏好设置页（PRD「偏好设置」）。
 *
 * 控件与头像菜单里的是同一个组件，所以 PRD ⑧「两处始终显示同一选中状态」是结构上
 * 成立的，不依赖两边各自去读同一个字段。
 */
function PreferencesPage(): React.JSX.Element {
  const { t } = useTranslation('components')

  return (
    <div
      className={SETTINGS_CONTENT_CLASS_NAME}
      data-testid="account-settings-preferences"
    >
      <SettingsPageHeader
        title={t('accountPanel.preferences.title')}
        description={t('accountPanel.preferences.description')}
      />
      <div className={PREFERENCE_CARD_CLASS_NAME}>
        <PreferenceControls />
      </div>
    </div>
  )
}

/** 显示用主机名。地址由 serve 下发、可被 SCHOLARSEED_ACCOUNT_BASE_URL 覆盖，解析不出就原样显示。 */
function siteHostLabel(base: string): string {
  try {
    return new URL(base).host
  } catch {
    return base
  }
}

function AboutPage(): React.JSX.Element {
  const { t: accountUpdateText } = useTranslation('account')
  const { t } = useTranslation('components')
  const { set, act } = useApp()
  const update = useUpdateState()
  const [diagnosis, setDiagnosis] =
    React.useState<RendererUpdateDiagnosis | null>(null)
  const [mailCopied, setMailCopied] = React.useState(false)
  const [siteBase, setSiteBase] = React.useState(
    () => accountBase() || SITE_FALLBACK_BASE_URL
  )

  React.useEffect(() => {
    let cancelled = false
    // 与 AccountMenu 同一取数口：地址由后端下发，本页自己取，不指望别处先设好（子组件 effect
    // 先于父组件跑，指望别处就会输在时序上）。
    void getAuthStatus().then((status) => {
      const base = (status?.account_base_url || '').replace(/\/+$/, '')
      if (!cancelled && base) setSiteBase(base)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // 关于书页打开时静默刷新一次更新态：本页自带「重启安装」按钮且不渲染 UpdatePanel，
  // 不单独挂就会留着「上一次检查之后发布的新包看不见、点安装装掉旧包」的窗口。
  // 与背景检查同一路径（不进 'checking' 相位），与右侧显式「检查更新」按钮互不干扰。
  React.useEffect(() => {
    void window.scholarseed.refreshUpdate()
  }, [])

  React.useEffect(() => {
    if (!mailCopied) return
    const timer = window.setTimeout(
      () => setMailCopied(false),
      MAIL_COPIED_HINT_MS
    )
    return () => window.clearTimeout(timer)
  }, [mailCopied])

  const diagnose = (): void => {
    void window.scholarseed.diagnoseUpdate().then(setDiagnosis)
  }
  const copyMail = async (): Promise<void> => {
    // 优先走主进程剪贴板：navigator.clipboard 要求文档处于聚焦态，桌面端很容易失焦被拒。
    const native = window.scholarseed?.writeClipboard
    if (native) {
      const done = await native(CONTACT_MAIL)
      setMailCopied(done.ok)
      return
    }
    try {
      await navigator.clipboard.writeText(CONTACT_MAIL)
      setMailCopied(true)
    } catch {
      setMailCopied(false)
    }
  }
  // 关闭设置后打开统一引导中心。
  const startGuide = (): void => {
    act.openSettings(null)
    Onboarding.openCenter()
  }
  const manualUrl = `${siteBase}${MANUAL_PAGE_PATH}`
  const siteLabel = siteHostLabel(siteBase)
  const phase = update?.phase ?? 'idle'
  const candidate = update?.candidate
  const currentVersion = update?.currentVersion || window.scholarseed.version
  const currentBuildNumber = window.scholarseed.buildNumber
  const currentVersionLabel = currentBuildNumber
    ? `${currentVersion}-${currentBuildNumber}`
    : currentVersion
  const percent = update?.percent ?? 0
  const action = updateActionOf(update)
  const downloading = phase === 'downloading'
  // 与更新卡、两个入口胶囊同一份判据：安装失败时相位停在 ready，这一行不能报「已下载完成」。
  const failure = updateFailureOf(update)
  const copyrightYear = new Date().getFullYear()

  const VersionIcon: LucideIcon = failure
    ? TriangleAlert
    : phase === 'available'
      ? ArrowUp
      : downloading || phase === 'verifying'
        ? ArrowDown
        : phase === 'ready' ||
            phase === 'installing' ||
            phase === 'restarting' ||
            phase === 'manual'
          ? RotateCw
          : CircleCheck
  const versionIconTone = failure
    ? ABOUT_VERSION_ICON_ALERT_CLASS_NAME
    : phase === 'available' ||
        downloading ||
        phase === 'verifying' ||
        phase === 'ready'
      ? ABOUT_VERSION_ICON_NEW_CLASS_NAME
      : ''

  // PRD 第 11 条：只有「当前版本」这一行随状态变化，其余各行保持原样。
  // 失败呈现独立于相位：failed / rolled-back / ready+error 三种情形共用这一块。
  const failureSub: React.ReactNode = failure ? (
    <>
      <span
        className={ABOUT_VERSION_ERROR_CLASS_NAME}
        data-testid="version-status"
      >
        {updateFailureText(failure, t, accountUpdateText)}
      </span>
      {failure.rolledBack && (
        <span className={ABOUT_ROW_DESCRIPTION_CLASS_NAME}>
          {t('update.rolledBack')}
        </span>
      )}
      {candidate && phase === 'failed' && (
        <span
          className={ABOUT_ROW_DESCRIPTION_CLASS_NAME}
          data-testid="version-resumable"
        >
          {update?.resumable === false
            ? t('update.failedDiscarded')
            : t('update.failedRetained')}
        </span>
      )}
      {phase === 'ready' && (
        <span className={ABOUT_ROW_DESCRIPTION_CLASS_NAME}>
          {t('update.installRetryHint')}
        </span>
      )}
    </>
  ) : null
  let versionSub: React.ReactNode = null
  switch (phase) {
    case 'available':
      versionSub = (
        <span className={ABOUT_VERSION_SUB_CLASS_NAME}>
          <span
            className={ABOUT_VERSION_CHIP_CLASS_NAME}
            data-testid="version-chip"
          >
            {t('update.newVersionChip', {
              version: candidate?.version ?? '',
              size: formatInstallerSize(candidate?.file_size)
            })}
          </span>
          {candidate?.release_notes && (
            <span
              className={ABOUT_VERSION_SUMMARY_CLASS_NAME}
              data-testid="version-summary"
            >
              {candidate.release_notes}
            </span>
          )}
        </span>
      )
      break
    case 'downloading':
      versionSub = (
        <span
          className={ABOUT_ROW_DESCRIPTION_CLASS_NAME}
          data-testid="version-status"
        >
          {t('update.downloadingSub', { version: candidate?.version ?? '' })}
        </span>
      )
      break
    case 'verifying':
      versionSub = (
        <span
          className={ABOUT_ROW_DESCRIPTION_CLASS_NAME}
          data-testid="version-status"
        >
          {t('update.verifying')}
        </span>
      )
      break
    case 'ready':
      versionSub = failureSub ?? (
        <span
          className={ABOUT_ROW_DESCRIPTION_CLASS_NAME}
          data-testid="version-status"
        >
          {t('update.readySub', { version: candidate?.version ?? '' })}
        </span>
      )
      break
    case 'installing':
      versionSub = (
        <span
          className={ABOUT_ROW_DESCRIPTION_CLASS_NAME}
          data-testid="version-status"
        >
          {update?.installStage === 'copying'
            ? t('update.preparingApp')
            : t('update.installing')}
        </span>
      )
      break
    case 'restarting':
      versionSub = (
        <span
          className={ABOUT_ROW_DESCRIPTION_CLASS_NAME}
          data-testid="version-status"
        >
          {t('update.restarting')}
        </span>
      )
      break
    case 'manual':
      versionSub = (
        <>
          <span
            className={ABOUT_ROW_DESCRIPTION_CLASS_NAME}
            data-testid="version-status"
          >
            {t('update.manual')}
          </span>
          <span className={ABOUT_ROW_DESCRIPTION_CLASS_NAME}>
            {t('update.manualHint')}
          </span>
        </>
      )
      break
    case 'failed':
    case 'rolled-back':
      versionSub = failureSub
      break
    case 'unsupported':
      versionSub = (
        <span
          className={ABOUT_ROW_DESCRIPTION_CLASS_NAME}
          data-testid="version-status"
        >
          {t('update.unsupported')}
        </span>
      )
      break
    case 'idle':
      versionSub = (
        <span
          className={ABOUT_ROW_DESCRIPTION_CLASS_NAME}
          data-testid="version-status"
        >
          {t('update.idle')}
        </span>
      )
      break
    case 'checking':
    case 'up-to-date':
      // 检查中由右侧那颗禁用按钮自己说明；「无需更新」按原型放在右侧按钮旁边，不占副标题行。
      break
  }

  let versionControl: React.ReactNode = null
  if (phase === 'unsupported') {
    versionControl = (
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="version-diagnose"
        onClick={diagnose}
      >
        {t('update.diagnose')}
      </Button>
    )
  } else if (downloading) {
    versionControl = (
      <span
        className={ABOUT_VERSION_PROGRESS_CLASS_NAME}
        data-testid="version-progress"
      >
        <ProgressBar
          aria-label={t('update.downloadingSub', {
            version: candidate?.version ?? ''
          })}
          value={percent}
        />
        <span className={ABOUT_VERSION_CAPTION_CLASS_NAME}>
          {t('update.downloadProgress', {
            percent,
            received: formatInstallerSize(update?.receivedBytes ?? 0),
            total: formatInstallerSize(candidate?.file_size)
          })}
        </span>
      </span>
    )
  } else if (phase === 'checking') {
    versionControl = (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled
        data-testid="version-check"
      >
        <span className={ABOUT_VERSION_CHECKING_CLASS_NAME}>
          <Spinner size="sm" />
          {t('update.checking')}
        </span>
      </Button>
    )
  } else if (
    phase === 'verifying' ||
    phase === 'installing' ||
    phase === 'restarting'
  ) {
    versionControl = <Spinner size="sm" />
  } else if (action !== 'none') {
    versionControl = (
      <>
        {phase === 'up-to-date' && (
          <span
            className={ABOUT_VERSION_MUTED_CLASS_NAME}
            data-testid="version-status"
          >
            {t('update.upToDate')}
          </span>
        )}
        <Button
          type="button"
          size="sm"
          variant={action === 'check' ? 'outline' : 'primary'}
          data-testid={
            action === 'install'
              ? 'version-install'
              : action === 'download'
                ? 'version-download'
                : 'version-check'
          }
          onClick={() => runUpdateAction(update)}
        >
          {action === 'install'
            ? t('update.restartInstall')
            : action === 'download'
              ? failure
                ? t('update.retryDownload')
                : t('update.now')
              : t('update.check')}
        </Button>
      </>
    )
  }

  return (
    <SettingsPage
      data-testid="about-settings-page"
      title={t('accountPanel.about.title')}
      description={t('accountPanel.about.description')}
    >
      <PageBody>
        <div className={SECURITY_CARD_CLASS_NAME}>
          <div className={ABOUT_ROW_CLASS_NAME}>
            <span className={cx(ABOUT_ICON_CLASS_NAME, versionIconTone)}>
              <VersionIcon size={15} strokeWidth={1.6} />
            </span>
            <div className={ABOUT_COPY_CLASS_NAME}>
              <strong
                className={ABOUT_ROW_TITLE_CLASS_NAME}
                data-testid="version-current"
              >
                {t('accountPanel.about.currentVersion', {
                  version: currentVersionLabel
                })}
              </strong>
              {versionSub}
            </div>
            <div className={ABOUT_VERSION_CONTROL_CLASS_NAME}>
              {versionControl}
            </div>
          </div>
          {diagnosis ? (
            <pre
              className={ABOUT_ROW_DESCRIPTION_CLASS_NAME}
              style={{ whiteSpace: 'normal' }}
              data-testid="version-diagnosis"
            >
              {formatUpdateDiagnosis(diagnosis)}
            </pre>
          ) : null}
          <Button
            type="button"
            size="content"
            variant="ghost"
            className={ABOUT_LINK_ROW_CLASS_NAME}
            data-testid="about-site"
            onClick={() => void window.scholarseed.openExternal(siteBase)}
          >
            <span className={ABOUT_ICON_CLASS_NAME}>
              <Icon name="globe" size={15} />
            </span>
            <span className={ABOUT_COPY_CLASS_NAME}>
              <strong className={ABOUT_ROW_TITLE_CLASS_NAME}>
                {t('accountPanel.about.site')}
              </strong>
            </span>
            <span className={ABOUT_VALUE_CLASS_NAME}>
              {siteLabel}
              <Icon name="external" size={13} />
            </span>
          </Button>
          <Button
            type="button"
            size="content"
            variant="ghost"
            className={ABOUT_LINK_ROW_CLASS_NAME}
            data-testid="about-mail"
            onClick={() => void copyMail()}
          >
            <span className={ABOUT_ICON_CLASS_NAME}>
              <Mail size={15} strokeWidth={1.6} />
            </span>
            <span className={ABOUT_COPY_CLASS_NAME}>
              <strong className={ABOUT_ROW_TITLE_CLASS_NAME}>
                {t('accountPanel.about.mail')}
              </strong>
            </span>
            <span className={ABOUT_VALUE_CLASS_NAME}>
              {mailCopied ? (
                <em
                  className={ABOUT_COPIED_CLASS_NAME}
                  data-testid="about-mail-copied"
                >
                  {t('accountPanel.about.copied')}
                </em>
              ) : (
                CONTACT_MAIL
              )}
            </span>
          </Button>
          <Button
            type="button"
            size="content"
            variant="ghost"
            className={ABOUT_LINK_ROW_CLASS_NAME}
            data-testid="about-community"
            onClick={() => void window.scholarseed.openExternal(siteBase)}
          >
            <span className={ABOUT_ICON_CLASS_NAME}>
              <Icon name="agents" size={15} />
            </span>
            <span className={ABOUT_COPY_CLASS_NAME}>
              <strong className={ABOUT_ROW_TITLE_CLASS_NAME}>
                {t('accountPanel.about.community')}
              </strong>
            </span>
            <span className={ABOUT_VALUE_CLASS_NAME}>
              {t('accountPanel.about.communityValue')}
              <Icon name="external" size={13} />
            </span>
          </Button>
          <Button
            type="button"
            size="content"
            variant="ghost"
            className={ABOUT_LINK_ROW_CLASS_NAME}
            data-testid="about-manual"
            onClick={() => void window.scholarseed.openExternal(manualUrl)}
          >
            <span className={ABOUT_ICON_CLASS_NAME}>
              <Icon name="books" size={15} />
            </span>
            <span className={ABOUT_COPY_CLASS_NAME}>
              <strong className={ABOUT_ROW_TITLE_CLASS_NAME}>
                {t('accountPanel.about.manual')}
              </strong>
            </span>
            <span className={ABOUT_VALUE_CLASS_NAME}>
              {t('accountPanel.about.manualValue')}
              <Icon name="external" size={13} />
            </span>
          </Button>
          {/* <div className={ABOUT_ROW_CLASS_NAME}>
          <span className={ABOUT_ICON_CLASS_NAME}>
            <Icon name="cap" size={15} />
          </span>
          <div className={ABOUT_COPY_CLASS_NAME}>
            <strong className={ABOUT_ROW_TITLE_CLASS_NAME}>
              {t('accountPanel.about.guide')}
            </strong>
            <small className={ABOUT_ROW_DESCRIPTION_CLASS_NAME}>
              {t('accountPanel.about.guideDescription')}
            </small>
          </div>
          <Button
            size="sm"
            type="button"
            data-testid="about-guide"
            onClick={startGuide}
          >
            {t('accountPanel.about.start')}
          </Button>
        </div> */}
        </div>
        <p className={ABOUT_COPYRIGHT_CLASS_NAME} data-testid="about-copyright">
          {t('accountPanel.about.copyright', { year: copyrightYear })}
        </p>
      </PageBody>
    </SettingsPage>
  )
}

function FileVersionPage(): React.JSX.Element {
  const { state, act } = useApp()
  const { dismiss, toast } = useToast()
  const { t } = useTranslation('resources')
  const { t: uiText } = useTranslation('ui')
  const [mode, setMode] = React.useState<'whitelist' | 'blacklist'>('whitelist')
  const [migrationRequired, setMigrationRequired] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const busyRef = React.useRef(false)
  const [limit, setLimit] = React.useState('50')
  const [maxFileSize, setMaxFileSize] = React.useState('50')
  const [advancedOpen, setAdvancedOpen] = React.useState(false)
  const [includes, setIncludes] = React.useState('')
  const [ignores, setIgnores] = React.useState('')
  const [commonPatterns, setCommonPatterns] = React.useState<string[]>([])
  const [saved, setSaved] = React.useState<FileVersionPolicy | null>(null)
  const [scanSummary, setScanSummary] =
    React.useState<FileVersionScanSummary | null>(null)

  const refreshSettings = React.useCallback(async (): Promise<void> => {
    const settings = await loadFileVersionSettings()
    if (!settings) {
      toast({
        duration: false,
        title: t('fileSettings.loadFailed'),
        tone: 'error'
      })
      return
    }
    setMode(settings.mode)
    setLimit(String(settings.max_versions_per_file))
    setMaxFileSize(fileVersionSizeMbText(settings.max_file_size_kb))
    setIncludes(settings.include_patterns.join('\n'))
    setIgnores(settings.ignore_patterns.join('\n'))
    setMigrationRequired(settings.migration_required)
    setCommonPatterns(settings.common_patterns)
    setSaved({
      mode: settings.mode,
      max_versions_per_file: settings.max_versions_per_file,
      max_file_size_kb: settings.max_file_size_kb,
      include_patterns: settings.include_patterns,
      ignore_patterns: settings.ignore_patterns
    })
    setScanSummary(settings.scan_summary)
  }, [t, toast])

  const refreshScan = React.useCallback(async (): Promise<void> => {
    const settings = await loadFileVersionSettings()
    if (settings) setScanSummary(settings.scan_summary)
  }, [])

  React.useEffect(() => {
    void refreshSettings()
  }, [refreshSettings])

  React.useEffect(() => {
    if (scanSummary?.status !== 'scanning') return
    const timer = window.setTimeout(
      () => void refreshScan(),
      FILE_VERSION_SCAN_REFRESH_MS
    )
    return () => window.clearTimeout(timer)
  }, [refreshScan, scanSummary?.status])

  const errorMessage = (code: string): string => {
    const reason = Object.prototype.hasOwnProperty.call(
      FILE_VERSION_ERROR_KEYS,
      code
    )
      ? t(FILE_VERSION_ERROR_KEYS[code as keyof typeof FILE_VERSION_ERROR_KEYS])
      : t('fileSettings.requestFailed')
    return t('fileSettings.errorDetail', { reason, code })
  }

  const finishSave = (settings: FileVersionPolicy): void => {
    setSaved(settings)
    setMode(settings.mode)
    setLimit(String(settings.max_versions_per_file))
    setMaxFileSize(fileVersionSizeMbText(settings.max_file_size_kb))
    setIncludes(settings.include_patterns.join('\n'))
    setIgnores(settings.ignore_patterns.join('\n'))
  }

  const apply = async (settings: FileVersionPolicy): Promise<void> => {
    const result = await saveFileVersionSettings(settings)
    if (!result.ok) {
      let toastId = ''
      toastId = toast({
        action: (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              dismiss(toastId)
              void apply(settings)
            }}
          >
            {uiText('retry')}
          </Button>
        ),
        description: errorMessage(result.error),
        duration: false,
        title: t('fileSettings.requestFailed'),
        tone: 'error'
      })
      return
    }
    toast({ title: t('fileSettings.saved'), tone: 'success' })
    setMigrationRequired(false)
    finishSave({
      mode: result.result.mode,
      max_versions_per_file: result.result.max_versions_per_file,
      max_file_size_kb: result.result.max_file_size_kb,
      include_patterns: result.result.include_patterns,
      ignore_patterns: result.result.ignore_patterns
    })
  }

  const inspect = async (
    nextLimit = limit,
    nextMaxFileSize = maxFileSize
  ): Promise<void> => {
    const value = Number(nextLimit)
    if (
      !Number.isInteger(value) ||
      value < FILE_VERSION_MIN_COUNT ||
      value > FILE_VERSION_MAX_COUNT
    ) {
      toast({ title: t('fileSettings.limitError'), tone: 'error' })
      return
    }
    if (!saved) {
      toast({ title: t('fileSettings.notLoaded'), tone: 'warning' })
      return
    }
    const fileSizeValue = fileVersionSizeKb(
      nextMaxFileSize,
      saved.max_file_size_kb
    )
    if (fileSizeValue === null) {
      toast({ title: t('fileSettings.fileSizeError'), tone: 'error' })
      return
    }
    const changes = fileVersionSettingsChanges(
      saved,
      value,
      fileSizeValue,
      includes,
      ignores,
      mode
    )
    if (
      !migrationRequired &&
      !changes.modeChanged &&
      !changes.fileSizeChanged &&
      changes.limit === 'unchanged' &&
      !changes.includesChanged &&
      !changes.ignoresChanged
    ) {
      return
    }
    await apply(changes.settings)
  }

  const limitValue = Number(limit)
  const limitInvalid =
    !Number.isInteger(limitValue) ||
    limitValue < FILE_VERSION_MIN_COUNT ||
    limitValue > FILE_VERSION_MAX_COUNT
  const fileSizeInvalid =
    saved !== null &&
    fileVersionSizeKb(maxFileSize, saved.max_file_size_kb) === null

  const saveAutomatically = (
    nextLimit: string,
    nextMaxFileSize: string
  ): void => {
    if (busyRef.current || !saved) return
    busyRef.current = true
    setBusy(true)
    void inspect(nextLimit, nextMaxFileSize).finally(() => {
      busyRef.current = false
      setBusy(false)
    })
  }

  return (
    <SettingsPage
      data-testid="account-settings-files"
      title={t('fileSettings.title')}
      description={t('fileSettings.description')}
    >
      <PageBody data-testid="file-version-settings-stack">
        {migrationRequired && (
          <Alert tone="warning">
            <AlertDescription>
              {t('fileSettings.migrationRequired')}
            </AlertDescription>
          </Alert>
        )}
        <Card
          padding="none"
          className="grid !rounded-[var(--vds-settings-files-card-radius)] px-[var(--vds-card-padding-md)] py-[var(--vds-space-1)]"
        >
          <SettingsRow
            title={t('fileSettings.autoSaveLabel')}
            description={t('fileSettings.autoSaveHelp')}
            titleClassName={DEVELOPER_ROW_TITLE_CLASS_NAME}
            descriptionClassName={DEVELOPER_ROW_DESCRIPTION_CLASS_NAME}
            testid="file-version-auto-save-row"
          >
            <Switch
              checked={state.autoSave}
              onCheckedChange={act.setAutoSave}
              label={t('fileSettings.autoSaveLabel')}
              data-testid="file-version-auto-save"
            />
          </SettingsRow>
          <SettingsRow
            title={t('fileSettings.formatOnSaveLabel')}
            description={t('fileSettings.formatOnSaveHelp')}
            titleClassName={DEVELOPER_ROW_TITLE_CLASS_NAME}
            descriptionClassName={DEVELOPER_ROW_DESCRIPTION_CLASS_NAME}
            testid="file-version-format-on-save-row"
          >
            <Switch
              checked={state.formatOnSave}
              onCheckedChange={act.setFormatOnSave}
              label={t('fileSettings.formatOnSaveLabel')}
              data-testid="file-version-format-on-save"
            />
          </SettingsRow>
          <SettingsRow
            title={t('fileSettings.versionCountLabel')}
            description={t('fileSettings.limitHelp')}
            titleClassName={DEVELOPER_ROW_TITLE_CLASS_NAME}
            descriptionClassName={DEVELOPER_ROW_DESCRIPTION_CLASS_NAME}
            testid="file-version-limit-row"
          >
            <Input
              aria-label={t('fileSettings.versionCountLabel')}
              data-testid="file-version-limit"
              className="w-[var(--vds-layout-compact-control-width)]"
              size="standard"
              type="number"
              min={FILE_VERSION_MIN_COUNT}
              max={FILE_VERSION_MAX_COUNT}
              value={limit}
              disabled={busy || !saved}
              invalid={limitInvalid}
              onChange={(event) => setLimit(event.target.value)}
              onBlur={(event) =>
                saveAutomatically(event.currentTarget.value, maxFileSize)
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
            />
          </SettingsRow>
          <SettingsRow
            title={t('fileSettings.maxFileSizeLabel')}
            description={t('fileSettings.maxFileSizeHelp')}
            titleClassName={DEVELOPER_ROW_TITLE_CLASS_NAME}
            descriptionClassName={DEVELOPER_ROW_DESCRIPTION_CLASS_NAME}
            testid="file-version-size-row"
          >
            <div className="flex items-center gap-[var(--vds-layout-control-gap)]">
              <Input
                aria-label={t('fileSettings.maxFileSizeLabel')}
                data-testid="file-version-max-size"
                className="w-[var(--vds-layout-compact-control-width)]"
                size="standard"
                type="number"
                min={FILE_VERSION_MIN_SIZE_MB}
                max={FILE_VERSION_MAX_SIZE_MB}
                value={maxFileSize}
                disabled={busy || !saved}
                invalid={fileSizeInvalid}
                onChange={(event) => setMaxFileSize(event.target.value)}
                onBlur={(event) =>
                  saveAutomatically(limit, event.currentTarget.value)
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                }}
              />
              <span className={DEVELOPER_ROW_DESCRIPTION_CLASS_NAME}>
                {t('fileSettings.sizeUnit')}
              </span>
            </div>
          </SettingsRow>
          {FILE_VERSION_ADVANCED_CONFIGURATION_ENABLED && (
            <Collapsible
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
              disabled={busy}
            >
              <SettingsRow
                title={t('fileSettings.advancedConfiguration')}
                description={t('fileSettings.advancedConfigurationHelp')}
                testid="file-version-advanced-row"
              >
                <CollapsibleTrigger data-testid="file-version-configuration-toggle">
                  {advancedOpen
                    ? t('fileSettings.collapse')
                    : t('fileSettings.expand')}
                </CollapsibleTrigger>
              </SettingsRow>
              <CollapsibleContent>
                <div className="border-t border-[var(--vds-border-default)] py-[var(--vds-layout-page-padding)]">
                  {saved && (
                    <VersionScope
                      mode={mode}
                      onMode={setMode}
                      includes={includes}
                      ignores={ignores}
                      onIncludes={setIncludes}
                      onIgnores={setIgnores}
                      commonPatterns={commonPatterns}
                      disabled={busy}
                    />
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </Card>
      </PageBody>
    </SettingsPage>
  )
}

const PERMISSIONS: {
  id: SystemPermissionId
  title: string
  description: string
  icon: IconName
}[] = [
  {
    id: 'full-disk',
    title: '项目文件访问',
    description: '读写由你选择的项目目录',
    icon: 'folder'
  },
  {
    id: 'screen',
    title: '录屏与系统录音',
    description: '内容识别与反馈截图',
    icon: 'eye'
  },
  {
    id: 'accessibility',
    title: '辅助功能',
    description: '全局快捷键与快速唤醒',
    icon: 'hand'
  },
  { id: 'microphone', title: '麦克风', description: '语音输入', icon: 'talk' },
  {
    id: 'automation',
    title: '自动化',
    description: '与提醒事项、日历、备忘录等系统应用协作',
    icon: 'plug'
  },
  {
    id: 'notifications',
    title: '通知',
    description: '桌面通知、任务完成与等待提醒',
    icon: 'bell'
  },
  {
    id: 'location',
    title: '位置服务',
    description: '处理与地理位置相关的任务',
    icon: 'wayfinder'
  }
]

const PERMISSION_TITLE_KEYS: Record<SystemPermissionId, string> = {
  'full-disk': 'accountPanel.permissions.fullDisk',
  screen: 'accountPanel.permissions.screen',
  accessibility: 'accountPanel.permissions.accessibility',
  microphone: 'accountPanel.permissions.microphone',
  automation: 'accountPanel.permissions.automation',
  notifications: 'accountPanel.permissions.notifications',
  location: 'accountPanel.permissions.location'
}
const PERMISSION_DETAIL_KEYS = {
  'project-scoped': 'permissionDetails.projectScoped',
  'system-settings': 'permissionDetails.systemSettings',
  'notifications-unavailable': 'permissionDetails.notificationsUnavailable',
  'not-implemented': 'permissionDetails.notImplemented'
} as const
const PERMISSION_DESCRIPTION_KEYS: Record<SystemPermissionId, string> = {
  'full-disk': 'accountPanel.permissions.fullDiskDesc',
  screen: 'accountPanel.permissions.screenDesc',
  accessibility: 'accountPanel.permissions.accessibilityDesc',
  microphone: 'accountPanel.permissions.microphoneDesc',
  automation: 'accountPanel.permissions.automationDesc',
  notifications: 'accountPanel.permissions.notificationsDesc',
  location: 'accountPanel.permissions.locationDesc'
}
const PERMISSION_STATUS_KEYS: Record<SystemPermissionStatus, string> = {
  granted: 'accountPanel.permissions.granted',
  denied: 'accountPanel.permissions.denied',
  restricted: 'accountPanel.permissions.restricted',
  'not-determined': 'accountPanel.permissions.not-determined',
  unavailable: 'accountPanel.permissions.unavailable',
  'system-managed': 'accountPanel.permissions.system-managed',
  'project-scoped': 'accountPanel.permissions.project-scoped',
  'query-error': 'accountPanel.permissions.query-error'
}

const STATUS_LABELS: Record<SystemPermissionStatus, string> = {
  granted: '已授权',
  denied: '未授权',
  restricted: '受限制',
  'not-determined': '未设置',
  unavailable: '不可用',
  'system-managed': '需系统检查',
  'project-scoped': '按项目授权',
  'query-error': '查询失败'
}

const SETTINGS_SHELL_CLASS_NAME =
  'relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[var(--paper)] [--vds-card-radius:var(--vds-settings-card-radius)] [&_.vds-card]:!shadow-none'
const SETTINGS_DIALOG_SHELL_CLASS_NAME = `${SETTINGS_SHELL_CLASS_NAME} h-full rounded-[inherit]`
const SETTINGS_DRAG_CLASS_NAME =
  'absolute inset-x-0 top-[var(--vds-space-0)] z-[3] h-[38px]'
const SETTINGS_NAV_CLASS_NAME =
  'relative z-[4] w-[210px] flex-none border-r border-[var(--border-soft)] bg-[var(--sidebar-surface)] px-[10px] pb-[18px] pt-[0px] max-[760px]:w-[168px]'
const SETTINGS_DIALOG_NAV_CLASS_NAME =
  'w-[150px] px-[8px] pb-[18px] pt-0 max-[760px]:w-[150px] max-[760px]:!w-[calc(var(--vds-space-6)*2+var(--vds-space-2))] max-[760px]:!px-[var(--vds-space-1)]'
const SETTINGS_DIALOG_TITLE_CLASS_NAME =
  'flex h-[56px] items-center px-[16px] text-[16px] font-[var(--vds-fw-medium)] leading-[22px] text-[var(--vds-text-primary)]'
const SETTINGS_BACK_CLASS_NAME =
  'no-drag mb-[14px] !flex !h-8 !w-full !justify-start !gap-[10px] !rounded-[7px] !border-0 !bg-transparent !px-[10px] !py-[var(--vds-space-0)] !text-left !text-[11.5px] !font-normal !text-[var(--text-3)] hover:!bg-transparent [&_svg]:rotate-180'
const SETTINGS_NAV_LIST_CLASS_NAME = 'grid gap-[3px] px-2'
const SETTINGS_NAV_BUTTON_CLASS_NAME =
  '!flex !min-h-[38px] !w-full !justify-start !gap-[10px] !rounded-lg !border-0 !bg-transparent !px-[var(--vds-space-3)] !py-[var(--vds-space-0)] !text-left !text-xs !font-normal !text-[var(--text-3)] hover:![background:color-mix(in_srgb,var(--active-bg)_55%,transparent)] data-[active=true]:![background:var(--active-bg)] data-[active=true]:!font-[650] data-[active=true]:!text-[var(--c-experience)]'
const SETTINGS_DIALOG_NAV_BUTTON_CLASS_NAME =
  '!min-h-9 !gap-[8px] !rounded-[8px] !px-[12px] !text-[14px] !font-[var(--vds-fw-normal)] !leading-5 !text-[var(--vds-text-secondary)] hover:![background:var(--vds-other-overlay-1)] hover:!text-[var(--vds-text-primary)] data-[active=true]:![background:var(--vds-other-overlay-1)] data-[active=true]:!font-[var(--vds-fw-medium)] data-[active=true]:!text-[var(--vds-text-primary)]'
const SETTINGS_NAV_BUTTON_ACTIVE_CLASS_NAME = ''
const SETTINGS_MAIN_CLASS_NAME =
  'no-drag min-w-0 flex-1 overflow-auto bg-[var(--paper)] ![padding:0_32px_56px] max-[760px]:![padding-right:18px] max-[760px]:![padding-left:18px]'
const SETTINGS_CONTENT_CLASS_NAME =
  'w-full pb-[var(--vds-space-5)] animate-[cardIn_0.14s_ease_both]'
const SETTINGS_PAGE_HEADER_CLASS_NAME =
  '-mx-[32px] mb-[22px] flex min-h-[56px] items-center justify-between gap-[16px] border-b border-[var(--border-soft)] px-[32px] pr-[56px] py-[12px] max-[760px]:-mx-[18px] max-[760px]:px-[18px] max-[760px]:pr-[48px]'
const SETTINGS_PAGE_HEADER_COPY_CLASS_NAME =
  'flex min-w-0 max-w-[min(560px,100%)] items-baseline gap-[8px]'
const SETTINGS_PAGE_HEADER_ACTION_CLASS_NAME = 'flex flex-none items-center'
const SETTINGS_H1_CLASS_NAME =
  'm-[var(--vds-space-0)] flex-none text-[14px] font-[var(--vds-fw-medium)] leading-[22px] text-[var(--vds-text-primary)]'
const SETTINGS_H2_CLASS_NAME =
  'mb-[10px] mt-[6px] text-[12.5px] font-[650] text-[var(--text-2)]'
const SETTINGS_HEADING_ROW_CLASS_NAME =
  'flex items-center justify-between gap-[var(--vds-space-4)]'
const SETTINGS_LEAD_CLASS_NAME =
  'm-[var(--vds-space-0)] min-w-0 truncate text-[11.5px] leading-[18px] text-[var(--vds-text-tertiary)]'
const SETTINGS_CARD_CLASS_NAME =
  'overflow-hidden rounded-[var(--vds-settings-card-radius)] border border-[color-mix(in_srgb,var(--border)_86%,transparent)] bg-[var(--vds-bg-white-default)] shadow-none'
const ACCOUNT_SECTION_STACK_CLASS_NAME = 'grid gap-[var(--vds-space-2)]'
const PROFILE_CARD_CLASS_NAME = `${SETTINGS_CARD_CLASS_NAME} flex min-h-[108px] items-center gap-[var(--vds-space-4)] px-[18px] py-[var(--vds-space-4)]`
const PROFILE_AVATAR_CLASS_NAME =
  'grid size-[72px] flex-none place-items-center overflow-hidden rounded-[13px] bg-[radial-gradient(circle_at_70%_74%,#d3c49b_0_7%,transparent_8%),linear-gradient(145deg,#4b8768,#184b39_58%,#d9d0b9_59%_70%,#32644e_71%)] text-lg font-[650] text-white [text-shadow:0_1px_5px_rgb(0_0_0_/_0.32)]'
const PROFILE_COPY_CLASS_NAME = 'grid min-w-0 gap-[var(--vds-space-1)]'
const PROFILE_CAPTION_CLASS_NAME =
  'pl-[var(--vds-space-4)] text-[10px] text-[var(--text-3)]'
const PROFILE_NAME_CLASS_NAME =
  '!inline-flex !h-auto !w-max !min-h-0 !gap-[6px] !border-0 !bg-transparent !p-[var(--vds-space-0)] !text-base !font-[650] !text-[var(--text)] hover:!bg-transparent disabled:!cursor-not-allowed disabled:!opacity-45'
const NAME_EDITOR_CLASS_NAME = 'flex items-center gap-[var(--vds-space-2)]'
const INLINE_INPUT_CLASS_NAME = 'w-[min(100%,240px)]'
const PANEL_BUTTON_CLASS_NAME =
  '!min-h-[30px] flex-none !rounded-[7px] !border ![border-color:var(--border)] !bg-transparent !px-[var(--vds-space-3)] !py-[var(--vds-space-0)] !text-[11px] !text-[var(--text-2)] hover:enabled:![border-color:var(--c-experience)] hover:enabled:!bg-transparent disabled:!cursor-not-allowed disabled:!opacity-45'
const SECURITY_CARD_CLASS_NAME = `${SETTINGS_CARD_CLASS_NAME} px-[18px]`
const SETTINGS_ROW_CLASS_NAME =
  'flex min-h-[72px] items-center gap-[18px] border-b border-[var(--border-soft)] last:border-b-0 max-[760px]:gap-[10px]'
const SETTINGS_ROW_COPY_CLASS_NAME = 'min-w-0 flex-1'
const SETTINGS_ROW_TITLE_CLASS_NAME =
  'text-[12.5px] font-semibold text-[var(--text)]'
const SETTINGS_ROW_DESCRIPTION_CLASS_NAME =
  'mt-[2px] text-[10.5px] leading-[1.45] text-[var(--text-3)] [overflow-wrap:anywhere]'
const DEVELOPER_SECTION_HEADING_CLASS_NAME =
  'mb-[10px] mt-[6px] text-[14px] font-semibold leading-[20px] text-[var(--vds-text-primary)]'
const DEVELOPER_SECTION_HEADING_SPACED_CLASS_NAME = `${DEVELOPER_SECTION_HEADING_CLASS_NAME} !mt-[30px]`
const DEVELOPER_ROW_TITLE_CLASS_NAME =
  'text-[14px] font-semibold leading-[20px] text-[var(--vds-text-primary)]'
const DEVELOPER_ROW_DESCRIPTION_CLASS_NAME =
  'mt-[2px] text-[12px] leading-[18px] text-[var(--vds-text-tertiary)] [overflow-wrap:anywhere]'
const NOTIFICATION_ROW_TITLE_CLASS_NAME =
  'text-[14px] font-semibold text-[var(--text)]'
const NOTIFICATION_ROW_DESCRIPTION_CLASS_NAME =
  'mt-[2px] text-[12px] leading-[1.45] text-[var(--text-3)] [overflow-wrap:anywhere]'
const SECTION_HEADING_CLASS_NAME = `${SETTINGS_H2_CLASS_NAME} !mt-[30px]`
const INLINE_FORM_CLASS_NAME =
  'mb-[var(--vds-space-2)] rounded-[9px] bg-[color-mix(in_srgb,var(--active-bg)_42%,transparent)] p-[14px]'
const INLINE_FORM_HEAD_CLASS_NAME =
  'mb-[10px] flex items-center justify-between text-xs'
const API_KEY_SECRET_CLASS_NAME =
  'select-all rounded-[7px] border border-[var(--border)] bg-[var(--bg-2)] px-[var(--vds-space-3)] py-[10px] font-[var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace)] text-[11.5px] leading-[1.5] text-[var(--text)] [overflow-wrap:anywhere]'
const FORM_ERROR_CLASS_NAME =
  'mt-[var(--vds-space-2)] text-[10.5px] text-[var(--c-tension)]'
const PAGE_ERROR_CLASS_NAME =
  'mt-[var(--vds-space-2)] flex items-center justify-between gap-[var(--vds-space-3)] text-[10.5px] text-[var(--c-tension)]'
const ACCOUNT_PAGE_ERROR_CLASS_NAME =
  'flex items-center justify-between gap-[var(--vds-space-3)] text-[10.5px] text-[var(--c-tension)]'
const FORM_NOTICE_CLASS_NAME =
  'mt-[var(--vds-space-2)] text-[10.5px] text-[var(--c-experience)]'
const MODAL_SCRIM_CLASS_NAME =
  'fixed inset-[var(--vds-space-0)] z-[95] grid place-items-center bg-[color-mix(in_srgb,var(--text)_24%,transparent)] p-[28px]'
const RESET_DIALOG_CLASS_NAME =
  'relative w-[min(400px,calc(100vw_-_56px))] overflow-hidden rounded-[14px] border border-[color-mix(in_srgb,var(--border)_82%,transparent)] bg-[color-mix(in_srgb,var(--bg-2)_96%,white)] shadow-[0_22px_56px_rgba(20,18,12,0.18)] animate-[cardIn_0.16s_ease_both]'
const RESET_CLOSE_CLASS_NAME =
  'absolute right-[14px] top-[14px] grid size-7 place-items-center rounded-full border-0 bg-transparent text-[var(--text-3)] hover:bg-[var(--bg-3)] hover:text-[var(--text)]'
const RESET_HEADER_CLASS_NAME =
  'border-b border-[var(--border-soft)] px-[var(--vds-space-5)] pb-[14px] pt-[var(--vds-space-5)]'
const RESET_TITLE_CLASS_NAME =
  'm-[var(--vds-space-0)] text-xl font-medium tracking-[0] text-[var(--text)]'
const RESET_DESCRIPTION_CLASS_NAME =
  'mb-[var(--vds-space-0)] ml-[var(--vds-space-0)] mr-[34px] mt-[var(--vds-space-1)] text-xs leading-[1.45] text-[var(--text-3)]'
const RESET_BODY_CLASS_NAME =
  'grid gap-[var(--vds-space-3)] px-[var(--vds-space-5)] pb-[var(--vds-space-2)] pt-[14px]'
const RESET_LABEL_CLASS_NAME =
  'grid gap-[7px] text-[11px] font-[650] text-[var(--text)]'
const RESET_INPUT_CLASS_NAME =
  'h-11 w-full min-w-0 rounded-[9px] border border-[var(--border)] bg-[var(--bg)] px-[var(--vds-space-3)] text-[13px] text-[var(--text)] outline-0 focus:border-[var(--c-experience)] disabled:opacity-100 disabled:text-[var(--text)] disabled:[-webkit-text-fill-color:var(--text)]'
const RESET_CODE_ROW_CLASS_NAME =
  'grid grid-cols-[minmax(0,1fr)_104px] gap-[var(--vds-space-2)]'
const RESET_BUTTON_CLASS_NAME =
  '!h-11 !rounded-[9px] !border !border-[var(--border)] !bg-[var(--bg)] !px-[var(--vds-space-0)] !text-xs !text-[var(--text-2)]'
const RESET_ACTIONS_CLASS_NAME =
  'flex justify-end gap-[var(--vds-space-2)] px-[var(--vds-space-5)] pb-[var(--vds-space-5)] pt-[var(--vds-space-2)]'
const NOTIFICATION_CARD_CLASS_NAME = SECURITY_CARD_CLASS_NAME
const PERMISSION_CARD_CLASS_NAME = SECURITY_CARD_CLASS_NAME
const PREFERENCE_CARD_CLASS_NAME = `${SETTINGS_CARD_CLASS_NAME} grid gap-[14px] px-[18px] py-[16px]`
const PERMISSION_ROW_CLASS_NAME =
  'flex min-h-[70px] w-full items-center gap-[var(--vds-space-3)] border-0 border-b border-[var(--border-soft)] bg-transparent p-[var(--vds-space-0)] text-left text-[var(--text)] last:border-b-0 hover:bg-[color-mix(in_srgb,var(--active-bg)_32%,transparent)] disabled:cursor-default disabled:opacity-100 disabled:hover:bg-transparent'
const PERMISSION_ICON_CLASS_NAME =
  'grid size-[30px] flex-none place-items-center rounded-lg bg-[var(--active-bg)] text-[var(--c-experience)]'
const PERMISSION_COPY_CLASS_NAME = 'grid min-w-0 flex-1 gap-[2px]'
const STRONG_TEXT_CLASS_NAME = 'text-xs font-[650] text-[var(--text)]'
const SMALL_TEXT_CLASS_NAME =
  'text-[10.5px] leading-[1.45] text-[var(--text-3)]'
const PERMISSION_STATUS_BASE_CLASS_NAME =
  'flex-none rounded-full bg-[var(--bg-3)] px-[var(--vds-space-2)] py-[3px] text-[10px] text-[var(--text-3)] max-[760px]:hidden'
const PERMISSION_STATUS_GRANTED_CLASS_NAME =
  'bg-[color-mix(in_srgb,var(--c-experience)_13%,transparent)] text-[var(--c-experience)]'
const PERMISSION_STATUS_DENIED_CLASS_NAME =
  'bg-[color-mix(in_srgb,var(--c-tension)_10%,transparent)] text-[var(--c-tension)]'
const SHARING_LEAD_CLASS_NAME = `${SETTINGS_LEAD_CLASS_NAME} mb-[10px]`
const SHARING_CARD_CLASS_NAME = `${SETTINGS_CARD_CLASS_NAME} flex min-h-[78px] items-center gap-[18px] px-[var(--vds-space-4)] py-[13px]`
const SHARING_COPY_CLASS_NAME = 'grid min-w-0 flex-1 gap-[2px]'
const SHARING_SEGMENT_CLASS_NAME =
  'flex flex-none rounded-lg bg-[var(--bg-3)] p-[3px]'
const SHARING_SEGMENT_BUTTON_CLASS_NAME =
  'min-h-7 rounded-md border-0 bg-transparent px-[var(--vds-space-3)] text-[10.5px] text-[var(--text-3)] disabled:opacity-50'
const SHARING_SEGMENT_ACTIVE_CLASS_NAME =
  'bg-[var(--bg-2)] font-[650] text-[var(--c-experience)] shadow-[0_1px_3px_rgb(0_0_0_/_0.1)]'
const ABOUT_ROW_CLASS_NAME =
  'flex min-h-[62px] items-center gap-[var(--vds-space-3)] border-b border-[var(--border-soft)] py-[var(--vds-space-2)] last:border-b-0'
const ABOUT_LINK_ROW_CLASS_NAME = `${ABOUT_ROW_CLASS_NAME} !w-full !justify-start !rounded-[var(--vds-space-0)] !border-x-0 !border-t-0 !bg-transparent !px-[var(--vds-space-0)] !py-[var(--vds-space-0)] !text-left !shadow-none hover:!bg-transparent max-[760px]:grid max-[760px]:[grid-template-columns:auto_minmax(0,1fr)] max-[760px]:[&>span:first-child]:row-span-2 max-[760px]:[&>span:last-child]:col-start-2`
const ABOUT_ICON_CLASS_NAME =
  'grid size-[30px] flex-none place-items-center rounded-full bg-[var(--active-bg)] text-[var(--c-experience)]'
const ABOUT_COPY_CLASS_NAME = 'grid min-w-0 flex-1 gap-[2px]'
const ABOUT_ROW_TITLE_CLASS_NAME =
  'text-[14px] font-[650] leading-[20px] text-[var(--text)]'
const ABOUT_ROW_DESCRIPTION_CLASS_NAME =
  'text-[12px] leading-[18px] text-[var(--text-3)]'
const ABOUT_VALUE_CLASS_NAME =
  'flex min-w-0 items-center justify-end gap-[5px] break-words text-right text-[12px] leading-[18px] text-[var(--text-3)] [overflow-wrap:anywhere] max-[760px]:justify-start max-[760px]:text-left'
const ABOUT_COPIED_CLASS_NAME =
  'text-[12px] not-italic leading-[18px] text-[var(--c-experience)]'
/** 「当前版本」行的状态图标色调：有新版本可下/已就绪用品牌实心，失败用错误浅色。 */
const ABOUT_VERSION_ICON_NEW_CLASS_NAME =
  'bg-[var(--vds-brand-bg-default)] text-[var(--vds-text-on-brand)]'
const ABOUT_VERSION_ICON_ALERT_CLASS_NAME =
  'bg-[var(--vds-error-light-bg-default)] text-[var(--vds-error-text-primary)]'
const ABOUT_VERSION_SUB_CLASS_NAME = 'flex min-w-0 items-center gap-[6px]'
const ABOUT_VERSION_CHIP_CLASS_NAME =
  'inline-flex flex-none items-center rounded-[var(--vds-radius-pill)] border border-[var(--vds-brand-light-border)] bg-[var(--vds-brand-light-bg-default)] px-[8px] py-[1px] text-[10.5px] font-[var(--vds-fw-semibold)] leading-[var(--vds-lh-caption)] text-[var(--vds-brand-text-primary)] tabular-nums'
const ABOUT_VERSION_SUMMARY_CLASS_NAME =
  'min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] leading-[18px] text-[var(--vds-text-tertiary)]'
const ABOUT_VERSION_ERROR_CLASS_NAME =
  'break-all text-[12px] leading-[18px] text-[var(--vds-error-text-primary)]'
const ABOUT_VERSION_CONTROL_CLASS_NAME =
  'flex flex-none items-center justify-end gap-[var(--vds-space-2)]'
const ABOUT_VERSION_MUTED_CLASS_NAME =
  'text-[12px] text-[var(--vds-text-tertiary)]'
const ABOUT_VERSION_PROGRESS_CLASS_NAME =
  'grid w-[150px] justify-items-end gap-[4px]'
const ABOUT_VERSION_CAPTION_CLASS_NAME =
  'text-[10px] leading-[var(--vds-lh-caption)] text-[var(--vds-text-tertiary)] tabular-nums'
const ABOUT_VERSION_CHECKING_CLASS_NAME = 'flex items-center gap-[6px]'
const ABOUT_COPYRIGHT_CLASS_NAME =
  'mt-[18px] text-center text-[10.5px] text-[var(--vds-text-tertiary)]'

function Toggle({
  checked,
  disabled = false,
  testid,
  label,
  onChange
}: {
  checked: boolean
  disabled?: boolean
  testid: string
  label: string
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <Switch
      checked={checked}
      disabled={disabled}
      data-testid={testid}
      label={label}
      onCheckedChange={onChange}
    />
  )
}

function SettingsRow({
  title,
  description,
  children,
  titleClassName = SETTINGS_ROW_TITLE_CLASS_NAME,
  descriptionClassName = SETTINGS_ROW_DESCRIPTION_CLASS_NAME,
  testid
}: {
  title: string
  description: string
  children: React.ReactNode
  titleClassName?: string
  descriptionClassName?: string
  testid?: string
}): React.JSX.Element {
  return (
    <div className={SETTINGS_ROW_CLASS_NAME} data-testid={testid}>
      <div className={SETTINGS_ROW_COPY_CLASS_NAME}>
        <div className={titleClassName}>{title}</div>
        <div className={descriptionClassName}>{description}</div>
      </div>
      {children}
    </div>
  )
}

function ChangePhoneDialog({
  onClose,
  onSessionInvalid
}: {
  onClose: () => void
  onSessionInvalid: () => void
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: accountText } = useTranslation('account')
  const [targetPhone, setTargetPhone] = React.useState('')
  const [code, setCode] = React.useState('')
  const [cooldown, setCooldown] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const busyRef = React.useRef(false)
  const [error, setError] = React.useState<AccountFailure | null>(null)
  const [notice, setNotice] = React.useState<
    '' | 'accountPanel.dialog.codeSent'
  >('')

  React.useEffect(() => {
    if (cooldown <= 0) return undefined
    const timer = window.setTimeout(
      () => setCooldown((left) => left - 1),
      1_000
    )
    return () => window.clearTimeout(timer)
  }, [cooldown])

  const phoneValid = PHONE_PATTERN.test(targetPhone)

  const requestCode = async (): Promise<void> => {
    if (!phoneValid || cooldown > 0) return
    setBusy(true)
    setError(null)
    setNotice('')
    const result = await sendCode(targetPhone, CODE_PURPOSES.change)
    setBusy(false)
    if (!result.ok) {
      setError(result)
      return
    }
    setCooldown(CODE_COOLDOWN_SECONDS)
    setNotice('accountPanel.dialog.codeSent')
  }

  const submit = async (): Promise<void> => {
    if (!phoneValid || code.length !== CODE_LENGTH) return
    setBusy(true)
    setError(null)
    setNotice('')
    const result = await changePhone(targetPhone, code)
    setBusy(false)
    if (!result.ok) {
      setError(result)
      return
    }
    onSessionInvalid()
  }

  return createPortal(
    <div
      className={MODAL_SCRIM_CLASS_NAME}
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className={RESET_DIALOG_CLASS_NAME}
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-change-phone-title"
        data-testid="account-phone-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className={RESET_CLOSE_CLASS_NAME}
          aria-label={t('accountPanel.common.close')}
          data-testid="account-phone-close"
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </button>
        <header className={RESET_HEADER_CLASS_NAME}>
          <h2
            className={RESET_TITLE_CLASS_NAME}
            id="account-change-phone-title"
          >
            {t('accountPanel.dialog.changePhoneTitle')}
          </h2>
          <p className={RESET_DESCRIPTION_CLASS_NAME}>
            {t('accountPanel.dialog.changePhoneDescription')}
          </p>
        </header>
        <div className={RESET_BODY_CLASS_NAME}>
          <label className={RESET_LABEL_CLASS_NAME}>
            <span>{t('accountPanel.dialog.newPhone')}</span>
            <input
              className={RESET_INPUT_CLASS_NAME}
              value={targetPhone}
              inputMode="tel"
              maxLength={11}
              data-testid="account-phone-phone"
              placeholder={t('accountPanel.dialog.newPhonePlaceholder')}
              onChange={(event) => setTargetPhone(event.target.value.trim())}
            />
          </label>
          <label className={RESET_LABEL_CLASS_NAME}>
            <span>{t('accountPanel.dialog.code')}</span>
            <div className={RESET_CODE_ROW_CLASS_NAME}>
              <input
                className={RESET_INPUT_CLASS_NAME}
                value={code}
                inputMode="numeric"
                maxLength={CODE_LENGTH}
                data-testid="account-phone-code"
                placeholder={t('accountPanel.dialog.codePlaceholder', {
                  count: CODE_LENGTH
                })}
                onChange={(event) => setCode(event.target.value.trim())}
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className={RESET_BUTTON_CLASS_NAME}
                disabled={busy || !phoneValid || cooldown > 0}
                data-testid="account-phone-send-code"
                onClick={() => void requestCode()}
              >
                {cooldown > 0
                  ? accountText('verification.cooldown', { seconds: cooldown })
                  : t('accountPanel.dialog.sendCode')}
              </Button>
            </div>
          </label>
          {error && (
            <div className={FORM_ERROR_CLASS_NAME}>
              {accountFailureText(error, accountText)}
            </div>
          )}
          {!error && notice && (
            <div className={FORM_NOTICE_CLASS_NAME}>
              {t('accountPanel.dialog.codeSent')}
            </div>
          )}
        </div>
        <footer className={RESET_ACTIONS_CLASS_NAME}>
          <Button
            className={PANEL_BUTTON_CLASS_NAME}
            size="sm"
            type="button"
            variant="ghost"
            data-testid="account-phone-cancel"
            onClick={onClose}
          >
            {t('accountPanel.common.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            className={PANEL_BUTTON_CLASS_NAME}
            disabled={busy || !phoneValid || code.length !== CODE_LENGTH}
            data-testid="account-phone-submit"
            onClick={() => void submit()}
          >
            {busy
              ? t('accountPanel.common.processing')
              : t('accountPanel.dialog.confirmChange')}
          </Button>
        </footer>
      </section>
    </div>,
    document.body
  )
}

function ResetPasswordDialog({
  phone,
  onClose,
  onSessionInvalid
}: {
  phone: string
  onClose: () => void
  onSessionInvalid: () => void
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: accountText } = useTranslation('account')
  const [targetPhone, setTargetPhone] = React.useState(phone)
  const [code, setCode] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [cooldown, setCooldown] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const busyRef = React.useRef(false)
  const [error, setError] = React.useState<AccountFailure | null>(null)
  const [notice, setNotice] = React.useState<
    '' | 'accountPanel.dialog.codeSent'
  >('')

  React.useEffect(() => {
    if (cooldown <= 0) return undefined
    const timer = window.setTimeout(
      () => setCooldown((left) => left - 1),
      1_000
    )
    return () => window.clearTimeout(timer)
  }, [cooldown])

  React.useEffect(() => {
    setTargetPhone(phone)
  }, [phone])

  const phoneValid = PHONE_PATTERN.test(targetPhone)
  const locked = Boolean(phone)
  const ready = resetPasswordSubmitReady({ phoneValid, code, password, busy })

  const requestCode = async (): Promise<void> => {
    if (!phoneValid || cooldown > 0) return
    setBusy(true)
    setError(null)
    setNotice('')
    const result = await sendCode(targetPhone, CODE_PURPOSES.reset)
    setBusy(false)
    if (!result.ok) {
      setError(result)
      return
    }
    setCooldown(CODE_COOLDOWN_SECONDS)
    setNotice('accountPanel.dialog.codeSent')
  }

  const submit = async (): Promise<void> => {
    if (!ready) return
    setBusy(true)
    setError(null)
    setNotice('')
    const result = await resetPassword(targetPhone, code, password)
    setBusy(false)
    if (!result.ok) {
      setError(result)
      return
    }
    onSessionInvalid()
  }

  return createPortal(
    <div
      className={MODAL_SCRIM_CLASS_NAME}
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className={RESET_DIALOG_CLASS_NAME}
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-reset-title"
        data-testid={RESET_PASSWORD_DIALOG.testId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className={RESET_CLOSE_CLASS_NAME}
          aria-label={t('accountPanel.common.close')}
          data-testid={RESET_PASSWORD_DIALOG.closeTestId}
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </button>
        <header className={RESET_HEADER_CLASS_NAME}>
          <h2 className={RESET_TITLE_CLASS_NAME} id="account-reset-title">
            {t('accountPanel.dialog.resetPasswordTitle')}
          </h2>
          <p className={RESET_DESCRIPTION_CLASS_NAME}>
            {t('accountPanel.dialog.resetPasswordDescription')}
          </p>
        </header>
        <div className={RESET_BODY_CLASS_NAME}>
          <label className={RESET_LABEL_CLASS_NAME}>
            <span>{t('accountPanel.dialog.currentPhone')}</span>
            <input
              className={RESET_INPUT_CLASS_NAME}
              value={locked ? maskPhone(phone) : targetPhone}
              inputMode="tel"
              maxLength={11}
              disabled={locked}
              data-testid={RESET_PASSWORD_DIALOG.phoneTestId}
              placeholder={t('accountPanel.dialog.phonePlaceholder')}
              onChange={(event) => setTargetPhone(event.target.value.trim())}
            />
          </label>
          <label className={RESET_LABEL_CLASS_NAME}>
            <span>{t('accountPanel.dialog.code')}</span>
            <div className={RESET_CODE_ROW_CLASS_NAME}>
              <input
                className={RESET_INPUT_CLASS_NAME}
                value={code}
                inputMode="numeric"
                maxLength={CODE_LENGTH}
                data-testid={RESET_PASSWORD_DIALOG.codeTestId}
                placeholder={t('accountPanel.dialog.codePlaceholder', {
                  count: CODE_LENGTH
                })}
                onChange={(event) => setCode(event.target.value.trim())}
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className={RESET_BUTTON_CLASS_NAME}
                disabled={busy || !phoneValid || cooldown > 0}
                data-testid={RESET_PASSWORD_DIALOG.sendCodeTestId}
                onClick={() => void requestCode()}
              >
                {cooldown > 0
                  ? accountText('verification.cooldown', { seconds: cooldown })
                  : t('accountPanel.dialog.sendCode')}
              </Button>
            </div>
          </label>
          <label className={RESET_LABEL_CLASS_NAME}>
            <span>{t('accountPanel.dialog.newPassword')}</span>
            <input
              className={RESET_INPUT_CLASS_NAME}
              value={password}
              type="password"
              autoComplete="new-password"
              data-testid={RESET_PASSWORD_DIALOG.passwordTestId}
              placeholder={t('accountPanel.dialog.passwordPlaceholder', {
                count: PASSWORD_MIN_LENGTH
              })}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error && (
            <div className={FORM_ERROR_CLASS_NAME}>
              {accountFailureText(error, accountText)}
            </div>
          )}
          {!error && notice && (
            <div className={FORM_NOTICE_CLASS_NAME}>
              {t('accountPanel.dialog.codeSent')}
            </div>
          )}
        </div>
        <footer className={RESET_ACTIONS_CLASS_NAME}>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={PANEL_BUTTON_CLASS_NAME}
            data-testid={RESET_PASSWORD_DIALOG.cancelTestId}
            onClick={onClose}
          >
            {t('accountPanel.common.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            className={PANEL_BUTTON_CLASS_NAME}
            disabled={!ready}
            data-testid={RESET_PASSWORD_DIALOG.submitTestId}
            onClick={() => void submit()}
          >
            {busy
              ? t('accountPanel.common.processing')
              : t('accountPanel.dialog.confirmReset')}
          </Button>
        </footer>
      </section>
    </div>,
    document.body
  )
}

function AccountPage({
  onLogin,
  onLogout
}: {
  /** 打开应用内登录层。登录不是门禁, 未登录时这一页只有这一个动作。 */
  onLogin: () => void
  onLogout: () => Promise<AccountLogoutResult>
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: accountText } = useTranslation('account')
  const [profile, setProfile] = React.useState<AccountProfile | null>(null)
  const [nickname, setNickname] = React.useState('')
  const [editingName, setEditingName] = React.useState(false)
  const [form, setForm] = React.useState<'phone' | 'password' | null>(null)
  const [busy, setBusy] = React.useState(false)
  const busyRef = React.useRef(false)
  const [error, setError] = React.useState<AccountFailure | null>(null)
  const [loadState, setLoadState] = React.useState<
    'loading' | 'ready' | 'error' | 'anonymous'
  >('loading')

  const loadProfile = React.useCallback((): void => {
    setLoadState('loading')
    setError(null)
    void accountMe().then((result) => {
      if (!result.ok) {
        // unauthorized = 本机没有凭据 (或已失效)。登录不是门禁, 所以这不是故障,
        // 是这一页的另一种正常状态 —— 报成错误再写「已登录」就是骗人。
        if (result.code === ERR_UNAUTHENTICATED) {
          setLoadState('anonymous')
          return
        }
        setError(result)
        setLoadState('error')
        return
      }
      setProfile(result.data)
      setNickname(result.data.nickname)
      setLoadState('ready')
    })
  }, [])

  React.useEffect(() => {
    loadProfile()
  }, [loadProfile])

  // 这一页可以在未登录时打开, 用户就地点「登录」成功后得重取, 否则界面还停在
  // 「未登录」。只听 auth-restored: auth-required 是 account.ts 在 401 时广播的,
  // 而 loadProfile 自己就会引发一次 401, 接上去等于无限重取。
  React.useEffect(() => {
    const reload = (): void => loadProfile()
    window.addEventListener('scholarseed:auth-restored', reload)
    return () => window.removeEventListener('scholarseed:auth-restored', reload)
  }, [loadProfile])

  const cancelNickname = (): void => {
    setNickname(profile?.nickname || '')
    setEditingName(false)
  }

  const performLogout = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    const result = await onLogout()
    setBusy(false)
    if (!result.ok) setError(result)
  }

  const saveNickname = async (): Promise<void> => {
    const next = nickname.trim()
    if (!next || next === profile?.nickname) {
      cancelNickname()
      return
    }
    setBusy(true)
    setError(null)
    const result = await updateNickname(next)
    setBusy(false)
    if (!result.ok) {
      setError(result)
      return
    }
    setProfile((current) =>
      current ? { ...current, nickname: result.data.nickname } : current
    )
    setEditingName(false)
    window.dispatchEvent(
      new CustomEvent('scholarseed:account-updated', {
        detail: { nickname: result.data.nickname }
      })
    )
  }

  const displayName =
    profile?.nickname ||
    (loadState === 'loading'
      ? t('accountPanel.common.loading')
      : t('accountPanel.account.profileUnavailable'))
  // phone 保留原值：它要交给 InlineForm 当发码/重置的真实入参。界面上一律用 maskedPhone。
  const phone = profile?.phone || ''
  const maskedPhone = maskPhone(phone)
  const openResetPassword = (): void => {
    setForm('password')
  }
  const profileActionDisabled = loadState !== 'ready'
  const profileActionTitle = profileActionDisabled
    ? t('accountPanel.account.profileActionUnavailable')
    : undefined

  // 未登录: 这一页只剩一个动作。个人信息 / 手机号 / 重置密码 / 切换账号都要凭据,
  // 照常摆出来只会得到一排点不动的按钮, 外加一行骗人的「已登录」。
  if (loadState === 'anonymous') {
    return (
      <div
        className={SETTINGS_CONTENT_CLASS_NAME}
        data-testid="account-settings-account"
      >
        <SettingsPageHeader
          title={t('accountPanel.account.title')}
          description={t('accountPanel.account.anonymousDescription')}
        />
        <div className={ACCOUNT_SECTION_STACK_CLASS_NAME}>
          <div className={SECURITY_CARD_CLASS_NAME}>
            <SettingsRow
              title={t('accountPanel.account.notLoggedIn')}
              description={t('accountPanel.account.notLoggedInDescription')}
            >
              <Button
                size="sm"
                type="button"
                variant="outline"
                data-testid="account-login-open"
                onClick={onLogin}
              >
                {t('accountPanel.account.login')}
              </Button>
            </SettingsRow>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={SETTINGS_CONTENT_CLASS_NAME}
      data-testid="account-settings-account"
    >
      <SettingsPageHeader
        title={t('accountPanel.account.title')}
        description={t('accountPanel.account.description')}
      />
      <div className={ACCOUNT_SECTION_STACK_CLASS_NAME}>
        <div className={PROFILE_CARD_CLASS_NAME}>
          <div
            className={PROFILE_AVATAR_CLASS_NAME}
            aria-label={t('accountPanel.account.avatar', { name: displayName })}
          />
          <div className={PROFILE_COPY_CLASS_NAME}>
            <span className={PROFILE_CAPTION_CLASS_NAME}>
              {t('accountPanel.account.nickname')}
            </span>
            {editingName ? (
              <div className={NAME_EDITOR_CLASS_NAME}>
                <Input
                  className={INLINE_INPUT_CLASS_NAME}
                  autoFocus
                  value={nickname}
                  maxLength={NICKNAME_MAX}
                  data-testid="account-nickname"
                  onChange={(event) => setNickname(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void saveNickname()
                    if (event.key === 'Escape') cancelNickname()
                  }}
                />
                <Button
                  className={PANEL_BUTTON_CLASS_NAME}
                  size="sm"
                  type="button"
                  data-testid="account-nickname-save"
                  disabled={busy || !nickname.trim()}
                  onClick={() => void saveNickname()}
                >
                  {t('accountPanel.common.save')}
                </Button>
                <Button
                  className={PANEL_BUTTON_CLASS_NAME}
                  size="sm"
                  type="button"
                  variant="ghost"
                  data-testid="account-nickname-cancel"
                  disabled={busy}
                  onClick={cancelNickname}
                >
                  {t('accountPanel.common.cancel')}
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                className={PROFILE_NAME_CLASS_NAME}
                data-testid="account-edit-nickname"
                disabled={profileActionDisabled}
                title={profileActionTitle}
                onClick={() => setEditingName(true)}
              >
                {displayName}
                <Icon name="edit-square" size={13} />
              </Button>
            )}
          </div>
        </div>

        <div className={SECURITY_CARD_CLASS_NAME}>
          <SettingsRow
            title={t('accountPanel.account.phoneNumber')}
            description={
              maskedPhone || t('accountPanel.account.phoneUnavailable')
            }
          >
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={profileActionDisabled}
              title={profileActionTitle}
              data-testid="account-change-phone-open"
              onClick={() => setForm(form === 'phone' ? null : 'phone')}
            >
              {t('accountPanel.account.change')}
            </Button>
          </SettingsRow>
          {form === 'phone' && (
            <ChangePhoneDialog
              onClose={() => setForm(null)}
              onSessionInvalid={() => void performLogout()}
            />
          )}
          <SettingsRow
            title={t('accountPanel.account.resetPassword')}
            description={t('accountPanel.account.resetPasswordDescription')}
          >
            <Button
              size="sm"
              type="button"
              variant="outline"
              disabled={loadState === 'loading'}
              data-testid="account-reset-password-open"
              onClick={openResetPassword}
            >
              {t('accountPanel.account.resetPassword')}
            </Button>
          </SettingsRow>
        </div>
      </div>
      {form === 'password' && (
        <ResetPasswordDialog
          phone={phone}
          onClose={() => setForm(null)}
          onSessionInvalid={() => void performLogout()}
        />
      )}

      <h2 className={SECTION_HEADING_CLASS_NAME}>
        {t('accountPanel.account.currentLogin')}
      </h2>
      <div className={ACCOUNT_SECTION_STACK_CLASS_NAME}>
        <div className={SECURITY_CARD_CLASS_NAME}>
          <SettingsRow
            title={displayName}
            description={t('accountPanel.account.loginStatus', {
              phone:
                maskedPhone ||
                t('accountPanel.account.phoneTemporarilyUnavailable')
            })}
          >
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || profileActionDisabled}
              title={busy ? undefined : profileActionTitle}
              data-testid="account-switch"
              onClick={() => void performLogout()}
            >
              {t('accountPanel.account.switchAccount')}
            </Button>
          </SettingsRow>
          <SettingsRow
            title={t('accountPanel.account.logoutTitle')}
            description={t('accountPanel.account.logoutDescription')}
          >
            <Button
              size="sm"
              type="button"
              disabled={busy}
              variant="outline"
              data-testid="account-logout"
              onClick={() => void performLogout()}
            >
              {busy
                ? t('accountPanel.account.loggingOut')
                : t('accountPanel.account.logout')}
            </Button>
          </SettingsRow>
        </div>
        {error && (
          <div role="alert" className={ACCOUNT_PAGE_ERROR_CLASS_NAME}>
            <span>{accountFailureText(error, accountText)}</span>
            {loadState === 'error' && (
              <Button
                size="sm"
                type="button"
                variant="outline"
                data-testid="account-profile-retry"
                onClick={() => loadProfile()}
              >
                {t('accountPanel.common.retry')}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** 明文只在这里出现一次。关闭后账号服务也取不回（库里只有 sha256），所以文案要说清。 */
function FreshKeyCard({
  created,
  onClose
}: {
  created: ApiKeyCreated
  onClose: () => void
}): React.JSX.Element {
  const { t: accountText } = useTranslation('account')
  const { t } = useTranslation('components')

  return (
    <div className={INLINE_FORM_CLASS_NAME} data-testid="api-key-fresh">
      <div className={INLINE_FORM_HEAD_CLASS_NAME}>
        <strong className={STRONG_TEXT_CLASS_NAME}>
          {t('accountPanel.developer.created')}
        </strong>
        <Button
          type="button"
          variant="outline"
          data-testid="api-key-fresh-close"
          onClick={onClose}
        >
          {accountText('actions.close')}
        </Button>
      </div>
      <div className={API_KEY_SECRET_CLASS_NAME} data-testid="api-key-secret">
        {created.token}
      </div>
      <div className={FORM_NOTICE_CLASS_NAME}>
        {t('accountPanel.developer.copyHint')}
      </div>
      <CopyButton
        type="button"
        value={created.token}
        writeText={writeClipboard}
        variant="outline"
        idleLabel={t('accountPanel.developer.copy')}
        copiedLabel={t('accountPanel.developer.copied')}
        data-testid="api-key-copy"
      />
    </div>
  )
}

function DeveloperPage(): React.JSX.Element {
  const { t: translate } = useTranslation('components')
  const { t: accountText, i18n } = useTranslation('account')
  const language = i18n.resolvedLanguage ?? DEFAULT_LANGUAGE
  const format = createFormatters(
    Object.prototype.hasOwnProperty.call(LOCALES, language)
      ? (language as PreferenceLanguage)
      : DEFAULT_LANGUAGE
  )
  const formatMoment = (seconds: number | null): string =>
    seconds
      ? format.date(new Date(seconds * 1_000), {
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        })
      : accountText('accountExtra.never')
  const t = translate as unknown as (key: string) => string
  const [keys, setKeys] = React.useState<ApiKeySummary[]>([])
  const [fresh, setFresh] = React.useState<ApiKeyCreated | null>(null)
  const [name, setName] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const busyRef = React.useRef(false)
  const [error, setError] = React.useState<AccountFailure | null>(null)
  const [loadState, setLoadState] = React.useState<
    'loading' | 'ready' | 'error'
  >('loading')

  const load = React.useCallback((): void => {
    setLoadState('loading')
    setError(null)
    // 列之前先让后端把「书深自动管理」那把备好。只挂在登录成功那一处是不够的：已登录的用户
    // 开应用不经过登录页（access 7 天 / refresh 90 天），进到这一页仍会看不到它。
    // 幂等且只补不换，失败就照旧往下列，最多少一行。
    void ensureSkillCredential().then(() => {
      void listApiKeys().then((result) => {
        if (!result.ok) {
          setError(result)
          setLoadState('error')
          return
        }
        setKeys(result.data.keys)
        setLoadState('ready')
      })
    })
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await createApiKey(name.trim())
    setBusy(false)
    if (!result.ok) {
      setError(result)
      return
    }
    setFresh(result.data)
    setName('')
    load()
  }

  const revoke = async (keyId: string): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await revokeApiKey(keyId)
    setBusy(false)
    if (!result.ok) {
      setError(result)
      return
    }
    // 被吊销的那把如果正是刚生成的，明文卡也要收掉，避免展示一个已失效的密钥
    setFresh((current) =>
      current && current.key_id === keyId ? null : current
    )
    load()
  }

  // 托管密钥只能轮换：让当前这把立刻失效（止损即时生效），新的由书深在下次开会话时签发，
  // 所以这里没有明文可展示，也不需要收明文卡。
  const rotate = async (keyId: string): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await rotateApiKey(keyId)
    setBusy(false)
    if (!result.ok) {
      setError(result)
      return
    }
    // 通知后端重签并对齐空闲会话，让轮换当场生效而不是等下一次开会话
    await refreshSkillCredential()
    load()
  }

  return (
    <SettingsPage
      data-testid="account-settings-developer"
      title={t('accountPanel.developer.title')}
      description={t('accountPanel.developer.description')}
    >
      <PageBody>
        <PageSection title={t('accountPanel.developer.apiKeys')}>
          <Card padding="none" className="px-[var(--vds-card-padding-md)]">
            {loadState === 'loading' && (
              <SettingsRow
                title={t('accountPanel.developer.loading')}
                description={t('accountPanel.developer.loadingDesc')}
                titleClassName={DEVELOPER_ROW_TITLE_CLASS_NAME}
                descriptionClassName={DEVELOPER_ROW_DESCRIPTION_CLASS_NAME}
              >
                <span />
              </SettingsRow>
            )}
            {loadState === 'ready' && keys.length === 0 && (
              <SettingsRow
                title={t('accountPanel.developer.none')}
                description={t('accountPanel.developer.noneDesc')}
                titleClassName={DEVELOPER_ROW_TITLE_CLASS_NAME}
                descriptionClassName={DEVELOPER_ROW_DESCRIPTION_CLASS_NAME}
              >
                <span />
              </SettingsRow>
            )}
            {keys.map((key) => (
              <SettingsRow
                key={key.key_id}
                testid={`api-key-row-${key.key_id}`}
                title={apiKeyDisplayName(key, accountText)}
                description={
                  key.managed
                    ? accountText('accountExtra.managed', {
                        prefix: key.prefix,
                        lastUsed: formatMoment(key.last_used_at)
                      })
                    : accountText('accountExtra.keyDates', {
                        prefix: key.prefix,
                        created: formatMoment(key.created_at),
                        lastUsed: formatMoment(key.last_used_at)
                      })
                }
                titleClassName={DEVELOPER_ROW_TITLE_CLASS_NAME}
                descriptionClassName={DEVELOPER_ROW_DESCRIPTION_CLASS_NAME}
              >
                {key.managed ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    data-testid={`api-key-rotate-${key.key_id}`}
                    onClick={() => void rotate(key.key_id)}
                  >
                    {accountText('actions.rotate')}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    data-testid={`api-key-revoke-${key.key_id}`}
                    onClick={() => void revoke(key.key_id)}
                  >
                    {accountText('actions.revoke')}
                  </Button>
                )}
              </SettingsRow>
            ))}
          </Card>

          {fresh && (
            <FreshKeyCard created={fresh} onClose={() => setFresh(null)} />
          )}
        </PageSection>

        <PageSection title={t('accountPanel.developer.new')}>
          <Card padding="none" className="!rounded-[var(--vds-settings-api-key-card-radius)] px-[var(--vds-card-padding-md)]">
            <SettingsRow
              title={t('accountPanel.developer.name')}
              description={t('accountPanel.developer.nameDesc')}
              titleClassName={DEVELOPER_ROW_TITLE_CLASS_NAME}
              descriptionClassName={DEVELOPER_ROW_DESCRIPTION_CLASS_NAME}
            >
              <div className={NAME_EDITOR_CLASS_NAME}>
                <Input
                  className={INLINE_INPUT_CLASS_NAME}
                  size="standard"
                  value={name}
                  maxLength={API_KEY_NAME_MAX}
                  placeholder={t('accountPanel.developer.placeholder')}
                  data-testid="api-key-name"
                  onChange={(event) => setName(event.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || loadState !== 'ready'}
                  data-testid="api-key-create"
                  onClick={() => void create()}
                >
                  {busy
                    ? t('accountPanel.developer.busy')
                    : t('accountPanel.developer.generate')}
                </Button>
              </div>
            </SettingsRow>
          </Card>
        </PageSection>

        {error && (
          <div role="alert" className={PAGE_ERROR_CLASS_NAME}>
            <span>{accountFailureText(error, accountText)}</span>
            {loadState === 'error' && (
              <Button
                type="button"
                variant="outline"
                data-testid="api-key-retry"
                onClick={() => load()}
              >
                {accountText('actions.retry')}
              </Button>
            )}
          </div>
        )}
      </PageBody>
    </SettingsPage>
  )
}

const MODEL_FORM_GRID_CLASS_NAME = 'grid gap-[10px]'
const MODEL_FIELD_CLASS_NAME = 'grid gap-[5px]'
const MODEL_FIELD_LABEL_CLASS_NAME =
  'text-[14px] font-[650] text-[var(--text-2)]'
const MODEL_FIELD_HINT_CLASS_NAME =
  'text-[12px] leading-[1.45] text-[var(--text-3)]'
const MODEL_ROW_ACTIONS_CLASS_NAME =
  'flex flex-none items-center gap-[var(--vds-space-2)]'
const MODEL_NAME_ROW_CLASS_NAME = 'flex items-center gap-[var(--vds-space-2)]'

// 模型页在弹窗内分配剩余高度，订阅连接和端点内容分别滚动，操作栏保持可见。
const MODEL_PAGE_CLASS_NAME = `${SETTINGS_CONTENT_CLASS_NAME} flex h-full min-h-[480px] flex-col [&>header]:shrink-0`
const MODEL_CONFIGURATION_TABS_CLASS_NAME =
  'h-full min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] [--vds-tabs-gap:16px]'
const MODEL_SERVICE_TAB_CONTENT_CLASS_NAME = 'min-h-0 flex-1 overflow-hidden'
const MODEL_SETTINGS_TAB_CONTENT_CLASS_NAME = 'min-h-0 flex-1 overflow-hidden'
const MODEL_SETTINGS_EMBEDDED_CLASS_NAME = 'flex h-full min-h-0 flex-col'
const MODEL_SETTINGS_ACTIONS_CLASS_NAME = 'mb-[12px] flex justify-end'
const MODEL_SETTINGS_TABLE_CLASS_NAME =
  'min-h-0 flex-1 overflow-auto rounded-[var(--vds-settings-card-radius)] border border-[var(--vds-line-1)] bg-[var(--vds-surface-raised)] shadow-none'
const MODEL_SETTINGS_TABLE_INNER_CLASS_NAME = 'min-w-[920px]'
const MODEL_SETTINGS_TABLE_GRID_CLASS_NAME =
  'grid w-full grid-cols-[minmax(260px,1fr)_220px_130px_260px] gap-3'
const MODEL_SETTINGS_TABLE_HEADER_CLASS_NAME = `${MODEL_SETTINGS_TABLE_GRID_CLASS_NAME} border-b border-[var(--vds-line-1)] bg-[var(--vds-other-overlay-1)] px-4 py-3 text-[14px] font-semibold text-[var(--vds-text-secondary)]`
const MODEL_SETTINGS_TABLE_ROW_CLASS_NAME = `${MODEL_SETTINGS_TABLE_GRID_CLASS_NAME} items-center border-b border-[var(--vds-line-1)] px-4 py-3 last:border-b-0`
const MODEL_SHELL_CLASS_NAME = [
  'grid min-h-0 flex-1 grid-cols-[248px_minmax(0,1fr)]',
  'overflow-hidden rounded-[var(--vds-settings-model-panel-radius)] border border-[var(--border-soft)]'
].join(' ')
const MODEL_PANE_CLASS_NAME =
  'flex min-h-0 flex-col border-r border-[var(--border-soft)] bg-[var(--bg-2)]'
const MODEL_PANE_TITLE_CLASS_NAME =
  'flex items-baseline justify-between gap-[var(--vds-space-2)] px-[12px] pb-[6px] pt-[12px]'
const MODEL_PANE_TITLE_TEXT_CLASS_NAME =
  'text-[14px] font-[650] text-[var(--text-2)]'
const MODEL_PANE_COUNT_CLASS_NAME = 'text-[12px] text-[var(--text-3)]'
const MODEL_PANE_SEARCH_CLASS_NAME = 'px-[12px] pb-[8px]'
const MODEL_PANE_LIST_CLASS_NAME =
  'flex min-h-0 flex-1 flex-col gap-[3px] overflow-y-auto px-[8px] pb-[8px]'
const MODEL_FOOT_CLASS_NAME =
  'flex min-h-[54px] flex-none items-center border-t border-[var(--border-soft)] p-[8px]'
const MODEL_CONNECTION_ROW_CLASS_NAME = (selected: boolean): string =>
  [
    'flex items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] px-[8px] py-[6px]',
    selected
      ? 'bg-[var(--accent-soft)]'
      : 'bg-transparent hover:bg-[var(--bg-3)]'
  ].join(' ')
const MODEL_CONNECTION_PICK_CLASS_NAME =
  'flex min-w-0 flex-1 items-center gap-[var(--vds-space-2)] text-left'
const MODEL_CONNECTION_TEXT_CLASS_NAME = 'flex min-w-0 flex-1 flex-col items-start'
const MODEL_CONNECTION_NAME_CLASS_NAME =
  'w-full break-words text-[14px] font-[600] text-[var(--text)] line-clamp-2'
const MODEL_CONNECTION_META_CLASS_NAME =
  'w-full overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-[var(--text-3)]'
const MODEL_PANE_EMPTY_CLASS_NAME =
  'px-[12px] py-[10px] text-[12px] leading-[1.5] text-[var(--text-3)]'
const MODEL_DETAIL_CLASS_NAME = 'flex min-h-0 flex-col'
const MODEL_DETAIL_SCROLL_CLASS_NAME =
  'flex min-h-0 flex-1 flex-col gap-[10px] overflow-y-auto p-[16px]'
const MODEL_DETAIL_FOOT_CLASS_NAME = `${MODEL_FOOT_CLASS_NAME} justify-between gap-[var(--vds-space-2)]`
const MODEL_SECTION_HEAD_CLASS_NAME =
  'flex items-center justify-between gap-[var(--vds-space-2)] border-t border-[var(--border-soft)] pt-[10px]'
const MODEL_SELECTION_ROW_CLASS_NAME = (checked: boolean): string =>
  [
    'flex items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] border px-[8px] py-[6px]',
    checked
      ? 'border-[var(--border)] bg-[var(--accent-soft)]'
      : 'border-transparent hover:bg-[var(--bg-3)]'
  ].join(' ')
const MODEL_SELECTION_NAME_CLASS_NAME =
  'min-w-0 flex-1 break-all font-mono text-[14px] text-[var(--text)]'
// 不给它 overflow: 右栏已经是滚动容器, 再套一层内滚会变成滚动套滚动 —— 指针停在
// 列表上时外层滚不动, 看起来像卡住。
const MODEL_SELECTION_LIST_CLASS_NAME = 'flex flex-col gap-[2px]'
const MODEL_DETAIL_HEAD_CLASS_NAME =
  'flex flex-none items-center gap-[var(--vds-space-2)] border-b border-[var(--border-soft)] px-[var(--vds-space-4)] py-[var(--vds-space-3)]'
const MODEL_DETAIL_HEAD_TEXT_CLASS_NAME = 'flex min-w-0 flex-col'
const MODEL_STATUS_ROW_CLASS_NAME =
  'flex flex-none items-center gap-[var(--vds-space-2)]'
const MODEL_STATUS_DOT_CLASS_NAME = (state: 'idle' | 'ok' | 'fail'): string =>
  [
    'size-[var(--vds-space-1)] flex-none rounded-full',
    state === 'ok'
      ? 'bg-[var(--c-experience)]'
      : state === 'fail'
        ? 'bg-[var(--c-tension)]'
        : 'bg-[var(--text-3)]'
  ].join(' ')
const MODEL_PANE_ADD_CLASS_NAME =
  'flex w-full flex-none items-center gap-[var(--vds-space-1)] border-t border-[var(--border-soft)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[var(--text-2)] hover:bg-[var(--bg-3)] hover:text-[var(--text)]'

// 头像缩写只服务显示: 优先取拉丁词首字母, 纯中文厂商标题退回首两字, 保证任何
// 新增预设都有稳定缩写而不需要回来改表。
function providerInitials(label: string): string {
  const tokens = label.match(/[A-Za-z][A-Za-z0-9]*/g)
  if (!tokens || tokens.length === 0) return label.slice(0, 2).toUpperCase()
  if (tokens.length >= 2) return `${tokens[0][0]}${tokens[1][0]}`.toUpperCase()
  return tokens[0].slice(0, 2).toUpperCase()
}

// 上下文徽章沿用工程记法: 满百万写 M, 满千写 K, 不随界面语言做本地化数字格式。
function formatContextBadge(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}

const CHATGPT_PROVIDER_ID = 'chatgpt-oauth'
const CUSTOM_PROVIDER_ID = 'custom'
type ModelPageFailure = {
  messageKey: 'models.loadFailed' | 'models.deleteFailed'
}

const WIRE_API_CHOICES = [
  { value: 'responses', labelKey: 'models.wireResponses' }
] as const

interface ModelEndpointForm {
  imageInput: boolean
  pdfInput: boolean
  id: string
  providerId: string
  previewName: string
  wireApi: PersonalApiWireApi
  baseUrl: string
  apiKey: string
  /** The user's checked models. Draft state until saved. */
  selectedModels: PersonalApiModel[]
  /** Model ids the endpoint advertised, plus anything already checked. */
  candidates: string[]
  smallModelName: string
}

const EMPTY_MODEL_ENDPOINT_FORM: ModelEndpointForm = {
  imageInput: false,
  pdfInput: false,
  id: '',
  providerId: CUSTOM_PROVIDER_ID,
  previewName: '',
  wireApi: 'responses',
  baseUrl: '',
  apiKey: '',
  selectedModels: [],
  candidates: [],
  smallModelName: ''
}

function formOf(profile: PersonalApiProfile): ModelEndpointForm {
  return {
    id: profile.id,
    // 连接自己声明来源, 不再按地址反查 —— 同一地址存在多条连接时反查会认错。
    providerId: profile.preset_id || CUSTOM_PROVIDER_ID,
    imageInput: profile.image_input === true,
    pdfInput: profile.pdf_input === true,
    previewName: profile.preview_name,
    wireApi: profile.wire_api || 'responses',
    baseUrl: profile.base_url,
    // 凭据只写不读: 后端从不回显它, 留空提交即保持原值。
    apiKey: '',
    selectedModels: profile.selected_models,
    // 已勾选的模型先进候选表, 否则进编辑态要先刷新一次才看得见自己勾了什么。
    candidates: profile.selected_models.map((model) => model.id),
    smallModelName: profile.small_model_name
  }
}

function inputOf(form: ModelEndpointForm): PersonalApiInput {
  return {
    image_input: form.imageInput,
    pdf_input: form.pdfInput,
    preview_name: form.previewName.trim(),
    preset_id: form.providerId === CUSTOM_PROVIDER_ID ? '' : form.providerId,
    // Anthropic 兼容协议还没有出网转换腿, 后端会显式拒绝, 所以这里只提供 OpenAI 兼容。
    provider: 'openai',
    wire_api: form.wireApi,
    base_url: form.baseUrl.trim(),
    api_key: form.apiKey,
    selected_models: form.selectedModels,
    small_model_name: form.smallModelName.trim()
    // headers 刻意不发: 本页没有自定义头编辑器, 发空对象会把已存的头删掉。
  }
}

/** Merge a freshly pulled catalogue with what the user already checked.
 *
 * Upstream entries come first and are never auto-checked; a checked model that the
 * endpoint no longer advertises (or that the user typed by hand) is kept, because
 * dropping it would silently un-select a model the user is relying on.
 */
function mergeCandidates(
  upstream: string[],
  selected: PersonalApiModel[]
): string[] {
  const kept = selected
    .map((model) => model.id)
    .filter((id) => !upstream.includes(id))
  return [...upstream, ...kept]
}

function ModelEndpointField({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={MODEL_FIELD_CLASS_NAME}>
      <div className={MODEL_FIELD_LABEL_CLASS_NAME}>{label}</div>
      {children}
      {hint && <div className={MODEL_FIELD_HINT_CLASS_NAME}>{hint}</div>}
    </div>
  )
}

function ModelServicePage({
  embedded = false
}: { embedded?: boolean } = {}): React.JSX.Element {
  const { t: accountActions } = useTranslation('account')
  const { t: subscriptionText } = useTranslation('subscription')
  const { act, state } = useApp()
  const { t } = useTranslation('components')
  const [profiles, setProfiles] = React.useState<PersonalApiProfile[]>([])
  const [presets, setPresets] = React.useState<ModelProviderPreset[]>([])
  // 左栏焦点, 不是「生效的那条」: 多条连接可以同时启用。
  const [selectedId, setSelectedId] = React.useState('')
  const [query, setQuery] = React.useState('')
  const [form, setForm] = React.useState<ModelEndpointForm | null>(null)
  const [manualModel, setManualModel] = React.useState('')
  const [modelQuery, setModelQuery] = React.useState('')
  const [manualOpen, setManualOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const busyRef = React.useRef(false)
  const [error, setError] = React.useState<
    string | PersonalApiFailure | ModelPageFailure
  >('')
  const [probe, setProbe] = React.useState('')
  const [probeOk, setProbeOk] = React.useState(false)
  const [loadState, setLoadState] = React.useState<
    'loading' | 'ready' | 'error'
  >('loading')

  const absorb = React.useCallback(
    (payload: PersonalApiProfilesResp): void => {
      setProfiles(payload.profiles)
      act.setPersonalProfiles(payload)
    },
    [act]
  )

  const load = React.useCallback((): void => {
    setLoadState('loading')
    setError('')
    void getPersonalApiProfiles().then(async (payload) => {
      if (!payload) {
        setError({ messageKey: 'models.loadFailed' })
        setLoadState('error')
        return
      }
      absorb(payload)
      act.applyModelCatalog(await getModels())
      setLoadState('ready')
    })
  }, [absorb])

  React.useEffect(() => {
    load()
    // 预置项只是填空提示, 拿不到也不该阻断本页 —— 用户照样能选「自定义」手填地址。
    void getModelProviders().then((payload) =>
      setPresets(payload?.providers ?? [])
    )
  }, [load])

  // 两个 tab 同时挂载(隐藏的那个只是 hidden), 所以「模型配置」页改掉某个模型的显示状态后,
  // 本页缓存的连接库存必须跟着走 —— 否则接着编辑这条连接会把 hidden 标记连同旧库存一起
  // 提交回去, 悄悄把用户关掉的模型放回来。
  const storedProfiles = state.catalog.personalProfiles
  React.useEffect(() => {
    if (storedProfiles) setProfiles(storedProfiles.profiles)
  }, [storedProfiles])

  const openForm = (next: ModelEndpointForm): void => {
    setProbe('')
    setError('')
    setManualModel('')
    setModelQuery('')
    setManualOpen(false)
    setForm(next)
  }

  const pickConnection = (profile: PersonalApiProfile): void => {
    setSelectedId(profile.id)
    if (profile.authentication === 'oauth') setForm(null)
    else openForm(formOf(profile))
  }

  React.useEffect(() => {
    if (selectedId || form || profiles.length === 0) return
    const first = profiles[0]
    setSelectedId(first.id)
    if (first.authentication !== 'oauth') setForm(formOf(first))
  }, [profiles, selectedId, form])

  const startNewConnection = (providerId: string): void => {
    setSelectedId('')
    const preset = presets.find((item) => item.id === providerId)
    openForm({
      ...EMPTY_MODEL_ENDPOINT_FORM,
      providerId,
      baseUrl: preset?.base_url ?? '',
      wireApi: preset?.wire_api || EMPTY_MODEL_ENDPOINT_FORM.wireApi
    })
  }

  const pickProvider = (providerId: string): void => {
    if (!form || busy) return
    setError('')
    setProbe('')
    const preset = presets.find((item) => item.id === providerId)
    setForm(
      preset
        ? {
            ...form,
            providerId,
            selectedModels: [],
            candidates: [],
            smallModelName: '',
            baseUrl: preset.base_url,
            wireApi: preset.wire_api || 'responses'
          }
        : { ...form, providerId }
    )
  }

  const activePreset = form
    ? presets.find((item) => item.id === form.providerId)
    : undefined

  const selectedSubscription = profiles.find(
    (profile) => profile.id === selectedId && profile.authentication === 'oauth'
  )
  const newSubscription = form?.providerId === CHATGPT_PROVIDER_ID
  const subscriptionCreated = (profile: PersonalApiProfile): void => {
    setSelectedId(profile.id)
    setForm(null)
  }

  const customConnection =
    form?.providerId === CUSTOM_PROVIDER_ID ||
    Boolean(
      form?.id &&
        activePreset &&
        (form.baseUrl !== activePreset.base_url ||
          form.wireApi !== activePreset.wire_api)
    )
  const connectingPreset = Boolean(
    form && !customConnection && (!form.id || form.apiKey.trim())
  )

  // 启停/删除会同时改变模型目录与当前选中项, 所以要把整份投影写回 store,
  // 否则模型选择器还停在旧的选中项上。
  const absorbSelection = (
    payload: ModelSelectionResp | null,
    fallback: ModelPageFailure
  ): void => {
    if (!payload) {
      setError(fallback)
      return
    }
    absorb(payload)
    act.applyModelCatalog(payload)
  }

  const save = async (): Promise<void> => {
    if (!form) return
    // 设计稿要求缺 Key 时点主按钮给红字提示, 而不是把按钮钉死在 disabled。
    if (connectingPreset && !form.id && !form.apiKey.trim()) {
      setError(t('accountPanel.modelsPage.apiKeyRequired'))
      return
    }
    setBusy(true)
    setError('')
    setProbe('')
    let ready = form
    if (connectingPreset) {
      const directory = await listPersonalApiModels(inputOf(form), form.id)
      if (
        !directory.ok ||
        !directory.data.ok ||
        directory.data.models.length === 0
      ) {
        setBusy(false)
        setError(directory.ok ? directory.data.message : directory)
        return
      }
      ready = {
        ...form,
        candidates: directory.data.models,
        selectedModels: form.selectedModels
      }
    }
    const result = ready.id
      ? await updatePersonalApiProfile(ready.id, inputOf(ready))
      : await createPersonalApiProfile(inputOf(ready))
    setBusy(false)
    if (!result.ok) {
      setError(result)
      return
    }
    absorb(result.data)
    // 双栏页的右栏始终显示当前选中的连接, 保存后停在这条上并按回包刷新草稿。
    const saved = result.data.profile
    if (saved) {
      setSelectedId(saved.id)
      setForm({ ...formOf(saved), candidates: ready.candidates })
    }
    // 勾选变化会改变模型菜单里的条目, 所以顺带把目录也刷新。
    act.applyModelCatalog(await getModels())
  }

  const test = async (): Promise<void> => {
    if (!form) return
    setBusy(true)
    setError('')
    setProbe('')
    const result = await probePersonalApi(inputOf(form), form.id)
    setBusy(false)
    if (!result.ok) {
      setError(result)
      return
    }
    setProbeOk(result.data.ok)
    setProbe(`${result.data.message}（${result.data.latency_ms} ms）`)
  }

  const fetchModels = async (): Promise<void> => {
    if (!form) return
    setBusy(true)
    setError('')
    setProbe('')
    const result = await listPersonalApiModels(inputOf(form), form.id)
    setBusy(false)
    if (!result.ok) {
      // 刷新失败保留原候选与原勾选: 清空会让用户以为自己的勾选丢了。
      setError(result)
      return
    }
    setForm((current) =>
      current
        ? {
            ...current,
            candidates: mergeCandidates(
              result.data.models,
              current.selectedModels
            )
          }
        : current
    )
    setProbeOk(result.data.ok)
    setProbe(result.data.message)
  }

  const toggleModel = (modelId: string): void => {
    setForm((current) => {
      if (!current) return current
      const checked = current.selectedModels.some(
        (model) => model.id === modelId
      )
      return {
        ...current,
        selectedModels: checked
          ? current.selectedModels.filter((model) => model.id !== modelId)
          : [...current.selectedModels, { id: modelId, label: '' }]
      }
    })
  }

  const visibleCandidates = (form?.candidates ?? []).filter((id) =>
    id.toLowerCase().includes(modelQuery.trim().toLowerCase())
  )

  const toggleAllModels = (): void => {
    setForm((current) => {
      if (!current) return current
      const all = visibleCandidates.every((id) =>
        current.selectedModels.some((model) => model.id === id)
      )
      return {
        ...current,
        selectedModels: all
          ? current.selectedModels.filter(
              (model) => !visibleCandidates.includes(model.id)
            )
          : [
              ...current.selectedModels,
              ...visibleCandidates
                .filter(
                  (id) =>
                    !current.selectedModels.some((model) => model.id === id)
                )
                .map((id) => ({ id, label: '' }))
            ]
      }
    })
  }

  const addManualModel = (): void => {
    const modelId = manualModel.trim()
    if (!modelId) return
    setForm((current) => {
      if (!current) return current
      if (current.candidates.includes(modelId)) return current
      return {
        ...current,
        candidates: [...current.candidates, modelId],
        // 手填的模型一定是用户想用的, 加完直接勾上。
        selectedModels: [...current.selectedModels, { id: modelId, label: '' }]
      }
    })
    setManualModel('')
  }

  const toggleEnabled = async (profile: PersonalApiProfile): Promise<void> => {
    setBusy(true)
    setError('')
    const result = await setPersonalApiProfileEnabled(
      profile.id,
      !profile.enabled
    )
    if (result.ok) {
      absorb(result.data)
      act.applyModelCatalog(result.data)
    } else {
      setError(result)
    }
    setBusy(false)
  }

  const remove = async (id: string): Promise<void> => {
    setBusy(true)
    setError('')
    absorbSelection(await deletePersonalApiProfile(id), {
      messageKey: 'models.deleteFailed'
    })
    setBusy(false)
    setForm((current) => (current && current.id === id ? null : current))
    setSelectedId((current) => (current === id ? '' : current))
  }

  // 左栏以厂商为目录: 预设各占一行, 已有连接的预设按连接展开成多行, 自定义连接
  // 单独成行 —— 未添加的预设也看得见, 才能一键进入添加态。
  const presetIds = new Set(presets.map((preset) => preset.id))
  const oauthProfiles = profiles.filter(
    (profile) => profile.authentication === 'oauth'
  )
  type VendorRow =
    | {
        kind: 'profile'
        key: string
        label: string
        profile: PersonalApiProfile
      }
    | { kind: 'empty'; key: string; label: string; providerId: string }
  const vendorRows: VendorRow[] = [
    ...presets.flatMap((preset): VendorRow[] => {
      const mine = profiles.filter(
        (profile) =>
          profile.authentication !== 'oauth' && profile.preset_id === preset.id
      )
      const label =
        providerPresetText(preset, accountActions).label || preset.id
      return mine.length > 0
        ? mine.map((profile) => ({
            kind: 'profile' as const,
            key: profile.id,
            label,
            profile
          }))
        : [
            {
              kind: 'empty' as const,
              key: `empty-${preset.id}`,
              label,
              providerId: preset.id
            }
          ]
    }),
    ...(oauthProfiles.length > 0
      ? oauthProfiles.map((profile): VendorRow => ({
          kind: 'profile',
          key: profile.id,
          label: accountActions('models.chatgptSubscription'),
          profile
        }))
      : [
          {
            kind: 'empty',
            key: `empty-${CHATGPT_PROVIDER_ID}`,
            label: accountActions('models.chatgptSubscription'),
            providerId: CHATGPT_PROVIDER_ID
          } as VendorRow
        ]),
    ...profiles
      .filter(
        (profile) =>
          profile.authentication !== 'oauth' &&
          !presetIds.has(profile.preset_id || '')
      )
      .map((profile): VendorRow => ({
        kind: 'profile',
        key: profile.id,
        label: profile.name || profile.base_url,
        profile
      }))
  ]
  const needle = query.trim().toLowerCase()
  const filteredRows = vendorRows.filter((row) =>
    !needle
      ? true
      : row.label.toLowerCase().includes(needle) ||
        (row.kind === 'profile' &&
          (row.profile.name.toLowerCase().includes(needle) ||
            row.profile.base_url.toLowerCase().includes(needle)))
  )
  const enabledCount = profiles.filter((profile) => profile.enabled).length
  const checkedIds = new Set(form?.selectedModels.map((model) => model.id))

  const detailLabel = form
    ? form.providerId === CUSTOM_PROVIDER_ID
      ? form.previewName.trim() || t('accountPanel.modelsPage.customAdd')
      : providerPresetText(activePreset, accountActions).label ||
        form.previewName.trim() ||
        form.baseUrl
    : selectedSubscription
      ? accountActions('models.chatgptSubscription')
      : ''

  // 上下文徽章只给已声明过窗口的模型; 候选列表只有 ID, 不猜数值。
  const contextBadgeOf = (modelId: string): string => {
    const known = form?.selectedModels.find((model) => model.id === modelId)
    return known?.context_window
      ? formatContextBadge(known.context_window)
      : ''
  }

  const cancelDraft = (): void => {
    setError('')
    setProbe('')
    if (form?.id) {
      const current = profiles.find((profile) => profile.id === form.id)
      if (current) {
        openForm(formOf(current))
        return
      }
    }
    if (profiles.length > 0) pickConnection(profiles[0])
    else {
      setForm(null)
      setSelectedId('')
    }
  }

  return (
    <div
      className={
        embedded ? 'flex h-full min-h-0 flex-col' : MODEL_PAGE_CLASS_NAME
      }
      data-testid="account-settings-models"
    >
      {!embedded && (
        <SettingsPageHeader
          title={t('accountPanel.modelsPage.title')}
          description={t('accountPanel.modelsPage.description')}
        />
      )}
      <div className={MODEL_SHELL_CLASS_NAME}>
        <aside className={MODEL_PANE_CLASS_NAME}>
          <div className={MODEL_PANE_TITLE_CLASS_NAME}>
            <span className={MODEL_PANE_TITLE_TEXT_CLASS_NAME}>
              {t('accountPanel.modelsPage.vendors')}
            </span>
            <span className={MODEL_PANE_COUNT_CLASS_NAME}>
              {vendorRows.length > 0
                ? accountActions('models.enabledCount', {
                    enabled: enabledCount,
                    total: vendorRows.length
                  })
                : t('accountPanel.modelsPage.none')}
            </span>
          </div>
          <div className={MODEL_PANE_SEARCH_CLASS_NAME}>
            <Input
              value={query}
              placeholder={t('accountPanel.modelsPage.searchVendors')}
              data-testid="model-connection-search"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className={MODEL_PANE_LIST_CLASS_NAME}>
            {loadState === 'loading' && (
              <div className={MODEL_PANE_EMPTY_CLASS_NAME}>
                {t('accountPanel.modelsPage.loading')}
              </div>
            )}
            {loadState === 'ready' && filteredRows.length === 0 && (
              <div className={MODEL_PANE_EMPTY_CLASS_NAME}>
                {needle
                  ? t('accountPanel.modelsPage.noMatch')
                  : accountActions('models.empty')}
              </div>
            )}
            {loadState === 'ready' &&
              filteredRows.map((row) => {
                const selected =
                  row.kind === 'profile'
                    ? selectedId === row.profile.id
                    : selectedId === '' &&
                      form !== null &&
                      !form.id &&
                      form.providerId === row.providerId
                return (
                  <div
                    key={row.key}
                    className={MODEL_CONNECTION_ROW_CLASS_NAME(selected)}
                    data-testid={`model-connection-row-${row.key}`}
                  >
                    <Button
                      type="button"
                      size="content"
                      unstyled
                      className={MODEL_CONNECTION_PICK_CLASS_NAME}
                      data-testid={
                        row.kind === 'profile'
                          ? `model-connection-pick-${row.profile.id}`
                          : `model-vendor-empty-${row.providerId}`
                      }
                      onClick={() =>
                        row.kind === 'profile'
                          ? pickConnection(row.profile)
                          : startNewConnection(row.providerId)
                      }
                    >
                      <Avatar
                        size="sm"
                        fallback={providerInitials(row.label)}
                        aria-hidden={true}
                      />
                      <span className={MODEL_CONNECTION_TEXT_CLASS_NAME}>
                        <span className={MODEL_CONNECTION_NAME_CLASS_NAME}>
                          {row.label}
                        </span>
                        <span className={MODEL_CONNECTION_META_CLASS_NAME}>
                          {row.kind === 'empty'
                            ? t('accountPanel.modelsPage.notAdded')
                            : row.profile.enabled
                              ? t('accountPanel.modelsPage.enabled')
                              : t('accountPanel.modelsPage.disabled')}
                          {row.kind === 'profile'
                            ? ` · ${t('accountPanel.modelsPage.selected', { count: row.profile.selected_models.length })}`
                            : ''}
                          {row.kind === 'profile' &&
                          row.profile.authentication === 'oauth'
                            ? row.profile.oauth?.state === 'connected'
                              ? accountActions('models.chatgptConnected')
                              : accountActions('models.chatgptLoginRequired')
                            : row.kind === 'profile' && !row.profile.has_api_key
                              ? accountActions('models.noKey')
                              : ''}
                        </span>
                      </span>
                    </Button>
                    <Switch
                      checked={row.kind === 'profile' && row.profile.enabled}
                      disabled={busy || row.kind === 'empty'}
                      aria-label={accountActions('models.enableNamed', {
                        name: row.label
                      })}
                      data-testid={`model-connection-enabled-${row.key}`}
                      onCheckedChange={() => {
                        if (row.kind === 'profile') void toggleEnabled(row.profile)
                      }}
                    />
                  </div>
                )
              })}
          </div>
          <Button
            type="button"
            size="content"
            unstyled
            className={MODEL_PANE_ADD_CLASS_NAME}
            disabled={busy || loadState !== 'ready'}
            data-testid="model-connection-add"
            onClick={() =>
              startNewConnection(presets[0]?.id || CUSTOM_PROVIDER_ID)
            }
          >
            <Icon name="plus" size={13} sw={1.8} />
            {t('accountPanel.modelsPage.customAdd')}
          </Button>
        </aside>

        <section className={MODEL_DETAIL_CLASS_NAME}>
          {(form || selectedSubscription) && (
            <div className={MODEL_DETAIL_HEAD_CLASS_NAME}>
              <Avatar
                size="md"
                fallback={providerInitials(detailLabel)}
                aria-hidden={true}
              />
              <span className={MODEL_DETAIL_HEAD_TEXT_CLASS_NAME}>
                <span className={MODEL_CONNECTION_NAME_CLASS_NAME}>
                  {detailLabel}
                </span>
                <span className={MODEL_FIELD_HINT_CLASS_NAME}>
                  {t('accountPanel.modelsPage.configureHint')}
                </span>
              </span>
            </div>
          )}
          {selectedSubscription && !form && (
            <div className={MODEL_DETAIL_SCROLL_CLASS_NAME}>
              <SubscriptionConnections
                profiles={[selectedSubscription]}
                refresh={load}
              />
            </div>
          )}
          {!form && !selectedSubscription && (
            <div className={MODEL_DETAIL_SCROLL_CLASS_NAME}>
              <div className={MODEL_PANE_EMPTY_CLASS_NAME}>
                {t('accountPanel.modelsPage.selectHint')}
              </div>
            </div>
          )}
          {form && (
            <>
              <div
                className={MODEL_DETAIL_SCROLL_CLASS_NAME}
                data-testid="model-endpoint-form"
              >
                <div className={MODEL_FORM_GRID_CLASS_NAME}>
                  {!form.id && (
                    <ModelEndpointField
                      label={t('accountPanel.modelsPage.provider')}
                      hint={
                        providerPresetText(activePreset, accountActions).note ||
                        t('accountPanel.modelsPage.providerHint')
                      }
                    >
                      <Select
                        value={form.providerId}
                        disabled={busy}
                        onValueChange={pickProvider}
                      >
                        <SelectTrigger
                          data-testid="model-endpoint-provider"
                          aria-label={t('accountPanel.modelsPage.provider')}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={CHATGPT_PROVIDER_ID}>
                            {accountActions('models.chatgptSubscription')}
                          </SelectItem>
                          {presets.map((preset) => (
                            <SelectItem key={preset.id} value={preset.id}>
                              {providerPresetText(preset, accountActions).label}
                            </SelectItem>
                          ))}
                          <SelectItem value={CUSTOM_PROVIDER_ID}>
                            {accountActions('models.customProvider')}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </ModelEndpointField>
                  )}

                  {!newSubscription && (
                    <>
                      {customConnection && (
                        <>
                          <ModelEndpointField
                            label={t('accountPanel.modelsPage.name')}
                            hint={t('accountPanel.modelsPage.nameHint')}
                          >
                            <Input
                              value={form.previewName}
                              placeholder={t(
                                'accountPanel.modelsPage.namePlaceholder'
                              )}
                              data-testid="model-endpoint-name"
                              onChange={(event) =>
                                setForm({
                                  ...form,
                                  previewName: event.target.value
                                })
                              }
                            />
                          </ModelEndpointField>

                          <ModelEndpointField
                            label={t('accountPanel.modelsPage.wire')}
                            hint={accountActions('models.wireHint')}
                          >
                            <Select
                              value={form.wireApi || 'responses'}
                              data-testid="model-endpoint-wire-api"
                              onValueChange={(value) =>
                                setForm({
                                  ...form,
                                  wireApi: value as PersonalApiWireApi
                                })
                              }
                            >
                              <SelectTrigger>
                                <SelectValue
                                  placeholder={accountActions(
                                    'models.wireResponses'
                                  )}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                {WIRE_API_CHOICES.map((choice) => (
                                  <SelectItem
                                    key={choice.value}
                                    value={choice.value}
                                  >
                                    {accountActions(choice.labelKey)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </ModelEndpointField>
                        </>
                      )}
                      <ModelEndpointField
                        label={t('accountPanel.modelsPage.baseUrlLabel')}
                        hint={
                          customConnection
                            ? t('accountPanel.modelsPage.base')
                            : activePreset?.note ||
                              t('accountPanel.modelsPage.baseUrlPresetHint')
                        }
                      >
                        <Input
                          value={form.baseUrl}
                          placeholder="http://127.0.0.1:8000/v1"
                          data-testid="model-endpoint-base-url"
                          onChange={(event) =>
                            setForm({
                              ...form,
                              baseUrl: event.target.value
                            })
                          }
                        />
                      </ModelEndpointField>
                      <ModelEndpointField
                        label={t('accountPanel.modelsPage.api')}
                        hint={
                          form.id
                            ? t('accountPanel.modelsPage.apiKeep')
                            : providerPresetText(activePreset, accountActions)
                                .credentialHint ||
                              t('accountPanel.modelsPage.apiSave')
                        }
                      >
                        <PasswordInput
                          value={form.apiKey}
                          placeholder={
                            form.id
                              ? t('accountPanel.modelsPage.apiNo')
                              : 'sk-…'
                          }
                          data-testid="model-endpoint-api-key"
                          disabled={busy}
                          onChange={(event) =>
                            setForm({ ...form, apiKey: event.target.value })
                          }
                        />
                      </ModelEndpointField>

                      <div className={MODEL_STATUS_ROW_CLASS_NAME}>
                        <span
                          className={MODEL_STATUS_DOT_CLASS_NAME(
                            probe ? (probeOk ? 'ok' : 'fail') : 'idle'
                          )}
                          aria-hidden={true}
                        />
                        <span className={MODEL_FIELD_HINT_CLASS_NAME}>
                          {probe || t('accountPanel.modelsPage.unverified')}
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          data-testid="model-endpoint-probe"
                          onClick={() => void test()}
                        >
                          {busy
                            ? t('accountPanel.modelsPage.busy')
                            : t('accountPanel.modelsPage.test')}
                        </Button>
                      </div>

                      {customConnection && (
                        <ModelEndpointField
                          label={t('accountPanel.modelsPage.small')}
                          hint={t('accountPanel.modelsPage.smallHint')}
                        >
                          <Input
                            value={form.smallModelName}
                            placeholder={t('accountPanel.modelsPage.empty')}
                            data-testid="model-endpoint-small-model-name"
                            onChange={(event) =>
                              setForm({
                                ...form,
                                smallModelName: event.target.value
                              })
                            }
                          />
                        </ModelEndpointField>
                      )}
                    </>
                  )}
                </div>

                {/* Input capabilities are managed per selected model below. */}
                {newSubscription && (
                  <SubscriptionConnections
                    profiles={[]}
                    refresh={load}
                    onCreated={subscriptionCreated}
                  />
                )}
                {!newSubscription && (
                  <>
                    {connectingPreset && (
                      <div role="status" className={FORM_NOTICE_CLASS_NAME}>
                        {t('accountPanel.modelsPage.connectHint')}
                      </div>
                    )}
                    {(customConnection || !connectingPreset) && (
                      <>
                        <div className={MODEL_SECTION_HEAD_CLASS_NAME}>
                          <span className={MODEL_FIELD_LABEL_CLASS_NAME}>
                            {t('accountPanel.modelsPage.models')}
                          </span>
                          <div className={MODEL_ROW_ACTIONS_CLASS_NAME}>
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              disabled={busy}
                              data-testid="model-endpoint-fetch-models"
                              onClick={() => void fetchModels()}
                            >
                              {t('accountPanel.modelsPage.refresh')}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              disabled={busy}
                              data-testid="model-endpoint-manual-toggle"
                              onClick={() => setManualOpen((open) => !open)}
                            >
                              <Icon name="plus" size={12} sw={1.8} />
                              {t('accountPanel.modelsPage.addModel')}
                            </Button>
                          </div>
                        </div>

                        {(customConnection || manualOpen) && (
                          <div className={MODEL_NAME_ROW_CLASS_NAME}>
                            <Input
                              value={manualModel}
                              placeholder={t('accountPanel.modelsPage.manual')}
                              data-testid="model-endpoint-manual-model"
                              onChange={(event) =>
                                setManualModel(event.target.value)
                              }
                            />
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              disabled={busy || !manualModel.trim()}
                              data-testid="model-endpoint-add-model"
                              onClick={() => addManualModel()}
                            >
                              {t('accountPanel.modelsPage.addModel')}
                            </Button>
                          </div>
                        )}

                        <Input
                          value={modelQuery}
                          onChange={(event) =>
                            setModelQuery(event.target.value)
                          }
                          placeholder={t(
                            'accountPanel.modelsPage.searchModels'
                          )}
                          aria-label={t('accountPanel.modelsPage.filter')}
                          data-testid="model-endpoint-model-search"
                        />
                        {form.candidates.length > 0 && (
                          <div
                            className={MODEL_SELECTION_ROW_CLASS_NAME(false)}
                          >
                            <Checkbox
                              checked={
                                visibleCandidates.length > 0 &&
                                visibleCandidates.every((id) =>
                                  checkedIds.has(id)
                                )
                              }
                              disabled={busy || visibleCandidates.length === 0}
                              aria-label={t(
                                'accountPanel.modelsPage.selectAll'
                              )}
                              data-testid="model-endpoint-select-all"
                              onCheckedChange={() => toggleAllModels()}
                            />
                            <span className={MODEL_FIELD_HINT_CLASS_NAME}>
                              {t('accountPanel.modelsPage.selectionSimple', {
                                selected: form.selectedModels.length,
                                total: form.candidates.length
                              })}
                            </span>
                          </div>
                        )}

                        {visibleCandidates.length === 0 && (
                          <div className={MODEL_FIELD_HINT_CLASS_NAME}>
                            {t('accountPanel.modelsPage.noModels')}
                          </div>
                        )}
                        <div className={MODEL_SELECTION_LIST_CLASS_NAME}>
                          {visibleCandidates.map((modelId) => (
                            <div
                              key={modelId}
                              className={MODEL_SELECTION_ROW_CLASS_NAME(
                                checkedIds.has(modelId)
                              )}
                            >
                              <Checkbox
                                checked={checkedIds.has(modelId)}
                                disabled={busy}
                                aria-label={modelId}
                                data-testid={`model-endpoint-model-${modelId}`}
                                onCheckedChange={() => toggleModel(modelId)}
                              />
                              <span className={MODEL_SELECTION_NAME_CLASS_NAME}>
                                {modelId}
                              </span>
                              {contextBadgeOf(modelId) && (
                                <Badge size="sm" tone="neutral">
                                  {contextBadgeOf(modelId)}
                                </Badge>
                              )}
                            </div>
                          ))}
                        </div>
                        <div className={MODEL_FIELD_HINT_CLASS_NAME}>
                          {t('accountPanel.modelsPage.selectionHintChat')}
                        </div>
                        {form.selectedModels.map((model) => (
                          <React.Fragment key={`${form.id}:${model.id}`}>
                            <ModelEndpointField
                              label={accountActions('models.reasoningNamed', {
                                name: model.label || model.id
                              })}
                              hint={t('accountPanel.modelsPage.reasoningHint')}
                            >
                              <Input
                                aria-label={accountActions(
                                  'models.reasoningLevelNamed',
                                  { name: model.id }
                                )}
                                defaultValue={(
                                  model.reasoning_efforts ?? []
                                ).join(',')}
                                placeholder={t(
                                  'accountPanel.modelsPage.reasoningPlaceholder'
                                )}
                                disabled={busy}
                                onBlur={(event) => {
                                  const values = event.target.value
                                    .split(',')
                                    .map((value) => value.trim())
                                    .filter(Boolean)
                                  setForm({
                                    ...form,
                                    selectedModels: form.selectedModels.map(
                                      (item) =>
                                        item.id === model.id
                                          ? {
                                              ...item,
                                              reasoning_efforts: values.length
                                                ? values
                                                : null
                                            }
                                          : item
                                    )
                                  })
                                }}
                              />
                            </ModelEndpointField>
                            <div className="grid grid-cols-2 gap-3">
                              <ModelEndpointField
                                label={accountActions(
                                  'modelSettings.contextWindow'
                                )}
                                hint={accountActions(
                                  'models.contextWindowHint'
                                )}
                              >
                                <Input
                                  type="number"
                                  value={model.context_window ?? ''}
                                  placeholder={accountActions(
                                    'models.contextWindowPlaceholder'
                                  )}
                                  disabled={busy}
                                  onChange={(event) =>
                                    setForm({
                                      ...form,
                                      selectedModels: form.selectedModels.map(
                                        (item) =>
                                          item.id === model.id
                                            ? {
                                                ...item,
                                                context_window: event.target
                                                  .value
                                                  ? Number(event.target.value)
                                                  : null
                                              }
                                            : item
                                      )
                                    })
                                  }
                                />
                              </ModelEndpointField>
                              <ModelEndpointField
                                label={accountActions('models.maxOutput')}
                                hint={accountActions('models.maxOutputHint')}
                              >
                                <Input
                                  type="number"
                                  value={model.max_output_tokens ?? ''}
                                  placeholder={accountActions(
                                    'models.maxOutputPlaceholder'
                                  )}
                                  disabled={busy}
                                  onChange={(event) =>
                                    setForm({
                                      ...form,
                                      selectedModels: form.selectedModels.map(
                                        (item) =>
                                          item.id === model.id
                                            ? {
                                                ...item,
                                                max_output_tokens: event.target
                                                  .value
                                                  ? Number(event.target.value)
                                                  : null
                                              }
                                            : item
                                      )
                                    })
                                  }
                                />
                              </ModelEndpointField>
                            </div>
                          </React.Fragment>
                        ))}
                      </>
                    )}
                    {probe && (
                      <div
                        className={
                          probeOk
                            ? FORM_NOTICE_CLASS_NAME
                            : FORM_ERROR_CLASS_NAME
                        }
                      >
                        {probe}
                      </div>
                    )}
                    {error && (
                      <div
                        role="alert"
                        className={FORM_ERROR_CLASS_NAME}
                        data-testid="model-endpoint-error"
                      >
                        {typeof error === 'string'
                          ? error
                          : 'messageKey' in error
                            ? accountActions(error.messageKey)
                            : profileFailureText(error, subscriptionText)}
                      </div>
                    )}
                  </>
                )}
              </div>

              {!newSubscription && (
                <div className={MODEL_DETAIL_FOOT_CLASS_NAME}>
                  <div className={MODEL_ROW_ACTIONS_CLASS_NAME}>
                    {form.id && (
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        disabled={busy}
                        data-testid={`model-endpoint-delete-${form.id}`}
                        onClick={() => void remove(form.id)}
                      >
                        {accountActions('models.delete')}
                      </Button>
                    )}
                  </div>
                  <div className={MODEL_ROW_ACTIONS_CLASS_NAME}>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      data-testid="model-endpoint-cancel"
                      onClick={cancelDraft}
                    >
                      {t('accountPanel.common.cancel')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy}
                      data-testid="model-endpoint-save"
                      onClick={() => void save()}
                    >
                      {busy
                        ? t('accountPanel.modelsPage.connecting')
                        : form.id
                          ? t('accountPanel.modelsPage.save')
                          : t('accountPanel.modelsPage.addVendor')}
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {error && !form && (
        <div role="alert" className={PAGE_ERROR_CLASS_NAME}>
          <span>
            {typeof error === 'string'
              ? error
              : 'messageKey' in error
                ? accountActions(error.messageKey)
                : profileFailureText(error, subscriptionText)}
          </span>
          {loadState === 'error' && (
            <Button
              size="sm"
              type="button"
              variant="outline"
              data-testid="model-endpoint-retry"
              onClick={() => load()}
            >
              {accountActions('actions.retry')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

const MODEL_CONTEXT_TICKS = [200000, 400000, 1000000] as const

// 刻度是 token 量级的工程记法, 不是文案: 中英界面都保持 200k/400k/1M,
// 不走 locale 数字格式 (中文 compact 会渲染成「20万」)。
function contextTickLabel(tokens: number): string {
  return tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${tokens / 1_000}k`
}

function ModelReasoningSetting({
  model
}: {
  model: ModelInfo
}): React.JSX.Element {
  const { state, set, act } = useApp()
  const { t } = useTranslation('account')
  const { t: conversation } = useTranslation('conversation')
  const { t: subscription } = useTranslation('subscription')
  const { t: components } = useTranslation('components')
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<
    { messageKey: 'models.loadFailed' } | PersonalApiFailure | null
  >(null)
  const efforts = model.reasoning_efforts ?? []
  // 「模型默认」伪档位已去除：未选或旧值不在声明档位内时，回落到模型定义的确定默认档。
  const preferred = state.reasoningPreferences[model.key] ?? ''
  const selected = efforts.includes(preferred) ? preferred : modelDefaultEffort(model)
  const editable = Boolean(model.profile_id && model.model_id)

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      // Read the latest connection so edits retain sibling models and credentials.
      const profiles = await getPersonalApiProfiles()
      const profile = profiles?.profiles.find(
        (item) => item.id === model.profile_id
      )
      if (
        !profile ||
        !profile.selected_models.some((item) => item.id === model.model_id)
      ) {
        setError({ messageKey: 'models.loadFailed' })
        return
      }
      const values = [
        ...new Set(
          draft
            .split(',')
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean)
        )
      ]
      const input = inputOf(formOf(profile))
      const result = await updatePersonalApiProfile(profile.id, {
        ...input,
        provider: profile.provider,
        selected_models: input.selected_models.map((item) =>
          item.id === model.model_id
            ? { ...item, reasoning_efforts: values.length ? values : null }
            : item
        )
      })
      if (!result.ok) {
        setError(result)
        return
      }
      act.setPersonalProfiles(result.data)
      const catalog = await getModels()
      if (!catalog) {
        setError({ messageKey: 'models.loadFailed' })
        return
      }
      act.applyModelCatalog(catalog)
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {editing ? (
        <>
          <Input
            value={draft}
            disabled={busy}
            aria-label={t('models.reasoningLevelNamed', {
              name: model.model_id || model.label
            })}
            placeholder={components(
              'accountPanel.modelsPage.reasoningPlaceholder'
            )}
            helperText={components('accountPanel.modelsPage.reasoningHint')}
            data-testid={`model-reasoning-levels-${model.key}`}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              {t('models.saveEfforts')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setEditing(false)
                setError(null)
              }}
            >
              {t('models.cancelEfforts')}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2">
          {efforts.length ? (
            <Select
              value={selected}
              onValueChange={(value) =>
                set((current) => ({
                  reasoningPreferences: {
                    ...current.reasoningPreferences,
                    [model.key]: value
                  }
                }))
              }
            >
              <SelectTrigger
                className="w-[180px]"
                aria-label={t('models.reasoningNamed', {
                  name: model.model_label || model.label
                })}
                data-testid={`model-reasoning-${model.key}`}
              >
                <SelectValue>
                  {reasoningLabel(selected, conversation)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {efforts.map((effort) => (
                  <SelectItem key={effort} value={effort}>
                    {reasoningLabel(effort, conversation)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="text-sm text-[var(--vds-text-secondary)]">
              {model.reasoning?.supported
                ? conversation('reasoning.fixed')
                : t('models.effortsUnconfirmed')}
            </span>
          )}
          {editable && (
            <IconButton
              size="sm"
              variant="ghost"
              className="shrink-0"
              label={t('models.editEfforts')}
              icon={<Icon name="edit-square" size={16} />}
              data-testid={`model-reasoning-edit-${model.key}`}
              onClick={() => {
                setDraft(efforts.join(','))
                setError(null)
                setEditing(true)
              }}
            />
          )}
        </div>
      )}
      {error && (
        <div role="alert" className={FORM_ERROR_CLASS_NAME}>
          {'messageKey' in error
            ? t(error.messageKey)
            : profileFailureText(error, subscription)}
        </div>
      )}
    </div>
  )
}

function ModelSettingsPage({
  embedded = false
}: { embedded?: boolean } = {}): React.JSX.Element {
  const { t } = useTranslation('account')
  const { t: subscription } = useTranslation('subscription')
  const { state, act } = useApp()
  // 管理页必须同时列出可见与已隐藏两半, 否则「关闭显示」就成了不可逆操作。两半都由服务端
  // 同一套投影产出, 这里不自己拼厂商标签或复合 key —— 那会变成第二份真值。
  const { models, hiddenModels } = state.catalog
  const rows = React.useMemo(
    () => [...models, ...hiddenModels],
    [models, hiddenModels]
  )
  const hiddenKeys = React.useMemo(
    () => new Set(hiddenModels.map((model) => model.key)),
    [hiddenModels]
  )
  const [contextOverrides, setContextOverrides] = React.useState<
    Record<string, number>
  >({})
  const [saved, setSaved] = React.useState(false)
  const [busyKey, setBusyKey] = React.useState('')
  const [error, setError] = React.useState<PersonalApiFailure | null>(null)

  // 显示状态是即时落盘的开关, 与「模型服务」页的连接开关同一种语义, 不经「保存设置」——
  // 那个按钮只管本页尚未接后端的上下文滑杆。
  const toggleVisibility = async (
    model: ModelInfo,
    hidden: boolean
  ): Promise<void> => {
    if (!model.profile_id || !model.model_id) return
    setBusyKey(model.key)
    setError(null)
    const result = await setPersonalApiModelVisibility(
      model.profile_id,
      model.model_id,
      hidden
    )
    if (result.ok) {
      act.setPersonalProfiles(result.data)
      act.applyModelCatalog(result.data)
    } else {
      setError(result)
    }
    setBusyKey('')
  }

  return (
    <div
      className={
        embedded ? MODEL_SETTINGS_EMBEDDED_CLASS_NAME : MODEL_PAGE_CLASS_NAME
      }
      data-testid="model-settings-page"
    >
      {!embedded && (
        <SettingsPageHeader
          title={t('modelSettings.title')}
          description={t('modelSettings.description')}
        />
      )}
      <div className={MODEL_SETTINGS_ACTIONS_CLASS_NAME}>
        <Button type="button" variant="primary" onClick={() => setSaved(true)}>
          {saved ? t('modelSettings.saved') : t('modelSettings.save')}
        </Button>
      </div>
      <div className={MODEL_SETTINGS_TABLE_CLASS_NAME}>
        <div className={MODEL_SETTINGS_TABLE_INNER_CLASS_NAME}>
          <div className={MODEL_SETTINGS_TABLE_HEADER_CLASS_NAME}>
            <span>{t('modelSettings.name')}</span>
            <span>{t('modelSettings.reasoning')}</span>
            <span>{t('modelSettings.visibility')}</span>
            <span>{t('modelSettings.contextWindow')}</span>
          </div>
          {rows.map((model) => {
            const selected = contextOverrides[model.key]
            const builtin = model.source === 'builtin'
            const visible = !hiddenKeys.has(model.key)
            return (
              <div
                key={model.key}
                className={MODEL_SETTINGS_TABLE_ROW_CLASS_NAME}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {model.model_label || model.label}
                  </div>
                  <div className="truncate text-xs text-[var(--vds-text-tertiary)]">
                    {builtin
                      ? t('modelSettings.builtin')
                      : model.provider_label || model.provider}
                  </div>
                </div>
                <ModelReasoningSetting model={model} />
                <Toggle
                  checked={builtin ? true : visible}
                  disabled={builtin || busyKey === model.key}
                  testid={`model-visibility-${model.key}`}
                  label={t('modelSettings.showNamed', { name: model.label })}
                  onChange={(value: boolean) => {
                    if (builtin) return
                    void toggleVisibility(model, !value)
                  }}
                />
                <div className="w-[210px]">
                  <Slider
                    aria-label={t('modelSettings.contextWindowNamed', {
                      name: model.label
                    })}
                    min={0}
                    max={MODEL_CONTEXT_TICKS.length - 1}
                    step={1}
                    value={Math.max(
                      0,
                      MODEL_CONTEXT_TICKS.findIndex(
                        (value) => value === selected
                      )
                    )}
                    onValueChange={(value: number) => {
                      setSaved(false)
                      setContextOverrides((current) => ({
                        ...current,
                        [model.key]: MODEL_CONTEXT_TICKS[value]
                      }))
                    }}
                  />
                  <div className="mt-1 flex justify-between text-[11px] text-[var(--vds-text-tertiary)]">
                    {MODEL_CONTEXT_TICKS.map((value) => (
                      <span key={value}>{contextTickLabel(value)}</span>
                    ))}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {error && (
        <div role="alert" className={PAGE_ERROR_CLASS_NAME}>
          {profileFailureText(error, subscription)}
        </div>
      )}
    </div>
  )
}

function ModelConfigurationPage(): React.JSX.Element {
  const { t } = useTranslation('components')

  return (
    <SettingsPage
      data-testid="account-settings-model-configuration"
      title={t('accountPanel.modelsPage.title')}
      description={t('accountPanel.modelsPage.description')}
      scroll="none"
    >
      <PageBody className="min-h-0 flex-1 grid-rows-[minmax(0,1fr)]">
        <Tabs
          className={MODEL_CONFIGURATION_TABS_CLASS_NAME}
          defaultValue="service"
        >
          <TabsList
            className="w-fit justify-self-start"
            aria-label={t('accountPanel.modelsPage.tabsLabel')}
          >
            <TabsTrigger value="service">
              {t('accountPanel.modelsPage.serviceTab')}
            </TabsTrigger>
            <TabsTrigger value="configuration">
              {t('accountPanel.modelsPage.configurationTab')}
            </TabsTrigger>
          </TabsList>
          <TabsContent
            className={MODEL_SERVICE_TAB_CONTENT_CLASS_NAME}
            value="service"
          >
            <ModelServicePage embedded />
          </TabsContent>
          <TabsContent
            className={MODEL_SETTINGS_TAB_CONTENT_CLASS_NAME}
            value="configuration"
          >
            <ModelSettingsPage embedded />
          </TabsContent>
        </Tabs>
      </PageBody>
    </SettingsPage>
  )
}

function NotificationsPage(): React.JSX.Element {
  const { t: accountText } = useTranslation('account')
  const { state, set } = useApp()
  const { t } = useTranslation('components')
  const markAllRead = (): void => {
    set((current) => ({
      sessionActivitySeen: {
        ...current.sessionActivitySeen,
        ...Object.fromEntries(
          current.sessions.map((session) => [
            session.id,
            session.activityAt ?? session.createdAt ?? Date.now() / 1_000
          ])
        )
      }
    }))
  }
  return (
    <SettingsPage
      data-testid="account-settings-notifications"
      title={t('accountPanel.notificationsPage.title')}
      description={t('accountPanel.notificationsPage.description')}
    >
      <div className={NOTIFICATION_CARD_CLASS_NAME}>
        <SettingsRow
          title={t('accountPanel.notificationsPage.desktop')}
          description={t('accountPanel.notificationsPage.desktopDescription')}
          titleClassName={NOTIFICATION_ROW_TITLE_CLASS_NAME}
          descriptionClassName={NOTIFICATION_ROW_DESCRIPTION_CLASS_NAME}
        >
          <Toggle
            checked={state.desktopNotifications}
            testid="notification-desktop"
            label={t('accountPanel.notificationsPage.desktop')}
            onChange={(desktopNotifications) => set({ desktopNotifications })}
          />
        </SettingsRow>
        <SettingsRow
          title={t('accountPanel.notificationsPage.unread')}
          description={t('accountPanel.notificationsPage.unreadDescription')}
          titleClassName={NOTIFICATION_ROW_TITLE_CLASS_NAME}
          descriptionClassName={NOTIFICATION_ROW_DESCRIPTION_CLASS_NAME}
        >
          <Button
            type="button"
            variant="outline"
            data-testid="notification-mark-read"
            onClick={markAllRead}
          >
            {accountText('actions.markAllRead')}
          </Button>
        </SettingsRow>
        <SettingsRow
          title={t('accountPanel.notificationsPage.sound')}
          description={t('accountPanel.notificationsPage.soundDescription')}
          titleClassName={NOTIFICATION_ROW_TITLE_CLASS_NAME}
          descriptionClassName={NOTIFICATION_ROW_DESCRIPTION_CLASS_NAME}
        >
          <Toggle
            checked={state.soundAlerts}
            testid="notification-sound"
            label={t('accountPanel.notificationsPage.sound')}
            onChange={(soundAlerts) => set({ soundAlerts })}
          />
        </SettingsRow>
      </div>
    </SettingsPage>
  )
}

function ArchivedProjectsPage(): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: projectText } = useTranslation('project')
  const { state, set } = useApp()
  const { toast } = useToast()
  const [projects, setProjects] = React.useState<ProjectRef[]>([])
  const [pendingDelete, setPendingDelete] = React.useState<ProjectRef | null>(
    null
  )
  const [busy, setBusy] = React.useState(false)

  const reload = React.useCallback(async (): Promise<void> => {
    const listing = await listProjectListings(true)
    setProjects(
      (listing?.projects ?? []).filter((entry) => entry.archived_at != null)
    )
  }, [])

  // 归档态变化会改变各处默认列表的内容, 必须回写全局项目列表:
  // 全览页、项目下拉这些表面只认 store.projects, 不回写就要等别的刷新点才更新。
  const refreshActiveProjects = React.useCallback(async (): Promise<void> => {
    const active = await listProjects()
    if (active) {
      set({
        projects: active.projects,
        defaultWorkspacePath: active.default || state.defaultWorkspacePath
      })
    }
  }, [set, state.defaultWorkspacePath])

  React.useEffect(() => {
    void reload()
  }, [reload])

  const unarchive = async (project: ProjectRef): Promise<void> => {
    const result = await setProjectArchived(project.id, false)
    if (!result.ok) {
      toast({
        title: projectText('notices.unknown', {
          code: result.error ?? 'unknown_project'
        }),
        tone: 'error'
      })
      return
    }
    toast({ title: projectText('notices.unarchived'), tone: 'success' })
    await Promise.all([reload(), refreshActiveProjects()])
  }

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    const target = pendingDelete
    setBusy(true)
    const result = await forgetProject(target.id)
    setBusy(false)
    setPendingDelete(null)
    if (!result.ok) {
      toast({
        title: projectText('notices.unknown', {
          code: result.error ?? 'unknown_project'
        }),
        tone: 'error'
      })
      return
    }
    toast({ title: t('accountPanel.archives.removed'), tone: 'success' })
    await Promise.all([reload(), refreshActiveProjects()])
  }

  return (
    <SettingsPage
      data-testid="account-settings-archives"
      title={t('accountPanel.archives.title')}
      description={t('accountPanel.archives.description')}
    >
      {projects.length === 0 ? (
        <div
          className="text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-tertiary)]"
          data-testid="account-settings-archives-empty"
        >
          {t('accountPanel.archives.empty')}
        </div>
      ) : (
        <div className="flex min-w-0 max-w-full flex-col gap-[var(--vds-space-2)]">
          {projects.map((project) => (
            <div
              key={project.id}
              className="flex min-w-0 max-w-full items-center gap-[12px] rounded-[var(--vds-settings-card-radius)] border border-[var(--vds-border-default)] px-[16px] py-[12px] bg-[var(--vds-bg-white-default)] shadow-none"
              data-testid={`account-archived-${project.id}`}
            >
              <span className="min-w-0 flex-1">
                <EllipsisText wrapperClassName="w-full" className="text-[14px] font-medium leading-[20px] text-[var(--vds-text-primary)]" tooltipPortalled>
                  {project.name}
                </EllipsisText>
                <EllipsisText
                  wrapperClassName="w-full"
                  className="text-[12px] leading-[18px] text-[var(--vds-text-tertiary)]"
                  tooltipPortalled
                >
                  {project.root}
                </EllipsisText>
              </span>
              <Button
                type="button"
                variant="outline"
                data-testid={`account-archived-restore-${project.id}`}
                onClick={() => void unarchive(project)}
              >
                {t('accountPanel.archives.unarchive')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                data-testid={`account-archived-delete-${project.id}`}
                onClick={() => setPendingDelete(project)}
              >
                {t('accountPanel.archives.delete')}
              </Button>
            </div>
          ))}
        </div>
      )}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPendingDelete(null)
        }}
      >
        <AlertDialogPortal>
          <AlertDialogContent
            className="!z-[var(--vds-z-modal-nested)]"
            overlayClassName="!z-[var(--vds-z-modal-nested-overlay)]"
          >
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('accountPanel.archives.deleteTitle', {
                  name: pendingDelete?.name ?? ''
                })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t('accountPanel.archives.deleteDescription')}
                <span className="block">
                  {t('accountPanel.archives.deleteFilesNote')}
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t('accountPanel.archives.cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                aria-disabled={busy}
                data-testid="account-archived-delete-confirm"
                onClick={() => {
                  if (!busy) void confirmDelete()
                }}
              >
                {t('accountPanel.archives.delete')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogPortal>
      </AlertDialog>
    </SettingsPage>
  )
}

function statusClass(status: SystemPermissionStatus): string {
  if (status === 'granted') return PERMISSION_STATUS_GRANTED_CLASS_NAME
  if (status === 'denied' || status === 'restricted')
    return PERMISSION_STATUS_DENIED_CLASS_NAME
  return ''
}

function PermissionsPage(): React.JSX.Element {
  const { t: permissionText } = useTranslation('account')
  const { t: accountText } = useTranslation('account')
  const { state } = useApp()
  const { t } = useTranslation('components') as {
    t: (key: string, options?: Record<string, unknown>) => string
  }
  const [records, setRecords] = React.useState<
    Record<string, SystemPermissionRecord>
  >({})
  const [loading, setLoading] = React.useState(true)
  const [errorCode, setErrorCode] = React.useState('')
  const error =
    errorCode === 'read'
      ? accountText('accountExtra.permissionRead')
      : errorCode === 'unsupported'
        ? accountText('accountExtra.permissionUnsupported')
        : errorCode === 'open'
          ? accountText('accountExtra.permissionOpen')
          : ''

  const refresh = React.useCallback((): void => {
    setLoading(true)
    setErrorCode('')
    void window.scholarseed
      .systemPermissions()
      .then((snapshot) => {
        setRecords(
          Object.fromEntries(
            snapshot.permissions.map((permission) => [
              permission.id,
              permission
            ])
          )
        )
        setLoading(false)
      })
      .catch(() => {
        setRecords({})
        setLoading(false)
        setErrorCode('read')
      })
  }, [])

  const openPermission = async (id: SystemPermissionId): Promise<void> => {
    setErrorCode('')
    try {
      const opened = await window.scholarseed.openSystemPermission(id)
      if (!opened) setErrorCode('unsupported')
    } catch {
      setErrorCode('open')
    }
  }

  React.useEffect(() => {
    refresh()
    const visibility = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [refresh])

  return (
    <div
      className={SETTINGS_CONTENT_CLASS_NAME}
      data-testid="account-settings-permissions"
    >
      <SettingsPageHeader
        title={t('accountPanel.permissions.title')}
        description={t('accountPanel.permissions.description')}
        action={
          <Button
            className={PANEL_BUTTON_CLASS_NAME}
            size="sm"
            type="button"
            variant="secondary"
            data-testid="permissions-refresh"
            disabled={loading}
            onClick={refresh}
          >
            {loading
              ? t('accountPanel.permissions.checking')
              : t('accountPanel.permissions.check')}
          </Button>
        }
      />
      {error && (
        <div role="alert" className={PAGE_ERROR_CLASS_NAME}>
          {error}
        </div>
      )}
      <div className={PERMISSION_CARD_CLASS_NAME}>
        {PERMISSIONS.map((permission) => {
          const record = records[permission.id]
          const status =
            record?.status ?? (loading ? 'not-determined' : 'query-error')
          const actionable = record?.actionable === true
          return (
            <button
              type="button"
              className={PERMISSION_ROW_CLASS_NAME}
              data-testid={`permission-${permission.id}`}
              disabled={!actionable}
              key={permission.id}
              onClick={() => void openPermission(permission.id)}
            >
              <span className={PERMISSION_ICON_CLASS_NAME}>
                <Icon name={permission.icon} size={15} />
              </span>
              <span className={PERMISSION_COPY_CLASS_NAME}>
                <strong className={STRONG_TEXT_CLASS_NAME}>
                  {t(PERMISSION_TITLE_KEYS[permission.id])}
                </strong>
                <small className={SMALL_TEXT_CLASS_NAME}>
                  {record?.detailCode
                    ? permissionText(PERMISSION_DETAIL_KEYS[record.detailCode])
                    : record?.detail ||
                      t(PERMISSION_DESCRIPTION_KEYS[permission.id])}
                </small>
              </span>
              <span
                className={cx(
                  PERMISSION_STATUS_BASE_CLASS_NAME,
                  statusClass(status)
                )}
                data-status={status}
              >
                {t(PERMISSION_STATUS_KEYS[status])}
              </span>
              {actionable && <Icon name="chevron-right" size={13} />}
            </button>
          )
        })}
      </div>

      <h2 className={SECTION_HEADING_CLASS_NAME}>
        {t('accountPanel.permissions.sharingTitle')}
      </h2>
      <p className={SHARING_LEAD_CLASS_NAME}>
        {t('accountPanel.permissions.sharingLead')}
      </p>
      <div className={SHARING_CARD_CLASS_NAME}>
        <div className={SHARING_COPY_CLASS_NAME}>
          <strong className={STRONG_TEXT_CLASS_NAME}>
            {t('accountPanel.permissions.usage')}
          </strong>
          <small className={SMALL_TEXT_CLASS_NAME}>
            {t('accountPanel.permissions.privacyHint')}
          </small>
        </div>
        <div
          className={SHARING_SEGMENT_CLASS_NAME}
          aria-label={t('accountPanel.permissions.usage')}
        >
          <button
            type="button"
            className={cx(
              SHARING_SEGMENT_BUTTON_CLASS_NAME,
              state.dataSharingMode === 'private'
                ? SHARING_SEGMENT_ACTIVE_CLASS_NAME
                : undefined
            )}
          >
            {accountText('sharing.private')}
          </button>
          <button
            type="button"
            className={SHARING_SEGMENT_BUTTON_CLASS_NAME}
            disabled
            title={t('accountPanel.permissions.uploadDisabled')}
          >
            {accountText('sharing.improve')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function AccountPanel({
  embedded = false,
  page,
  onPage,
  onClose,
  onLogin,
  onLogout
}: {
  embedded?: boolean
  page: AccountSettingsPage
  onPage: (page: AccountSettingsPage) => void
  onClose: () => void
  /** 打开应用内登录层; 账号页在未登录时用它。 */
  onLogin: () => void
  onLogout: () => Promise<AccountLogoutResult>
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: shortcutText } = useTranslation('shortcuts')
  const activePage = visiblePage(page)
  return (
    <div
      className={
        embedded ? SETTINGS_DIALOG_SHELL_CLASS_NAME : SETTINGS_SHELL_CLASS_NAME
      }
      data-testid="account-settings-shell"
    >
      {!embedded && (
        <div className={cx(SETTINGS_DRAG_CLASS_NAME, 'drag')} aria-hidden />
      )}
      <aside
        className={cx(
          SETTINGS_NAV_CLASS_NAME,
          embedded ? SETTINGS_DIALOG_NAV_CLASS_NAME : undefined
        )}
      >
        {embedded && (
          <div
            className={cx(
              SETTINGS_DIALOG_TITLE_CLASS_NAME,
              'max-[760px]:sr-only'
            )}
          >
            {t('accountPanel.settingsTitle')}
          </div>
        )}
        {!embedded && (
          <Button
            type="button"
            variant="ghost"
            className={SETTINGS_BACK_CLASS_NAME}
            data-testid="account-settings-back"
            onClick={onClose}
          >
            <Icon name="chevron-right" size={13} />
            {t('accountPanel.backToApp')}
          </Button>
        )}
        <nav
          className={SETTINGS_NAV_LIST_CLASS_NAME}
          aria-label={t('accountPanel.navLabel')}
        >
          {NAV_ITEMS.map((item) => (
            <Button
              type="button"
              variant="ghost"
              className={cx(
                SETTINGS_NAV_BUTTON_CLASS_NAME,
                embedded ? SETTINGS_DIALOG_NAV_BUTTON_CLASS_NAME : undefined,
                activePage === item.id
                  ? SETTINGS_NAV_BUTTON_ACTIVE_CLASS_NAME
                  : undefined
              )}
              data-active={activePage === item.id ? 'true' : undefined}
              data-testid={`account-settings-nav-${item.id}`}
              key={item.id}
              onClick={() => onPage(item.id)}
            >
              <SettingsNavIcon
                icon={item.icon}
                lucideIcon={item.lucideIcon}
                size={embedded ? 15 : 14}
              />
              {item.labelKey ? accountPanelNavLabel(item.labelKey, t) : shortcutText('nav')}
            </Button>
          ))}
        </nav>
      </aside>
      <main
        className={cx(
          SETTINGS_MAIN_CLASS_NAME,
          activePage === 'skills' ? '!overflow-hidden !pb-12' : 'min-h-0 !overflow-hidden !pb-0'
        )}
      >
        {activePage === 'prompts' && <PromptsPage />}
        {activePage === 'preferences' && <PreferencesPage />}
        {activePage === 'account' && (
          <AccountPage onLogin={onLogin} onLogout={onLogout} />
        )}
        {activePage === 'models' && <ModelConfigurationPage />}
        {activePage === 'skills' && (
          <Page
            padding="none"
            className={`${SETTINGS_CONTENT_CLASS_NAME} flex h-full min-h-0 flex-col py-[var(--vds-layout-page-padding)]`}
            data-testid="account-settings-skills"
          >
            <PageHeader
              title={t('accountPanel.skills.title')}
              description={t('accountPanel.skills.description')}
            />
            <PageBody className="min-h-0 flex-1">
              <Skills />
            </PageBody>
          </Page>
        )}
        {activePage === 'developer' && <DeveloperPage />}
        {activePage === 'files' && <FileVersionPage />}
        {/* {activePage === 'shortcuts' && <Shortcuts />} */}
        {activePage === 'archives' && <ArchivedProjectsPage />}
        {activePage === 'about' && <AboutPage />}
        {activePage === 'notifications' && <NotificationsPage />}
        {activePage === 'permissions' && <PermissionsPage />}
      </main>
    </div>
  )
}
