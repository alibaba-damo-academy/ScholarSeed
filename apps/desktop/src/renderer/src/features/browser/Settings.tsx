import { BROWSER_ERROR_KEYS, VAULT_ERROR_KEYS, VAULT_STATE_KEYS, DATA_TYPE_KEYS } from './messages'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BROWSER_ERROR } from '../../../../browser'
import type {
  BrowserCommand,
  BrowserDataRequest,
  BrowserDataType,
  BrowserDownloadRequest,
  BrowserDownloadSettings,
  BrowserErrorCode,
  BrowserPolicyAction,
  BrowserPolicyDecision,
  BrowserPolicyRequest,
  BrowserPolicySnapshot,
  BrowserSnapshot,
} from '../../../../browser'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPortal,
  AlertDialogTitle,
  Button,
  Card,
  CardDescription,
  CardTitle,
  Checkbox,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '../../components/ui'
import type { BrowserSettingsSection } from '../../../../navigation'
import { History, type HistoryActionLease } from './History'
import { SettingsPage } from '../../components/business/Settings'
import { VAULT_ERROR, type VaultError, type VaultIntent, type VaultStatus } from '../../../../vault'

const EMPTY_AUTOMATION: BrowserSnapshot['automation'] = { enabled: false, port: null }
const LOOPBACK_HOST = '127.0.0.1'
const HOUR_MILLISECONDS = 60 * 60 * 1000
const DAY_MILLISECONDS = 24 * HOUR_MILLISECONDS
type ClearChoice = 'hour' | 'day' | 'all-history' | 'site' | 'selected' | 'all-data'
const DATA_TYPE_CHOICES: BrowserDataType[] = ['history', 'cookies', 'storage', 'cache']
const INITIAL_VAULT_STATUS: VaultStatus = { state: 'unavailable', generation: 0 }

function VaultSettings(): React.JSX.Element {
  const { t } = useTranslation('browser')
  const [status, setStatus] = useState(INITIAL_VAULT_STATUS)
  const [error, setError] = useState<VaultError | null>(null)
  const [count, setCount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const bridge = window.scholarseed.vault
    if (!bridge) return
    let active = true
    let revision = 0
    const update = (value: VaultStatus) => {
      if (!active) return
      setStatus(value)
      setCount(null)
      setError(value.error ?? null)
      if (value.state === 'unlocked')
        void bridge
          .listMetadata()
          .then((metadata) => {
            if (
              active &&
              revision === value.generation &&
              metadata?.generation === value.generation
            )
              setCount(metadata.count)
          })
          .catch(() => undefined)
      revision = value.generation
    }
    const unsubscribe = bridge.subscribeStatus(update)
    const initial = revision
    void bridge
      .status()
      .then((value) => {
        if (revision === initial) update(value)
      })
      .catch(() => {
        if (active) setError(VAULT_ERROR.unavailable)
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])
  const action = async (intent: VaultIntent | 'lock') => {
    const bridge = window.scholarseed.vault
    if (!bridge || busy) return
    setBusy(true)
    setError(null)
    try {
      const reply = intent === 'lock' ? await bridge.lock() : await bridge.open({ intent })
      if (!reply.ok) setError(reply.error)
    } catch {
      setError(VAULT_ERROR.unavailable)
    } finally {
      setBusy(false)
    }
  }
  const unavailable =
    status.state === 'unavailable' || status.state === 'unlocking' || status.state === 'locking'
  return (
    <Card className="grid gap-[var(--vds-space-4)]" data-testid="browser-settings-vault">
      <div>
        <CardTitle>{t('vault.title')}</CardTitle>
        <CardDescription>{t('vault.description')}</CardDescription>
      </div>
      <p role="status" className="text-[var(--vds-text-secondary)]">
        {t(VAULT_STATE_KEYS[status.state])}
      </p>
      {count !== null && (
        <p className="text-[var(--vds-text-secondary)]">{t('vault.summary', { count })}</p>
      )}
      <div className="flex flex-wrap gap-[var(--vds-space-2)]">
        {status.state === 'uninitialized' ? (
          <Button
            disabled={busy || unavailable}
            onClick={() => {
              void action('create')
            }}
          >
            {t('vault.create')}
          </Button>
        ) : status.state === 'unlocked' ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              void action('lock')
            }}
          >
            {t('vault.lock')}
          </Button>
        ) : (
          <Button
            disabled={busy || unavailable || status.error === VAULT_ERROR.invalidFormat}
            onClick={() => {
              void action('unlock')
            }}
          >
            {t('vault.unlock')}
          </Button>
        )}
        {status.state !== 'uninitialized' && (
          <Button
            variant="outline"
            disabled={busy || unavailable}
            onClick={() => {
              void action('reset')
            }}
          >
            {t('vault.reset')}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-[var(--vds-error-text-primary)]">
          {t(VAULT_ERROR_KEYS[error])}
        </p>
      )}
    </Card>
  )
}

