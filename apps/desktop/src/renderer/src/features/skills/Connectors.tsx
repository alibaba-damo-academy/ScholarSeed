import { useCallback, useEffect, useId, useRef, useState } from 'react'
import emptyImage from '../../assets/empty_img.webp'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Ellipsis,
  ExternalLink,
  Folders,
  Hammer,
  KeyRound,
  MessageCircle,
  Plus,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  ConnectorError,
  getConnectors,
  getMcpConfiguration,
  saveCustomConnectors,
  updateConnector,
  type ConnectorInfo,
} from '../../api'
import { CustomConnector } from './Editor'
import {
  AUTHORIZATION_URL_INVALID,
  authorizationFailure,
  authorizationMethods,
  authorizationStatus,
  authorizationUrl,
} from './authorization'
import { useApp } from '../../store'
import { IconFont } from '../../components/primitive/Iconfont'
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
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  CopyButton,
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
  EllipsisText,
  EmptyState,
  IconButton,
  Label,
  PasswordInput,
  SearchBox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Tooltip,
  TooltipTrigger,
  useToast,
} from '../../components/ui'

const CONTENT_CLASS = 'mx-auto w-full max-w-[var(--vds-skills-content-width)]'
const SEARCH_EMPTY_CLASS =
  'min-h-[var(--vds-skills-empty-height)] flex-1 w-full content-center [&_.vds-empty-state\\_\\_title]:text-[length:var(--vds-font-body-lv2)] [&_.vds-empty-state\\_\\_title]:text-[var(--vds-text-secondary)]'
const GRID_CLASS =
  'grid grid-cols-1 gap-x-[var(--vds-space-4)] gap-y-[var(--vds-space-3)] md:grid-cols-2 lg:grid-cols-3'
const CARD_CLASS =
  'group relative isolate flex flex-col gap-[var(--vds-space-3)] !rounded-[var(--vds-radius-6)] !bg-transparent hover:!bg-[var(--vds-bg-gray-default-transparent)] py-[var(--vds-space-3)] !shadow-none'
const POLL_INTERVAL = 2000
const COPY_FEEDBACK_DURATION_MS = 3000
const MASKED_CREDENTIAL_PLACEHOLDER = '••••••'
const TOOLS_PAGE_SIZE = 5
const CONNECTOR_DISPLAY_VERSION = '1.0.0'
const HIDDEN_MARKET_CONNECTORS = new Set(['gitlab'])
const DESCRIPTIONS = {
  zotero: 'connectors.descriptions.zotero',
  firecrawl: 'connectors.descriptions.firecrawl',
  github: 'connectors.descriptions.github',
  gitlab: 'connectors.descriptions.gitlab',
  huggingface: 'connectors.descriptions.huggingface',
  notion: 'connectors.descriptions.notion',
  elicit: 'connectors.descriptions.elicit',
} as const
const AUTHORIZATION_STATUS_KEYS = {
  authorized: 'connectors.authorized',
  saved: 'connectors.credentialsUnverified',
  none: 'connectors.noAuthorizationRequired',
  unknown: 'connectors.authorizationUnknown',
} as const
const ERROR_KEYS = {
  connector_storage_unavailable: 'connectors.errors.storage',
  connector_service_unavailable: 'connectors.errors.service',
  connector_method_invalid: 'connectors.errors.method',
  connector_not_installed: 'connectors.errors.notInstalled',
  connector_unknown: 'connectors.errors.unknown',
  connector_oauth_metadata_invalid: 'connectors.errors.authorizationUrl',
  connector_configuration_conflict: 'connectors.custom.conflict',
  connector_custom_invalid: 'connectors.custom.invalid',
  connector_custom_target_changed: 'connectors.custom.targetChanged',
  connector_replacement_failed: 'connectors.errors.replacement',
  connector_credentials_invalid: 'connectors.errors.credentials',
  connector_permission_denied: 'connectors.errors.permission',
  connector_rate_limited: 'connectors.errors.quota',
  connector_timeout: 'connectors.errors.timeout',
  connector_network_unavailable: 'connectors.errors.network',
  connector_response_invalid: 'connectors.errors.responseInvalid',
  connector_network_blocked: 'connectors.errors.networkBlocked',
  connector_tls_failed: 'connectors.errors.tls',
  connector_certificate_untrusted: 'connectors.errors.certificate',
  connector_proxy_failed: 'connectors.errors.proxy',
  connector_oauth_registration_required: 'connectors.errors.registration',
  connector_login_required: 'connectors.errors.loginRequired',
  connector_library_invalid: 'connectors.errors.library',
  connector_authorization_denied: 'connectors.errors.cancelled',
  connector_attempt_expired: 'connectors.errors.expired',
  connector_configuration_failed: 'connectors.errors.configuration',
  connector_local_runtime_required: 'connectors.errors.localRuntime',
  connector_command_not_found: 'connectors.errors.commandMissing',
  connector_dependency_missing: 'connectors.errors.dependencyMissing',
  connector_process_failed: 'connectors.errors.processFailed',
  connector_protocol_failed: 'connectors.errors.protocolFailed',
  connector_protocol_unsupported: 'connectors.errors.protocolUnsupported',
} as const

async function openExternal(url: string): Promise<void> {
  if (window.scholarseed?.openExternal) await window.scholarseed.openExternal(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}

export function Connectors(): React.JSX.Element {
  const { t } = useTranslation('skills')
  const { t: ui } = useTranslation('ui')
  const { toast } = useToast()
  const { state, act } = useApp()
  const [toolPage, setToolPage] = useState(1)
  const [using, setUsing] = useState<string | null>(null)
  const [useProject, setUseProject] = useState('')
  const [useDescription, setUseDescription] = useState('')
  const [items, setItems] = useState<ConnectorInfo[]>([])
  const [scope, setScope] = useState('market')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const credentialId = useId()
  const [error, setError] = useState<{
    code: string
    connectorId?: string
    source: 'read' | 'operation'
  } | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const cardTriggers = useRef(new Map<string, HTMLButtonElement>())
  const previousDetail = useRef<string | null>(null)
  useEffect(() => {
    const previous = previousDetail.current
    previousDetail.current = detail
    if (!detail && previous) cardTriggers.current.get(previous)?.focus()
  }, [detail])
  useEffect(() => setToolPage(1), [detail])
  const [custom, setCustom] = useState<ConnectorInfo | 'new' | null>(null)
  const [authorizing, setAuthorizing] = useState<string | null>(null)
  const [method, setMethod] = useState<'key' | 'oauth'>('key')
  const [key, setKey] = useState('')
  const [credentialPreview, setCredentialPreview] = useState(false)
  const [authError, setAuthError] = useState('')
  const [confirm, setConfirm] = useState<{ id: string; operation: 'remove' | 'revoke' } | null>(
    null
  )
  const flight = useRef(false)
  const generation = useRef(0)
  const latestAuth = useRef(authorizing)
  latestAuth.current = authorizing
  const errorText = (code: string): string => {
    const message = ERROR_KEYS[code as keyof typeof ERROR_KEYS]
    return message ? t(message) : t('connectors.errors.general')
  }
  const describe = (item: ConnectorInfo): string =>
    item.custom
      ? item.description ||
        t('connectors.custom.description', {
          transport: item.transport.toUpperCase(),
        })
      : t(DESCRIPTIONS[item.id as keyof typeof DESCRIPTIONS])
  const apply = (item: ConnectorInfo): void =>
    setItems((current) => current.map((row) => (row.id === item.id ? item : row)))
  const load = useCallback(async (): Promise<void> => {
    if (flight.current) return
    const current = ++generation.current
    setLoading(true)
    try {
      const result = await getConnectors()
      if (current === generation.current) {
        setItems(result)
        setError((previous) => (previous?.source === 'read' ? null : previous))
      }
    } catch (failure) {
      if (current === generation.current)
        setError((previous) =>
          previous?.source === 'operation'
            ? previous
            : {
                source: 'read',
                code:
                  failure instanceof ConnectorError
                    ? failure.code
                    : 'connector_service_unavailable',
              }
        )
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
    return () => {
      generation.current += 1
    }
  }, [load])
  const mutate = async (
    id: string,
    operation: Parameters<typeof updateConnector>[1]
  ): Promise<ConnectorInfo | null> => {
    if (flight.current) return null
    flight.current = true
    generation.current += 1
    setLoading(false)
    setBusy(true)
    if (operation.operation === 'install') setInstalling(id)
    setError(null)
    try {
      const item = items.find((row) => row.id === id)
      if (item?.custom && ['remove', 'toggle', 'retry', 'inspect'].includes(operation.operation)) {
        const view = await getMcpConfiguration()
        if (!view) throw new ConnectorError('connector_service_unavailable')
        await saveCustomConnectors(id, {
          operation:
            operation.operation === 'remove'
              ? 'custom_remove'
              : operation.operation === 'retry' || operation.operation === 'inspect'
                ? 'custom_retry'
                : 'custom_toggle',
          enabled: operation.enabled,
          session_id: state.activeSession ?? undefined,
          expected_revision: view.configuration.revision,
        })
        setItems(await getConnectors())
        if (operation.operation === 'remove') setConfirm(null)
        return null
      }
      const result = await updateConnector(id, operation)
      apply(result)
      return result
    } catch (failure) {
      const code =
        failure instanceof ConnectorError ? failure.code : 'connector_service_unavailable'
      if (authorizing === id) setAuthError(code)
      else setError({ code, connectorId: id, source: 'operation' })
      await getConnectors().then(setItems, () => undefined)
      return null
    } finally {
      flight.current = false
      setBusy(false)
      setInstalling(null)
    }
  }
  const authItem = items.find((item) => item.id === authorizing)
  useEffect(() => {
    if (!detail || authorizing) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      const current = generation.current
      try {
        if (flight.current) return
        const rows = await getConnectors()
        if (!stopped && !flight.current && current === generation.current) {
          setItems(rows)
          setError((previous) => (previous?.source === 'read' ? null : previous))
        }
      } catch (failure) {
        if (!stopped && !flight.current && current === generation.current)
          setError((previous) =>
            previous?.source === 'operation'
              ? previous
              : {
                  source: 'read',
                  connectorId: detail,
                  code:
                    failure instanceof ConnectorError
                      ? failure.code
                      : 'connector_network_unavailable',
                }
          )
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), POLL_INTERVAL)
      }
    }
    timer = setTimeout(() => void poll(), POLL_INTERVAL)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [detail, authorizing])
  const methods = authorizationMethods(authItem?.methods ?? [])
  const credentialsValid = Boolean(key.trim())
  const attempt = authItem?.attempt
  const attemptExpiresAt = attempt?.expires_at
  useEffect(() => {
    if (!authorizing || attemptExpiresAt === undefined) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try {
        const rows = await getConnectors()
        if (stopped || latestAuth.current !== authorizing) return
        const item = rows.find((row) => row.id === authorizing)
        if (flight.current) return
        setItems(rows)
        if (item?.authorization_error) setAuthError(item.authorization_error)
        if (item && !item.attempt && item.authorized && !item.authorization_error) {
          setAuthorizing(null)
          setDetail(item.id)
          setKey('')
          return
        }
        if (Date.now() / 1000 >= attemptExpiresAt) {
          setAuthError('connector_attempt_expired')
          return
        }
      } catch {
        if (!stopped) setAuthError('connector_network_unavailable')
      } finally {
        if (!stopped && latestAuth.current === authorizing)
          timer = setTimeout(() => void poll(), POLL_INTERVAL)
      }
    }
    timer = setTimeout(() => void poll(), POLL_INTERVAL)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [authorizing, attemptExpiresAt])
  const begin = (item: ConnectorInfo): void => {
    setAuthorizing(item.id)
    setMethod(item.method ?? authorizationMethods(item.methods)[0])
    setKey('')
    setCredentialPreview(item.authorized && item.method === 'key')
    setAuthError('')
  }
  const closeAuth = async (): Promise<void> => {
    if (busy || !authorizing) return
    if (authItem?.attempt && !(await mutate(authorizing, { operation: 'cancel' }))) return
    setAuthorizing(null)
    setKey('')
  }
  const authorize = async (): Promise<void> => {
    if (!authItem) return
    setAuthError('')
    if (method === 'oauth') {
      const result = await mutate(authItem.id, { operation: 'login' })
      if (result?.attempt) {
        await launchAuthorization(result.attempt.authorization_url)
      }
    } else {
      if (!credentialsValid) {
        setAuthError('connector_credentials_invalid')
        return
      }
      const result = await mutate(authItem.id, {
        operation: 'key',
        access_token: key,
      })
      if (result) {
        setAuthorizing(null)
        setDetail(result.id)
        setKey('')
      }
    }
  }
  const launchAuthorization = async (url: string): Promise<void> => {
    try {
      await openExternal(authorizationUrl(url))
    } catch (failure) {
      setAuthError(
        failure instanceof Error && failure.message === AUTHORIZATION_URL_INVALID
          ? AUTHORIZATION_URL_INVALID
          : 'connector_network_unavailable'
      )
    }
  }
  const install = async (item: ConnectorInfo): Promise<void> => {
    const result = await mutate(item.id, { operation: 'install' })
    if (!result) return
    toast({ tone: 'success', title: t('connectors.installSuccess', { name: result.name }) })
    setDetail(result.id)
    if (!result.authorized) begin(result)
  }
  const controls = (
    item: ConnectorInfo,
    compact = false,
    part: 'all' | 'activation' | 'action' = 'all'
  ): React.JSX.Element => (
    <div className="pointer-events-auto relative z-[var(--vds-z-local-control)] flex shrink-0 items-center gap-[var(--vds-space-2)]">
      {compact ? (
        item.installed ? (
          <Tooltip content={t('marketplace.installedShort')}>
            <span
              role="img"
              aria-label={t('marketplace.installedShort')}
              tabIndex={0}
              className="inline-flex size-[var(--vds-control-height-xs)] items-center justify-center text-[var(--vds-brand-text-primary)]"
            >
              <IconFont
                type="line-operation-select"
                className="inline-flex size-[var(--vds-icon-6)] items-center justify-center !text-[length:var(--vds-icon-6)] leading-none"
              />
            </span>
          </Tooltip>
        ) : (
          <IconButton
            size="xs"
            variant="tertiary"
            label={t(installing === item.id ? 'upload.installing' : 'connectors.install')}
            icon={<IconFont type="line-operation-add" />}
            loading={installing === item.id}
            disabled={busy}
            onClick={() => void install(item)}
            data-testid={`connector-install-${item.id}`}
          />
        )
      ) : !item.installed && part !== 'activation' ? (
        <Button size="md" variant="primary" disabled={busy} onClick={() => void install(item)}>
          {t('connectors.install')}
        </Button>
      ) : (
        <>
          {part !== 'activation' &&
            (item.custom
              ? !item.authorized && (
                  <Button
                    size="md"
                    variant="primary"
                    disabled={busy}
                    onClick={() => (item.methods.includes('oauth') ? begin(item) : setCustom(item))}
                  >
                    {t(
                      item.methods.includes('oauth')
                        ? 'connectors.authorize'
                        : 'connectors.custom.edit'
                    )}
                  </Button>
                )
              : !item.authorized && (
                  <Button size="md" variant="primary" disabled={busy} onClick={() => begin(item)}>
                    {t(item.reauthorization ? 'connectors.reauthorize' : 'connectors.goAuthorize')}
                  </Button>
                ))}
          {part !== 'action' && (
            <Tooltip content={t('connectors.enableAfterAuthorization')} disabled={item.authorized}>
              <TooltipTrigger asChild>
                <span
                  className="inline-flex"
                  tabIndex={item.authorized ? undefined : 0}
                  data-testid={`connector-enable-hint-${item.id}`}
                >
                  <Switch
                    checked={item.authorized && item.enabled}
                    disabled={busy || !item.authorized}
                    aria-label={t('connectors.enable', { name: item.name })}
                    onCheckedChange={(enabled) =>
                      void mutate(item.id, { operation: 'toggle', enabled })
                    }
                  />
                </span>
              </TooltipTrigger>
            </Tooltip>
          )}
        </>
      )}
    </div>
  )
  const selected = items.find((item) => item.id === detail)
  const failureAuthorization = selected ? authorizationFailure(selected) : null
  const useItem = items.find((item) => item.id === using)
  const toolPageCount = Math.max(1, Math.ceil((selected?.tools?.length ?? 0) / TOOLS_PAGE_SIZE))
  const currentToolPage = Math.min(toolPage, toolPageCount)
  const emptyMine = scope === 'mine' && !query.trim()
  const visible = items.filter(
    (item) =>
      (scope === 'market'
        ? !item.custom && !HIDDEN_MARKET_CONNECTORS.has(item.id)
        : item.installed) &&
      `${item.name}\n${describe(item)}\n${item.source_url}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase())
  )
  const actions = (
    <>
      <SearchBox
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('connectors.search')}
        aria-label={t('connectors.search')}
        containerClassName="w-[var(--vds-skills-search-width)]"
      />
      <Button variant="primary" onClick={() => setCustom('new')} disabled={busy}>
        <Plus className="size-[var(--vds-icon-6)]" aria-hidden="true" />
        {t('connectors.custom.add')}
      </Button>
    </>
  )
  return (
    <section
      className="relative flex h-full min-h-0 w-full min-w-0 flex-col"
      data-testid="connectors-page"
    >
      <Dialog
        open={Boolean(selected) && !authorizing}
        onOpenChange={(open) => {
          if (!open) setDetail(null)
        }}
      >
        <DialogPortal>
          <DialogContent
            className="!w-[var(--vds-skills-detail-viewport-width)] !max-w-none max-h-[var(--vds-skills-connector-detail-max-height)] !flex flex-col !gap-[var(--vds-space-3)] !px-[var(--vds-space-5)] !pt-[var(--vds-space-3)] !pb-[var(--vds-space-5)] overflow-hidden font-[var(--vds-fw-regular)] [&_*]:!font-[var(--vds-fw-regular)]"
            data-testid="connector-detail"
            overlayProps={{ onClick: () => setDetail(null) }}
            aria-label={selected?.name}
            closeButtonClassName="!top-[var(--vds-space-3)] !right-[var(--vds-space-2)] !p-0"
          >
            {selected && (
              <>
                <DialogHeader className="shrink-0 !gap-[var(--vds-space-1)] !text-left">
                  <div className="flex min-w-0 items-center justify-between gap-[var(--vds-space-4)] pr-[calc(var(--vds-control-height-md)+var(--vds-space-1)+var(--vds-space-2)-var(--vds-space-5))]">
                    <DialogTitle className="flex min-h-[var(--vds-control-height-md)] min-w-0 flex-1 items-center overflow-hidden !text-[length:var(--vds-font-subhead)] !leading-[var(--vds-lh-subhead)]">
                      <EllipsisText wrapperClassName="min-w-0 flex-1" tooltipPortalled tabIndex={0}>
                        {selected.name}
                      </EllipsisText>
                    </DialogTitle>
                    {selected.installed && (
                      <div
                        className="flex shrink-0 items-center gap-[var(--vds-space-2)]"
                        data-testid="connector-detail-preference"
                      >
                        <span className="text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-secondary)]">
                          {t('taskPreference')}
                        </span>
                        {controls(selected, false, 'activation')}
                      </div>
                    )}
                  </div>
                  <DialogDescription className="flex flex-wrap items-center gap-[var(--vds-space-2)] !text-[length:var(--vds-font-body-lv1)] !leading-[var(--vds-lh-body-lv1)] !font-[var(--vds-fw-regular)] !text-[var(--vds-text-tertiary)]">
                    <span>
                      {URL.canParse(selected.source_url)
                        ? new URL(selected.source_url).hostname
                        : selected.signature || selected.name}
                    </span>
                    <span
                      aria-hidden="true"
                      className="h-[var(--vds-space-3)] w-[var(--vds-border-width-1)] bg-[var(--vds-divider-default)]"
                    />
                    <span className="inline-flex items-center gap-[var(--vds-space-1)]">
                      <Folders
                        aria-hidden="true"
                        className="size-[var(--vds-icon-7)] shrink-0"
                        data-testid="detail-version-icon"
                      />
                      {t('version', { version: CONNECTOR_DISPLAY_VERSION })}
                    </span>
                  </DialogDescription>
                </DialogHeader>
                <div className="grid min-h-0 gap-[var(--vds-space-3)] overflow-y-auto text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] [overflow-wrap:anywhere]">
                  <p className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
                    {describe(selected)}
                  </p>
                  <dl className="grid gap-[var(--vds-space-3)]">
                    {[
                      [t('connectors.protocolLabel'), selected.transport.toUpperCase()],
                      [
                        t('connectors.methodsLabel'),
                        selected.methods
                          .map((value) =>
                            t(value === 'key' ? 'connectors.apiKey' : 'connectors.oauth')
                          )
                          .join(' / ') ||
                          t(AUTHORIZATION_STATUS_KEYS[authorizationStatus(selected)]),
                      ],
                      [
                        t('connectors.sourceLabel'),
                        selected.url || t('connectors.localProcess'),
                        selected.url,
                      ],
                    ].map(([label, value, copyValue]) => (
                      <div key={label} className="grid gap-[var(--vds-space-1)]">
                        <dt className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-placeholder)]">
                          {label}
                        </dt>
                        <dd className="m-0 flex min-w-0 items-start gap-[var(--vds-space-1)]">
                          <span className="min-w-0">{value}</span>
                          {copyValue && (
                            <CopyButton
                              iconOnly
                              size="xs"
                              variant="ghost"
                              icon={<Copy className="size-[var(--vds-icon-7)]" />}
                              value={copyValue}
                              copiedIcon={<Check className="size-[var(--vds-icon-7)]" />}
                              feedbackDuration={COPY_FEEDBACK_DURATION_MS}
                              idleLabel={t('connectors.copy')}
                              className="shrink-0"
                            />
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {selected.authorized && (
                    <>
                      <p data-testid="connector-authorization-status">
                        {t(AUTHORIZATION_STATUS_KEYS[authorizationStatus(selected)])}
                        {selected.method &&
                          ` · ${t(selected.method === 'key' ? 'connectors.apiKey' : 'connectors.oauth')}`}
                      </p>
                      {(!selected.custom || selected.method === 'oauth') && (
                        <div className="grid gap-[var(--vds-space-2)]">
                          {selected.account_context && <p>{selected.account_context}</p>}
                          {selected.scopes && (
                            <p>{t('connectors.scopes', { scopes: selected.scopes })}</p>
                          )}
                          {selected.expires_at && (
                            <div>
                              <p>
                                {t('connectors.expires', {
                                  date: new Date(selected.expires_at * 1000).toLocaleString(),
                                })}
                              </p>
                              {selected.method === 'oauth' && <p>{t('connectors.renewalHint')}</p>}
                            </div>
                          )}
                        </div>
                      )}
                      <section
                        className="grid min-w-0 gap-[var(--vds-space-2)]"
                        data-testid="connector-tools"
                      >
                        <div className="flex shrink-0 flex-wrap items-center justify-between gap-[var(--vds-space-2)]">
                          <h3 className="text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)]">
                            {selected.tools === null
                              ? t('connectors.toolsUnknown')
                              : t('connectors.tools', { count: selected.tools.length })}
                          </h3>
                          <div className="flex items-center gap-[var(--vds-space-1)]">
                            <IconButton
                              variant="ghostIcon"
                              size="xs"
                              icon={<ChevronLeft strokeWidth={1.5} />}
                              className="!size-[var(--vds-icon-8)] !min-w-0 !border-0 !p-0 [&_svg]:!size-[var(--vds-icon-8)]"
                              label={ui('pagination.previous')}
                              disabled={busy || currentToolPage === 1}
                              onClick={() => setToolPage(currentToolPage - 1)}
                            />
                            <IconButton
                              variant="ghostIcon"
                              size="xs"
                              icon={<ChevronRight strokeWidth={1.5} />}
                              className="!size-[var(--vds-icon-8)] !min-w-0 !border-0 !p-0 [&_svg]:!size-[var(--vds-icon-8)]"
                              label={ui('pagination.next')}
                              disabled={busy || currentToolPage === toolPageCount}
                              onClick={() => setToolPage(currentToolPage + 1)}
                            />
                          </div>
                        </div>
                        <div
                          className="grid min-w-0 grid-cols-1 gap-[var(--vds-space-2)]"
                          data-testid="connector-tools-content"
                        >
                          {selected.error && (
                            <Alert tone="error" description={t('connectors.toolsFailed')} />
                          )}
                          {selected.tools === null ? (
                            <p>
                              {t(
                                busy
                                  ? 'connectors.toolsLoading'
                                  : selected.state === 'disabled'
                                    ? 'connectors.toolsDisabled'
                                    : 'connectors.toolsPending'
                              )}
                            </p>
                          ) : selected.tools.length === 0 ? (
                            <p>{t('connectors.noTools')}</p>
                          ) : (
                            selected.tools
                              .slice(
                                (currentToolPage - 1) * TOOLS_PAGE_SIZE,
                                currentToolPage * TOOLS_PAGE_SIZE
                              )
                              .map((tool) => (
                                <Tooltip
                                  key={tool.name}
                                  className="!flex !min-w-0 !w-full !max-w-full"
                                  content={
                                    <span className="whitespace-pre-wrap break-words">
                                      {tool.name}
                                      {'\n'}
                                      {tool.description || t('connectors.noDescription')}
                                    </span>
                                  }
                                >
                                  <div
                                    tabIndex={0}
                                    className="min-w-0 w-full max-w-full truncate rounded-[var(--vds-radius-4)] bg-[var(--vds-other-overlay-1)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]"
                                    data-testid="connector-tool"
                                  >
                                    {tool.name}: {tool.description || t('connectors.noDescription')}
                                  </div>
                                </Tooltip>
                              ))
                          )}
                        </div>
                      </section>
                      <div className="flex flex-wrap gap-[var(--vds-space-2)]">
                        {selected.error && (
                          <Button
                            variant="outline"
                            disabled={busy}
                            loading={busy}
                            onClick={() => void mutate(selected.id, { operation: 'retry' })}
                          >
                            {t('connectors.retry')}
                          </Button>
                        )}
                        {selected.custom && selected.methods.includes('oauth') && (
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() => setCustom(selected)}
                          >
                            {t('connectors.custom.edit')}
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                  {selected.error && (
                    <Alert
                      tone="error"
                      description={
                        failureAuthorization === 'authorized'
                          ? `${t('connectors.authorizationComplete')} ${errorText(selected.error)}`
                          : failureAuthorization === 'saved'
                            ? `${t('connectors.credentialsSaved')} ${errorText(selected.error)}`
                            : errorText(selected.error)
                      }
                    />
                  )}
                  {!selected.authorized && selected.revocation_scope && (
                    <Alert
                      tone="info"
                      description={t(
                        selected.revocation_scope === 'local'
                          ? 'connectors.revokedLocal'
                          : 'connectors.revokedRemote'
                      )}
                    />
                  )}
                  {error && error.connectorId === selected.id && (
                    <Alert tone="error" description={errorText(error.code)} />
                  )}
                </div>
                <DialogFooter className="shrink-0">
                  {!selected.authorized && (
                    <Button variant="outline" onClick={() => setDetail(null)}>
                      {t('connectors.cancel')}
                    </Button>
                  )}
                  {!selected.authorized && controls(selected, false, 'action')}
                  {!selected.authorized && selected.custom && selected.error && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      loading={busy}
                      onClick={() => void mutate(selected.id, { operation: 'retry' })}
                    >
                      {t('connectors.retry')}
                    </Button>
                  )}
                  {selected.authorized &&
                    (!selected.custom || selected.methods.includes('oauth')) && (
                      <Button
                        variant="danger"
                        disabled={busy}
                        onClick={() => setConfirm({ id: selected.id, operation: 'revoke' })}
                      >
                        {t('connectors.revoke')}
                      </Button>
                    )}
                  {selected.authorized && (
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() =>
                        selected.custom && !selected.methods.includes('oauth')
                          ? setCustom(selected)
                          : begin(selected)
                      }
                    >
                      {t(
                        selected.custom && !selected.methods.includes('oauth')
                          ? 'connectors.custom.edit'
                          : 'connectors.manage'
                      )}
                    </Button>
                  )}
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </DialogPortal>
      </Dialog>
      {
        <>
          <div
            className={`${CONTENT_CLASS} mb-[var(--vds-space-4)] flex shrink-0 flex-wrap items-center justify-between gap-[var(--vds-space-2)]`}
          >
            <Tabs value={scope} onValueChange={(value) => setScope(String(value))}>
              <TabsList aria-label={t('connectors.scope')}>
                <TabsTrigger value="market">{t('connectors.market')}</TabsTrigger>
                <TabsTrigger value="mine">{t('connectors.mine')}</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="ml-auto flex items-center gap-[var(--vds-space-2)]">{actions}</div>
          </div>
          {error && (
            <Alert
              tone="error"
              description={errorText(error.code)}
              action={
                error.source === 'read' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loading || busy}
                    onClick={() => void load()}
                  >
                    {t('retry')}
                  </Button>
                ) : undefined
              }
            />
          )}
          <div
            data-testid="connectors-list"
            className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          >
            <div
              className={`${CONTENT_CLASS} ${loading ? 'flex flex-1 items-center justify-center' : visible.length === 0 && !emptyMine ? 'flex flex-1 flex-col' : ''}`}
            >
              {loading ? (
                <div
                  role="status"
                  data-testid="connectors-loading"
                  className="flex flex-col items-center gap-[var(--vds-space-3)] font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]"
                >
                  <Spinner size="md" role="presentation" aria-hidden="true" />
                  <span>{t('connectors.loading')}</span>
                </div>
              ) : visible.length === 0 ? (
                <EmptyState
                  data-testid="connectors-empty"
                  variant={emptyMine ? 'compact' : 'default'}
                  className={
                    emptyMine
                      ? 'min-h-[var(--vds-skills-empty-height)] w-full rounded-[var(--vds-radius-6)] bg-[var(--vds-surface-hover)] [&>[aria-hidden]]:bg-[var(--vds-surface-active)]'
                      : SEARCH_EMPTY_CLASS
                  }
                  image={emptyMine ? undefined : { src: emptyImage, alt: '' }}
                  icon={emptyMine ? <Hammer strokeWidth={1.45} /> : undefined}
                  title={
                    emptyMine ? (
                      <span className="text-[var(--vds-text-primary)]">
                        {t('connectors.mineEmpty')}
                      </span>
                    ) : (
                      t('connectors.empty')
                    )
                  }
                  action={
                    emptyMine ? (
                      <Button variant="outline" onClick={() => setCustom('new')}>
                        <Plus className="size-[var(--vds-icon-6)]" aria-hidden="true" />
                        {t('connectors.custom.add')}
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <div
                  className={
                    scope === 'mine'
                      ? 'grid grid-cols-1 gap-[var(--vds-space-4)] md:grid-cols-2'
                      : GRID_CLASS
                  }
                >
                  {visible.map((item) => (
                    <Card
                      key={item.id}
                      padding="none"
                      data-testid={`connector-${item.id}`}
                      className={CARD_CLASS}
                    >
                      <Tooltip content={describe(item)} className="!absolute inset-0 !w-full">
                        <Button
                          unstyled
                          ref={(element) => {
                            if (element) cardTriggers.current.set(item.id, element)
                            else cardTriggers.current.delete(item.id)
                          }}
                          className="absolute inset-0 cursor-pointer rounded-[var(--vds-radius-6)] border-0 bg-transparent p-0 focus-visible:shadow-[var(--vds-focus-brand)]"
                          aria-label={t('connectors.open', { name: item.name })}
                          onClick={() => setDetail(item.id)}
                        />
                      </Tooltip>
                      <CardHeader className="pointer-events-none min-h-0 flex-1 !mb-0 !gap-[var(--vds-space-2)] px-[var(--vds-space-4)]">
                        <div className="flex min-h-[var(--vds-control-height-sm)] min-w-0 items-center gap-[var(--vds-space-2)]">
                          <CardTitle className="flex-1 truncate !text-[length:var(--vds-font-body-lv2)] !leading-[var(--vds-lh-body-lv2)]">
                            {item.name}
                          </CardTitle>
                          {scope === 'mine' && (
                            <div className="pointer-events-auto relative z-[var(--vds-z-local-control)] flex shrink-0 items-center">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <IconButton
                                    size="xs"
                                    variant="ghost"
                                    label={t('more', { name: item.name })}
                                    icon={<Ellipsis className="size-[var(--vds-icon-6)]" />}
                                    disabled={busy}
                                    className="hover:!bg-[var(--vds-bg-gray-active)]"
                                    data-testid={`connector-more-${item.id}`}
                                  />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem
                                    disabled={!item.authorized || busy}
                                    onSelect={() => {
                                      setUseProject(
                                        state.homeSelectedProjectId ?? state.projects[0]?.id ?? ''
                                      )
                                      setUseDescription(
                                        t('connectors.usePlaceholder', { name: item.name })
                                      )
                                      setUsing(item.id)
                                    }}
                                  >
                                    <MessageCircle />
                                    {t('connectors.use')}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    destructive
                                    onSelect={() =>
                                      setConfirm({ id: item.id, operation: 'remove' })
                                    }
                                  >
                                    <Trash2 />
                                    {t('connectors.remove')}
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          )}
                          {scope === 'mine' ? (
                            <div className="flex shrink-0 items-center">
                              <div className="flex items-center">
                                {item.authorized ? (
                                  controls(item, false, 'activation')
                                ) : (
                                  <div className="pointer-events-auto relative z-[var(--vds-z-local-control)] flex items-center">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={busy}
                                      onClick={() =>
                                        item.custom && !item.methods.includes('oauth')
                                          ? setCustom(item)
                                          : begin(item)
                                      }
                                    >
                                      {t(
                                        item.authorized
                                          ? item.custom && !item.methods.includes('oauth')
                                            ? 'connectors.custom.edit'
                                            : 'connectors.manage'
                                          : item.reauthorization
                                            ? 'connectors.reauthorize'
                                            : 'connectors.authorize'
                                      )}
                                    </Button>
                                  </div>
                                )}
                              </div>
                            </div>
                          ) : (
                            controls(item, true, 'action')
                          )}
                        </div>
                        <CardDescription className="line-clamp-2 font-[var(--vds-fw-regular)] !text-[var(--vds-text-tertiary)]">
                          {describe(item)}
                        </CardDescription>
                      </CardHeader>
                      <CardFooter className="pointer-events-none !mt-0 mx-[var(--vds-space-4)] !flex-nowrap !justify-start gap-[var(--vds-space-1)] border-t border-[var(--vds-divider-default)] pt-[var(--vds-space-3)]">
                        <Badge
                          size="sm"
                          variant="secondary"
                          className="!rounded-[var(--vds-radius-2)] !bg-[var(--vds-bg-gray-default-transparent)] !text-[length:var(--vds-font-caption)]"
                        >
                          {item.authorized || !item.methods.length
                            ? t(AUTHORIZATION_STATUS_KEYS[authorizationStatus(item)])
                            : item.methods
                                .map((value) =>
                                  t(value === 'key' ? 'connectors.apiKey' : 'connectors.oauth')
                                )
                                .join(' / ')}
                        </Badge>
                      </CardFooter>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      }
      {custom && (
        <CustomConnector
          key={custom === 'new' ? 'new' : custom.id}
          item={custom === 'new' ? null : custom}
          sessionId={state.activeSession ?? undefined}
          onClose={() => setCustom(null)}
          onSaved={async () => {
            setItems(await getConnectors())
            setScope('mine')
            setQuery('')
          }}
        />
      )}
      <Dialog
        open={Boolean(useItem)}
        onOpenChange={(open) => {
          if (!open) setUsing(null)
        }}
      >
        <DialogPortal>
          <DialogContent headerLayout="aligned" data-testid="connector-use-dialog">
            <DialogHeader>
              <DialogTitle>{t('connectors.useTitle', { name: useItem?.name ?? '' })}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-[var(--vds-space-4)]">
              <div className="grid gap-[var(--vds-space-2)]">
                <Label htmlFor="connector-use-project">{t('try.project')}</Label>
                <Select value={useProject} onValueChange={setUseProject}>
                  <SelectTrigger id="connector-use-project">
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
              <div className="grid gap-[var(--vds-space-2)]">
                <Label htmlFor="connector-use-description" required>
                  {t('try.description')}
                </Label>
                <Textarea
                  id="connector-use-description"
                  required
                  rows={5}
                  value={useDescription}
                  onChange={(event) => setUseDescription(event.target.value)}
                />
              </div>
              <DialogDescription>
                {t(state.projects.length ? 'connectors.useHint' : 'try.noProjects')}
              </DialogDescription>
              {error && <Alert tone="error" description={errorText(error.code)} />}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setUsing(null)}>
                {t('connectors.cancel')}
              </Button>
              <Button
                disabled={
                  busy ||
                  !useItem?.authorized ||
                  !useDescription.trim() ||
                  !state.projects.some((project) => project.id === useProject)
                }
                onClick={() => {
                  if (
                    !useItem?.authorized ||
                    !state.projects.some((project) => project.id === useProject) ||
                    !useDescription.trim()
                  )
                    return
                  if (!useItem.enabled) {
                    void mutate(useItem.id, { operation: 'toggle', enabled: true })
                    return
                  }
                  act.startDraft({
                    submit: true,
                    projectId: useProject,
                    composerText: useDescription,
                  })
                  setUsing(null)
                }}
              >
                {t(useItem?.enabled ? 'try.start' : 'connectors.enableToUse')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </DialogPortal>
      </Dialog>
      <Dialog
        open={Boolean(authItem)}
        onOpenChange={(open) => {
          if (!open) void closeAuth()
        }}
      >
        <DialogPortal>
          <DialogContent
            className={`!flex max-h-[calc(100dvh-var(--vds-space-6)-var(--vds-space-6))] flex-col overflow-hidden font-[var(--vds-fw-regular)] [&_*]:!font-[var(--vds-fw-regular)] ${selected ? '!z-[var(--vds-z-dialog-nested)]' : ''}`}
            overlayClassName={selected ? '!z-[var(--vds-z-dialog-nested-overlay)]' : undefined}
            headerLayout="aligned"
          >
            <DialogHeader className="shrink-0">
              <DialogTitle>
                {t(authItem?.authorized ? 'connectors.replaceTitle' : 'connectors.authTitle', {
                  name: authItem?.name ?? '',
                })}
              </DialogTitle>
            </DialogHeader>
            <div className="grid min-h-0 gap-[var(--vds-space-3)] overflow-y-auto">
              <Tabs
                value={method}
                disabled={busy || Boolean(attempt)}
                onValueChange={(value) => {
                  setMethod(value as 'key' | 'oauth')
                  setAuthError('')
                }}
              >
                <TabsList
                  hidden={methods.length < 2}
                  className={methods.length > 1 ? 'flex w-full' : 'hidden'}
                  aria-label={t('connectors.authorizationMethod')}
                >
                  {methods.map((value) => (
                    <TabsTrigger key={value} value={value} className="flex-1">
                      {t(value === 'key' ? 'connectors.apiKey' : 'connectors.oauth')}
                    </TabsTrigger>
                  ))}
                </TabsList>
                <TabsContent value={method} className="grid gap-[var(--vds-space-3)]">
                  {method === 'key' ? (
                    <>
                      <div className="flex flex-wrap items-center gap-[var(--vds-space-2)]">
                        <Label
                          required
                          htmlFor={credentialId}
                          className="text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)]"
                        >
                          {t('connectors.apiKey')}
                        </Label>
                        {authItem?.help_url && (
                          <Button
                            variant="link"
                            className="group !gap-0 !no-underline !text-[length:var(--vds-font-body-lv1)] !leading-[var(--vds-lh-body-lv1)]"
                            onClick={() => void openExternal(authItem.help_url)}
                          >
                            <span className="inline-flex items-center gap-[var(--vds-space-half)] border-b border-transparent group-hover:border-current group-focus-visible:border-current">
                              {t('connectors.getKey')}
                              <ExternalLink
                                className="!size-[var(--vds-icon-6)]"
                                aria-hidden="true"
                              />
                            </span>
                          </Button>
                        )}
                      </div>
                      <div className="relative min-w-0">
                        <PasswordInput
                          id={credentialId}
                          aria-label={t('connectors.apiKey')}
                          value={key}
                          placeholder={
                            credentialPreview
                              ? MASKED_CREDENTIAL_PLACEHOLDER
                              : t('connectors.keyPlaceholder')
                          }
                          className="!pr-[calc(var(--vds-space-8)+var(--vds-space-8))]"
                          toggleClassName="!right-[var(--vds-space-8)]"
                          disabled={busy}
                          required
                          autoComplete="off"
                          onChange={(event) => {
                            setKey(event.target.value)
                          }}
                        />
                        {(key || credentialPreview) && (
                          <IconButton
                            variant="ghost"
                            size="xs"
                            icon={
                              <IconFont
                                type="line-operation-close"
                                className="!text-[length:var(--vds-icon-6)]"
                              />
                            }
                            label={t('connectors.clearKey')}
                            disabled={busy}
                            className="absolute right-[var(--vds-space-2)] top-1/2 -translate-y-1/2"
                            onClick={() => {
                              setKey('')
                              setCredentialPreview(false)
                            }}
                          />
                        )}
                      </div>
                      {authItem && ['gitlab', 'notion', 'zotero'].includes(authItem.id) && (
                        <Alert
                          tone="info"
                          description={t(
                            authItem.id === 'gitlab'
                              ? 'connectors.gitlabRequirement'
                              : authItem.id === 'notion'
                                ? 'connectors.notionRequirement'
                                : 'connectors.zoteroRequirement'
                          )}
                        />
                      )}
                    </>
                  ) : (
                    <div
                      data-testid="connector-oauth-panel"
                      className="flex flex-col items-center justify-center gap-[var(--vds-space-3)] rounded-[var(--vds-radius-4)] bg-[var(--vds-connector-oauth-background)] px-[var(--vds-space-4)] py-[var(--vds-space-8)] text-center"
                    >
                      <span className="inline-flex size-[var(--vds-space-8)] items-center justify-center rounded-[var(--vds-radius-4)] bg-[var(--vds-bg-gray-default-transparent)] text-[var(--vds-icon-outline-default)]">
                        <KeyRound className="size-[var(--vds-icon-8)]" aria-hidden="true" />
                      </span>
                      <p>{t('connectors.oauthDescription')}</p>
                    </div>
                  )}
                </TabsContent>
              </Tabs>
              {authError && <Alert tone="error" description={errorText(authError)} />}
            </div>
            <DialogFooter className="shrink-0">
              <Button variant="outline" disabled={busy} onClick={() => void closeAuth()}>
                {t('connectors.cancel')}
              </Button>
              {(!attempt || method === 'oauth') && (
                <Button
                  loading={busy}
                  disabled={busy || (method === 'key' && !credentialsValid)}
                  onClick={() =>
                    void (attempt && Date.now() / 1000 < attempt.expires_at
                      ? launchAuthorization(attempt.authorization_url)
                      : authorize())
                  }
                >
                  {t(
                    busy
                      ? 'connectors.verifying'
                      : method === 'key'
                        ? 'connectors.connect'
                        : 'connectors.oauthStart'
                  )}
                  {method === 'oauth' && (
                    <ExternalLink className="size-[var(--vds-icon-7)]" aria-hidden="true" />
                  )}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </DialogPortal>
      </Dialog>
      <AlertDialog
        open={Boolean(confirm)}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null)
        }}
      >
        <AlertDialogPortal>
          <AlertDialogContent
            className={selected ? '!z-[var(--vds-z-dialog-nested)]' : undefined}
            overlayClassName={selected ? '!z-[var(--vds-z-dialog-nested-overlay)]' : undefined}
          >
            <AlertDialogTitle className="flex items-center gap-[var(--vds-space-2)]">
              {confirm?.operation === 'remove' && (
                <IconFont
                  type="fill-status-warning"
                  className="inline-flex size-[var(--vds-icon-8)] shrink-0 items-center justify-center !text-[length:var(--vds-icon-8)] text-[var(--vds-warning-text-primary)]"
                />
              )}
              {t(
                confirm?.operation === 'revoke'
                  ? 'connectors.revokeTitle'
                  : 'connectors.removeTitle',
                { name: items.find((item) => item.id === confirm?.id)?.name ?? '' }
              )}
            </AlertDialogTitle>
            <AlertDialogDescription
              className={confirm?.operation === 'remove' ? 'pl-[var(--vds-space-6)]' : undefined}
            >
              {t(
                confirm?.operation === 'revoke'
                  ? 'connectors.revokeDescription'
                  : 'connectors.removeDescription'
              )}
            </AlertDialogDescription>
            {error && error.connectorId === confirm?.id && (
              <Alert tone="error" description={errorText(error.code)} />
            )}
            <AlertDialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>
                {t('connectors.cancel')}
              </Button>
              <Button
                variant={confirm?.operation === 'remove' ? 'danger' : 'primary'}
                loading={busy}
                disabled={busy}
                onClick={() => {
                  if (confirm)
                    void mutate(confirm.id, { operation: confirm.operation }).then((result) => {
                      if (result) setConfirm(null)
                    })
                }}
              >
                {confirm?.operation === 'remove' ? ui('delete') : t('connectors.confirm')}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogPortal>
      </AlertDialog>
    </section>
  )
}