const CURRENT_SURFACE = () => true

export function BrowserSettings({
  onHistoryReopened,
  section = 'overview',
  onSection,
  isSurfaceCurrent = CURRENT_SURFACE,
}: {
  onHistoryReopened: () => void
  section?: BrowserSettingsSection
  onSection?: (section: BrowserSettingsSection) => void
  isSurfaceCurrent?: () => boolean
}): React.JSX.Element {
  const { t } = useTranslation('browser')
  const [automation, setAutomation] = useState(EMPTY_AUTOMATION)
  const [error, setError] = useState<BrowserErrorCode | null>(null)
  const [dataError, setDataError] = useState<BrowserErrorCode | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [clearChoice, setClearChoice] = useState<ClearChoice>('hour')
  const [selectedDataTypes, setSelectedDataTypes] = useState<BrowserDataType[]>([])
  const [siteOrigin, setSiteOrigin] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [dataMessage, setDataMessage] = useState<string | null>(null)
  const [sharedMutation, setSharedMutation] = useState<object | null>(null)
  const [historyInvalidationGeneration, setHistoryInvalidationGeneration] = useState(0)
  const invalidation = useRef(0)
  const mutation = useRef<object | null>(null)
  const surface = useRef({ section, current: isSurfaceCurrent, epoch: 0 })
  if (surface.current.section !== section || surface.current.current !== isSurfaceCurrent) {
    surface.current = { section, current: isSurfaceCurrent, epoch: surface.current.epoch + 1 }
    setConfirmClear(false)
    setDataMessage(null)
    setDataError(null)
  }
  const surfaceEpoch = surface.current.epoch
  const surfaceCurrent = useCallback(
    () => mounted.current && surface.current.epoch === surfaceEpoch && isSurfaceCurrent(),
    [surfaceEpoch, isSurfaceCurrent]
  )
  const historyBusy = sharedMutation !== null
  const [downloadSettings, setDownloadSettings] = useState<BrowserDownloadSettings | null>(null)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [downloadError, setDownloadError] = useState<BrowserErrorCode | null>(null)
  const [policy, setPolicy] = useState<BrowserPolicySnapshot | null>(null)
  const [policyLoading, setPolicyLoading] = useState(true)
  const [policyError, setPolicyError] = useState<BrowserErrorCode | null>(null)
  const [policyBusy, setPolicyBusy] = useState(false)
  const [policyOrigin, setPolicyOrigin] = useState('')
  const [policyAction, setPolicyAction] = useState<BrowserPolicyAction>('read')
  const [policyDecision, setPolicyDecision] = useState<BrowserPolicyDecision>('allow')
  const mounted = useRef(false)
  const inFlight = useRef(false)
  const sequence = useRef(0)

  useEffect(() => {
    mounted.current = true
    const bridge = window.scholarseed.browser
    const unsubscribe = bridge.subscribe((snapshot) => {
      sequence.current += 1
      setAutomation(snapshot.automation)
    })
    const revision = sequence.current
    void bridge
      .snapshot()
      .then((reply) => {
        if (!mounted.current) return
        if (!reply.ok) setError(reply.error)
        else if (sequence.current === revision) setAutomation(reply.snapshot.automation)
      })
      .catch(() => {
        if (mounted.current) setError(BROWSER_ERROR.operationFailed)
      })
    return () => {
      mounted.current = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let active = true
    void window.scholarseed.browser
      .downloads({ kind: 'read' })
      .then((reply) => {
        if (!active) return
        if (reply.ok) setDownloadSettings(reply.settings)
        else setDownloadError(reply.error)
      })
      .catch(() => {
        if (active) setDownloadError(BROWSER_ERROR.operationFailed)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    void window.scholarseed.browser
      .policy({ kind: 'read' })
      .then((reply) => {
        if (!active) return
        if (reply.ok) setPolicy(reply.policy)
        else setPolicyError(reply.error)
        setPolicyLoading(false)
      })
      .catch(() => {
        if (active) {
          setPolicyError(BROWSER_ERROR.policyUnavailable)
          setPolicyLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [])

  const retryPolicy = async (): Promise<void> => {
    if (policyLoading || policyBusy) return
    setPolicyLoading(true)
    setPolicyError(null)
    try {
      const reply = await window.scholarseed.browser.policy({ kind: 'read' })
      if (reply.ok) setPolicy(reply.policy)
      else {
        setPolicy(null)
        setPolicyError(reply.error)
      }
    } catch {
      setPolicy(null)
      setPolicyError(BROWSER_ERROR.policyUnavailable)
    } finally {
      setPolicyLoading(false)
    }
  }

  const updatePolicy = async (
    request: Exclude<BrowserPolicyRequest, { kind: 'read' }>
  ): Promise<void> => {
    if (policyBusy || !policy) return
    setPolicyBusy(true)
    setPolicyError(null)
    try {
      const reply = await window.scholarseed.browser.policy(request)
      if (reply.ok) {
        setPolicy(reply.policy)
        if (request.kind === 'set' && request.origin === policyOrigin.trim()) setPolicyOrigin('')
      } else {
        setPolicyError(reply.error)
        if (request.kind === 'set-agent-use') {
          const current = await window.scholarseed.browser.policy({ kind: 'read' })
          setPolicy(current.ok ? current.policy : null)
        } else if (reply.error === BROWSER_ERROR.policyUnavailable) setPolicy(null)
      }
    } catch {
      setPolicy(null)
      setPolicyError(BROWSER_ERROR.policyUnavailable)
    } finally {
      setPolicyBusy(false)
    }
  }

  const updateDownloads = async (
    request: Exclude<BrowserDownloadRequest, { kind: 'read' }>
  ): Promise<void> => {
    if (downloadBusy) return
    setDownloadBusy(true)
    setDownloadError(null)
    try {
      const reply = await window.scholarseed.browser.downloads(request)
      if (reply.ok) setDownloadSettings(reply.settings)
      else setDownloadError(reply.error)
    } catch {
      setDownloadError(BROWSER_ERROR.operationFailed)
    } finally {
      setDownloadBusy(false)
    }
  }

  const acquireAction = useCallback((): HistoryActionLease | null => {
    if (mutation.current || !surfaceCurrent()) return null
    const token = {}
    mutation.current = token
    setSharedMutation(token)
    return {
      current: () => mutation.current === token && surfaceCurrent(),
      finish: () => {
        if (mutation.current !== token) return
        mutation.current = null
        if (mounted.current) setSharedMutation(null)
      },
    }
  }, [surfaceCurrent])

  const clearData = async (): Promise<void> => {
    const lease = acquireAction()
    if (!lease) return
    setDataError(null)
    setDataMessage(null)
    const request: BrowserDataRequest =
      clearChoice === 'hour'
        ? { kind: 'clear-history', since: Date.now() - HOUR_MILLISECONDS }
        : clearChoice === 'day'
          ? { kind: 'clear-history', since: Date.now() - DAY_MILLISECONDS }
          : clearChoice === 'all-history'
            ? { kind: 'clear-history' }
            : clearChoice === 'site'
              ? { kind: 'clear-site-data', origin: siteOrigin.trim() }
              : clearChoice === 'selected'
                ? { kind: 'clear-selected', types: selectedDataTypes }
                : { kind: 'clear-all' }
    try {
      const reply = await window.scholarseed.browser.clearData(request)
      if (!lease.current()) return
      if (!reply.ok) setDataError(reply.error)
      else {
        invalidation.current += 1
        setHistoryInvalidationGeneration(invalidation.current)
        setDataMessage(t('settings.clearDone'))
      }
    } catch {
      if (lease.current()) setDataError(BROWSER_ERROR.operationFailed)
    } finally {
      if (lease.current()) setConfirmClear(false)
      lease.finish()
    }
  }

  const dispatch = async (command: BrowserCommand): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    setCopied(false)
    const revision = sequence.current
    try {
      const reply = await window.scholarseed.browser.dispatch(command)
      if (!mounted.current) return
      if (!reply.ok) {
        setError(reply.error)
        return
      }
      if (sequence.current === revision) setAutomation(reply.snapshot.automation)
      if (command.kind === 'copy-endpoint') setCopied(true)
    } catch {
      if (mounted.current) setError(BROWSER_ERROR.operationFailed)
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const address =
    automation.enabled && automation.port !== null ? `${LOOPBACK_HOST}:${automation.port}` : null
  const unavailable = error === BROWSER_ERROR.desktopBridgeUnavailable
  const historyCurrent = useCallback(
    (expected: number) =>
      surfaceCurrent() && mutation.current === null && expected === invalidation.current,
    [surfaceCurrent]
  )
  const history = (
    <History
      onReopened={onHistoryReopened}
      invalidationGeneration={historyInvalidationGeneration}
      disabled={historyBusy}
      acquireAction={acquireAction}
      isCurrent={historyCurrent}
    />
  )

  if (section === 'history')
    return (
      <SettingsPage
        data-testid="account-settings-browser-history"
        title={t('settings.historyPageTitle')}
        description={t('settings.historyDescription')}
      >
        <Button variant="outline" onClick={() => onSection?.('overview')}>
          {t('settings.historyBack')}
        </Button>
        {history}
      </SettingsPage>
    )

  return (
    <SettingsPage
      data-testid="account-settings-browser"
      title={t('settings.title')}
      description={t('settings.description')}
    >
      <VaultSettings />
      <Card className="grid gap-[var(--vds-space-4)]" data-testid="browser-settings-cdp">
        <div className="flex items-start justify-between gap-[var(--vds-space-4)]">
          <div className="min-w-0">
            <CardTitle>{t('settings.cdpTitle')}</CardTitle>
            <CardDescription>{t('settings.cdpDescription')}</CardDescription>
          </div>
          <Switch
            checked={automation.enabled}
            disabled={busy || unavailable}
            label={t(automation.enabled ? 'disableAutomation' : 'enableAutomation')}
            onCheckedChange={(enabled) => {
              void dispatch({ kind: 'automation', enabled })
            }}
          />
        </div>
        <p className="text-[var(--vds-text-secondary)]" role="status">
          {address ? t('settings.address', { address }) : t('settings.disabled')}
        </p>
        {address && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              void dispatch({ kind: 'copy-endpoint' })
            }}
          >
            {t('copyEndpoint')}
          </Button>
        )}
        {copied && (
          <p role="status" className="text-[var(--vds-text-secondary)]">
            {t('copied')}
          </p>
        )}
        <p className="text-[var(--vds-text-secondary)]">{t('settings.warning')}</p>
        {error && (
          <p role="alert" className="text-[var(--vds-error-text-primary)]">
            {t(BROWSER_ERROR_KEYS[error])}
          </p>
        )}
      </Card>
      <Card className="grid gap-[var(--vds-space-4)]" data-testid="browser-settings-downloads">
        <div>
          <CardTitle>{t('settings.downloadTitle')}</CardTitle>
          <CardDescription>{t('settings.downloadDescription')}</CardDescription>
        </div>
        <p
          className="break-all text-[var(--vds-text-secondary)]"
          data-testid="browser-download-directory"
        >
          {downloadSettings?.directory ?? t('settings.downloadLoading')}
        </p>
        {downloadSettings && !downloadSettings.directoryAvailable && (
          <p role="alert" className="text-[var(--vds-error-text-primary)]">
            {t('settings.downloadMissing')}
          </p>
        )}
        <div className="flex items-center justify-between gap-[var(--vds-space-4)]">
          <span>{t('settings.downloadAskEveryTime')}</span>
          <Switch
            checked={downloadSettings?.askEveryTime ?? true}
            disabled={downloadBusy || !downloadSettings?.automaticAvailable}
            label={t('settings.downloadAskEveryTime')}
            onCheckedChange={(enabled) => {
              void updateDownloads({ kind: 'set-ask-every-time', enabled })
            }}
          />
        </div>
        {downloadSettings && !downloadSettings.automaticAvailable && (
          <p className="text-[var(--vds-text-secondary)]">
            {t('settings.downloadAutomaticUnavailable')}
          </p>
        )}
        <p className="text-[var(--vds-text-secondary)]">
          {t('settings.downloadAgentNavigationBlocked')}
        </p>
        <div className="flex flex-wrap gap-[var(--vds-space-2)]">
          <Button
            type="button"
            variant="outline"
            disabled={downloadBusy || !downloadSettings}
            onClick={() => {
              void updateDownloads({ kind: 'choose-directory' })
            }}
          >
            {t('settings.downloadChoose')}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={downloadBusy || !downloadSettings || downloadSettings.isDefault}
            onClick={() => {
              void updateDownloads({ kind: 'reset-directory' })
            }}
          >
            {t('settings.downloadReset')}
          </Button>
        </div>
        {downloadError && (
          <p role="alert" className="text-[var(--vds-error-text-primary)]">
            {t(BROWSER_ERROR_KEYS[downloadError])}
          </p>
        )}
      </Card>
      <Card className="grid gap-[var(--vds-space-4)]" data-testid="browser-settings-agent-sites">
        <div className="flex items-start justify-between gap-[var(--vds-space-4)]">
          <div className="min-w-0">
            <CardTitle>{t('settings.agentUseTitle')}</CardTitle>
            <CardDescription>{t('settings.agentUseDescription')}</CardDescription>
          </div>
          <Switch
            checked={policy?.agentBrowserUseEnabled ?? false}
            disabled={policyBusy || !policy}
            label={t('settings.agentUseTitle')}
            onCheckedChange={(enabled) => {
              void updatePolicy({ kind: 'set-agent-use', enabled })
            }}
          />
        </div>
        {policy && !policy.agentBrowserUseEnabled && (
          <p role="status" className="text-[var(--vds-text-secondary)]">
            {t('settings.agentUseOff')}
          </p>
        )}
        <div>
          <CardTitle>{t('settings.agentSitesTitle')}</CardTitle>
          <CardDescription>{t('settings.agentSitesDescription')}</CardDescription>
        </div>
        <p className="text-[var(--vds-text-secondary)]">{t('settings.agentSubmit')}</p>
        {policyLoading ? (
          <p role="status" className="text-[var(--vds-text-secondary)]">
            {t('settings.agentSitesLoading')}
          </p>
        ) : !policy ? (
          <div className="grid gap-[var(--vds-space-2)]">
            <p role="alert" className="text-[var(--vds-error-text-primary)]">
              {t('settings.agentSitesUnavailable')}
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void retryPolicy()
              }}
            >
              {t('settings.agentSitesRetry')}
            </Button>
          </div>
        ) : (
          <>
            <div className="flex min-w-0 flex-wrap items-end gap-[var(--vds-space-2)]">
              <Input
                label={t('settings.agentOrigin')}
                placeholder="https://example.org"
                value={policyOrigin}
                onChange={(event) => setPolicyOrigin(event.target.value)}
                disabled={policyBusy}
              />
              <Select
                value={policyAction}
                onValueChange={(value) => setPolicyAction(value as BrowserPolicyAction)}
                disabled={policyBusy}
              >
                <SelectTrigger aria-label={t('settings.agentAction')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="read">{t('settings.agentRead')}</SelectItem>
                  <SelectItem value="interact">{t('settings.agentInteract')}</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={policyDecision}
                onValueChange={(value) => setPolicyDecision(value as BrowserPolicyDecision)}
                disabled={policyBusy}
              >
                <SelectTrigger aria-label={t('settings.agentDecision')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="allow">{t('settings.agentAllow')}</SelectItem>
                  <SelectItem value="block">{t('settings.agentBlock')}</SelectItem>
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                disabled={policyBusy || !policyOrigin.trim()}
                onClick={() => {
                  void updatePolicy({
                    kind: 'set',
                    origin: policyOrigin.trim(),
                    action: policyAction,
                    decision: policyDecision,
                  })
                }}
              >
                {t('settings.agentAdd')}
              </Button>
            </div>
            {policy.sites.length === 0 ? (
              <p className="text-[var(--vds-text-secondary)]">{t('settings.agentSitesEmpty')}</p>
            ) : (
              <ul className="grid gap-[var(--vds-space-3)]" data-testid="browser-agent-site-list">
                {policy.sites.map((site) => (
                  <li
                    key={site.origin}
                    className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-3)] border-b border-[var(--vds-border-default)] pb-[var(--vds-space-3)]"
                  >
                    <span className="min-w-0 break-all">{site.origin}</span>
                    <Select
                      value={site.read}
                      onValueChange={(value) => {
                        void updatePolicy({
                          kind: 'set',
                          origin: site.origin,
                          action: 'read',
                          decision: value as BrowserPolicyDecision,
                        })
                      }}
                      disabled={policyBusy}
                    >
                      <SelectTrigger aria-label={`${site.origin} · ${t('settings.agentRead')}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ask">{t('settings.agentAsk')}</SelectItem>
                        <SelectItem value="allow">{t('settings.agentAllow')}</SelectItem>
                        <SelectItem value="block">{t('settings.agentBlock')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select
                      value={site.interact}
                      onValueChange={(value) => {
                        void updatePolicy({
                          kind: 'set',
                          origin: site.origin,
                          action: 'interact',
                          decision: value as BrowserPolicyDecision,
                        })
                      }}
                      disabled={policyBusy}
                    >
                      <SelectTrigger aria-label={`${site.origin} · ${t('settings.agentInteract')}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ask">{t('settings.agentAsk')}</SelectItem>
                        <SelectItem value="allow">{t('settings.agentAllow')}</SelectItem>
                        <SelectItem value="block">{t('settings.agentBlock')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={policyBusy}
                      onClick={() => {
                        void updatePolicy({ kind: 'remove', origin: site.origin })
                      }}
                    >
                      {t('settings.agentRemove', { origin: site.origin })}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {policyError && policy && (
          <p role="alert" className="text-[var(--vds-error-text-primary)]">
            {t(BROWSER_ERROR_KEYS[policyError])}
          </p>
        )}
      </Card>
      {history}
      <Card className="grid gap-[var(--vds-space-4)]" data-testid="browser-settings-data">
        <div>
          <CardTitle>{t('settings.dataTitle')}</CardTitle>
          <CardDescription>{t('settings.dataDescription')}</CardDescription>
        </div>
        <Select
          disabled={historyBusy}
          value={clearChoice}
          onValueChange={(value) => setClearChoice(value as ClearChoice)}
        >
          <SelectTrigger aria-label={t('settings.clearScope')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hour">{t('settings.clearHour')}</SelectItem>
            <SelectItem value="day">{t('settings.clearDay')}</SelectItem>
            <SelectItem value="all-history">{t('settings.clearHistory')}</SelectItem>
            <SelectItem value="site">{t('settings.clearSite')}</SelectItem>
            <SelectItem value="selected">{t('settings.clearSelected')}</SelectItem>
            <SelectItem value="all-data">{t('settings.clearAll')}</SelectItem>
          </SelectContent>
        </Select>
        {clearChoice === 'site' && (
          <Input
            disabled={historyBusy}
            label={t('settings.siteOrigin')}
            placeholder="https://example.org"
            value={siteOrigin}
            onChange={(event) => setSiteOrigin(event.target.value)}
          />
        )}
        {(clearChoice === 'site' || clearChoice === 'selected') && (
          <p className="text-[var(--vds-text-secondary)]">{t('settings.profileClearNotice')}</p>
        )}
        {clearChoice === 'selected' && (
          <div
            className="grid gap-[var(--vds-space-2)]"
            role="group"
            aria-label={t('settings.clearSelected')}
          >
            {DATA_TYPE_CHOICES.map((type) => (
              <Checkbox
                key={type}
                label={t(DATA_TYPE_KEYS[type])}
                checked={selectedDataTypes.includes(type)}
                disabled={historyBusy}
                onCheckedChange={(checked) =>
                  setSelectedDataTypes((current) =>
                    checked
                      ? DATA_TYPE_CHOICES.filter(
                          (choice) => choice === type || current.includes(choice)
                        )
                      : current.filter((choice) => choice !== type)
                  )
                }
              />
            ))}
            <p className="text-[var(--vds-text-secondary)]">{t('settings.selectedDataNotice')}</p>
          </div>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={
            historyBusy ||
            (clearChoice === 'site' && !siteOrigin.trim()) ||
            (clearChoice === 'selected' && selectedDataTypes.length === 0)
          }
          onClick={() => setConfirmClear(true)}
        >
          {t('settings.clearAction')}
        </Button>
        {dataMessage && (
          <p role="status" className="text-[var(--vds-text-secondary)]">
            {dataMessage}
          </p>
        )}
        {dataError && (
          <p role="alert" className="text-[var(--vds-error-text-primary)]">
            {t(BROWSER_ERROR_KEYS[dataError])}
          </p>
        )}
        <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
          <AlertDialogPortal>
            <AlertDialogContent
              className="!z-[var(--vds-z-modal-nested)]"
              overlayClassName="!z-[var(--vds-z-modal-nested-overlay)]"
            >
              <AlertDialogHeader>
                <AlertDialogTitle>{t('settings.clearConfirmTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('settings.clearConfirmDescription')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={historyBusy}>{t('settings.cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  variant="danger"
                  disabled={historyBusy}
                  onClick={() => {
                    void clearData()
                  }}
                >
                  {t('settings.clearAction')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialogPortal>
        </AlertDialog>
      </Card>
    </SettingsPage>
  )
}
