import { profileFailureText } from './profile'
import type { PersonalApiFailure } from '../../api'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { SubscriptionErrorCode } from '../../../../subscriptions'
import { cancelSubscriptionLogin, createSubscriptionProfile, disconnectSubscription,
  saveSubscriptionModels, subscriptionModels, subscriptionStatus, deletePersonalApiProfile,
  type PersonalApiModel, type PersonalApiProfile } from '../../api'
import { Button, Checkbox, AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogCancel, AlertDialogAction } from '../ui'

const POLL_MS = 1500
const ERROR_KEYS = {"oauth_region_unsupported": "errors.oauth_region_unsupported", "oauth_client_rejected": "errors.oauth_client_rejected", "oauth_network_timeout": "errors.oauth_network_timeout", "oauth_invalid_response": "errors.oauth_invalid_response", "oauth_authorization_expired": "errors.oauth_authorization_expired", "oauth_authorization_denied": "errors.oauth_authorization_denied", "oauth_authorization_in_progress": "errors.oauth_authorization_in_progress", "oauth_transaction_unavailable": "errors.oauth_transaction_unavailable", "oauth_network_unavailable": "errors.oauth_network_unavailable", "oauth_exchange_failed": "errors.oauth_exchange_failed", "oauth_account_changed": "errors.oauth_account_changed", "oauth_connection_changed": "errors.oauth_connection_changed", "oauth_storage_unavailable": "errors.oauth_storage_unavailable", "oauth_refresh_busy": "errors.oauth_refresh_busy", "oauth_callback_port_unavailable": "errors.oauth_callback_port_unavailable", "oauth_reauth_required": "errors.oauth_reauth_required", "oauth_models_rejected": "errors.oauth_models_rejected", "oauth_models_unavailable": "errors.oauth_models_unavailable", "oauth_disconnect_before_login": "errors.oauth_disconnect_before_login"} as const
type NoticeKey = (typeof ERROR_KEYS)[keyof typeof ERROR_KEYS] | 'operationFailed' | 'loginSuccess' | 'loginExpired' | 'browserAuth' | 'desktopUnsupported' | 'loginFailed' | 'selectModels' | 'noModels' | 'modelsSaved' | 'disconnectedNotice' | 'deleteFailed' | 'loginCancelled'
type Notice = { profileFailure: PersonalApiFailure } | { key: NoticeKey } | { raw: string } | { ipc: SubscriptionErrorCode; detail?: string }
const message = (error: string): Notice => Object.prototype.hasOwnProperty.call(ERROR_KEYS, error)
  ? { key: ERROR_KEYS[error as keyof typeof ERROR_KEYS] }
  : error ? { raw: error } : { key: 'operationFailed' }

function profileMessage(result: PersonalApiFailure): Notice {
  if (Object.prototype.hasOwnProperty.call(ERROR_KEYS, result.error)) return message(result.error)
  return result.code ? { profileFailure: result } : message(result.error)
}

function Connection({ profile, available, refresh }: { profile: PersonalApiProfile; available: boolean; refresh: () => void }): React.JSX.Element {
  const { t } = useTranslation('subscription')
  const lifetime = React.useRef(0)
  React.useEffect(() => () => { lifetime.current += 1 }, [])
  const [transaction, setTransaction] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState<Notice | null>(null)
  const [candidates, setCandidates] = React.useState<PersonalApiModel[]>([])
  const [selected, setSelected] = React.useState(profile.selected_models)
  const connected = profile.oauth?.state === 'connected'
  React.useEffect(() => { setSelected(profile.selected_models) }, [profile.selected_models])
  React.useEffect(() => {
    if (!transaction) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      const result = await subscriptionStatus(profile.id, transaction)
      if (stopped) return
      if (!result.ok) { setNotice(profileMessage(result)); setTransaction(''); return }
      if (['authorizing', 'exchanging'].includes(result.data.state)) { timer = setTimeout(() => { void poll() }, POLL_MS); return }
      setTransaction('')
      setNotice(result.data.state === 'connected' ? { key: 'loginSuccess' } : result.data.error ? message(result.data.error) : { key: 'loginExpired' })
      refresh()
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer); void cancelSubscriptionLogin(profile.id, transaction) }
  }, [profile.id, transaction, refresh])
  const login = async (): Promise<void> => {
    const attempt = ++lifetime.current
    setBusy(true); setNotice(null)
    try {
      const result = await window.scholarseed?.subscriptionLogin({ action: 'login', connectionId: profile.id })
      if (attempt !== lifetime.current) {
        if (result?.login) await cancelSubscriptionLogin(profile.id, result.login.transaction_id)
        return
      }
      if (result?.login) { setTransaction(result.login.transaction_id); setNotice({ key: 'browserAuth' }) }
      else setNotice(result?.error && Object.prototype.hasOwnProperty.call(ERROR_KEYS, result.error) ? message(result.error) : result?.errorCode ? { ipc: result.errorCode, detail: result.error } : result?.error ? message(result.error) : { key: 'desktopUnsupported' })
    } catch (error) { if (attempt === lifetime.current) setNotice({ ipc: 'login_failed', detail: error instanceof Error ? error.message : String(error) }) } finally { if (attempt === lifetime.current) setBusy(false) }
  }
  const loadModels = async (): Promise<void> => {
    setBusy(true)
    const result = await subscriptionModels(profile.id)
    setBusy(false)
    if (result.ok) { setCandidates(result.data.models); setNotice(result.data.models.length ? { key: 'selectModels' } : { key: 'noModels' }) }
    else setNotice(profileMessage(result))
  }
  const save = async (): Promise<void> => {
    setBusy(true)
    const result = await saveSubscriptionModels(profile.id, selected)
    setBusy(false)
    if (result.ok) { setNotice({ key: 'modelsSaved' }); refresh() } else setNotice(profileMessage(result))
  }
  const disconnect = async (): Promise<void> => {
    setBusy(true)
    const result = await disconnectSubscription(profile.id)
    setBusy(false)
    if (result.ok) { setTransaction(''); setCandidates([]); setNotice({ key: 'disconnectedNotice' }); refresh() } else setNotice(profileMessage(result))
  }
  const remove = async (): Promise<void> => {
    setBusy(true)
    const result = await deletePersonalApiProfile(profile.id)
    setBusy(false)
    if (result) refresh(); else setNotice({ key: 'deleteFailed' })
  }
  // 启停由设置-模型页左栏厂商行的 Switch 承担, 卡内不再放第二份入口。
  return <div className="grid gap-3 rounded-lg border border-[var(--vds-border-default)] p-4">
    <div className="text-sm text-[var(--vds-text-primary)]">{t('connectionStatus', { name: profile.preview_name || 'ChatGPT', status: profile.oauth?.state === 'connected' ? t('connected') : profile.oauth?.state === 'reauth_required' ? t('reauth') : t('disconnected') })}</div>
    {profile.oauth?.account_label && <div className="text-sm text-[var(--vds-text-secondary)]">{profile.oauth.account_label}</div>}
    <div className="flex flex-wrap gap-2">
      {!connected && !transaction && <Button disabled={busy || !available} onClick={() => { void login() }}>{t('login')}</Button>}
      {transaction && <Button disabled={busy} onClick={() => { setTransaction(''); setNotice({ key: 'loginCancelled' }) }}>{t('cancelLogin')}</Button>}
      {connected && <><Button disabled={busy} onClick={() => { void loadModels() }}>{t('loadModels')}</Button><Button disabled={busy} onClick={() => { void disconnect() }}>{t('disconnect')}</Button></>}
      <AlertDialog><AlertDialogTrigger asChild><Button disabled={busy || Boolean(transaction)} variant="danger">{t('delete')}</Button></AlertDialogTrigger>
        <AlertDialogContent><AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle><AlertDialogDescription>{t('deleteDescription')}</AlertDialogDescription>
          <AlertDialogCancel>{t('cancel')}</AlertDialogCancel><AlertDialogAction onClick={() => { void remove() }}>{t('delete')}</AlertDialogAction>
        </AlertDialogContent></AlertDialog>
    </div>
    {connected && candidates.length > 0 && <div className="grid gap-2">
      {candidates.map(model => <Checkbox key={model.id} label={model.label || model.id} disabled={busy} checked={selected.some(item => item.id === model.id)} onCheckedChange={checked => setSelected(current => checked ? [...current.filter(item => item.id !== model.id), model] : current.filter(item => item.id !== model.id))} />)}
      <Button disabled={busy} onClick={() => { void save() }}>{t('saveModels')}</Button>
    </div>}
    {selected.length > 0 && <div className="text-xs text-[var(--vds-text-secondary)]">{t('selected', { models: selected.map(model => model.label || model.id).join(t('listSeparator')) })}</div>}
    {notice && <div role="status" className="text-sm text-[var(--vds-text-secondary)]">{noticeText(t, notice)}</div>}
  </div>
}

function noticeText(t: TFunction<'subscription'>, notice: Notice): string {
  if ('profileFailure' in notice) return profileFailureText(notice.profileFailure, t)
  if ('raw' in notice) return t('ipc.diagnostic', { message: t('operationFailed'), detail: notice.raw })
  if ('key' in notice) return renderNotice(t, notice.key)
  const labels = {
    local_service_required: t('ipc.localServiceRequired'),
    login_failed: t('ipc.loginFailed'),
    window_closed: t('ipc.windowClosed'),
    authorization_open_failed: t('ipc.authorizationOpenFailed')
  }
  return notice.detail ? t('ipc.diagnostic', { message: labels[notice.ipc], detail: notice.detail }) : labels[notice.ipc]
}

function renderNotice(t: TFunction<'subscription'>, key: NoticeKey): string {
  switch (key) {
    case 'errors.oauth_region_unsupported': return t('errors.oauth_region_unsupported')
    case 'errors.oauth_client_rejected': return t('errors.oauth_client_rejected')
    case 'errors.oauth_network_timeout': return t('errors.oauth_network_timeout')
    case 'errors.oauth_invalid_response': return t('errors.oauth_invalid_response')
    case 'errors.oauth_authorization_expired': return t('errors.oauth_authorization_expired')
    case 'errors.oauth_authorization_denied': return t('errors.oauth_authorization_denied')
    case 'errors.oauth_authorization_in_progress': return t('errors.oauth_authorization_in_progress')
    case 'errors.oauth_transaction_unavailable': return t('errors.oauth_transaction_unavailable')
    case 'errors.oauth_network_unavailable': return t('errors.oauth_network_unavailable')
    case 'errors.oauth_exchange_failed': return t('errors.oauth_exchange_failed')
    case 'errors.oauth_account_changed': return t('errors.oauth_account_changed')
    case 'errors.oauth_connection_changed': return t('errors.oauth_connection_changed')
    case 'errors.oauth_storage_unavailable': return t('errors.oauth_storage_unavailable')
    case 'errors.oauth_refresh_busy': return t('errors.oauth_refresh_busy')
    case 'errors.oauth_callback_port_unavailable': return t('errors.oauth_callback_port_unavailable')
    case 'errors.oauth_reauth_required': return t('errors.oauth_reauth_required')
    case 'errors.oauth_models_rejected': return t('errors.oauth_models_rejected')
    case 'errors.oauth_models_unavailable': return t('errors.oauth_models_unavailable')
    case 'errors.oauth_disconnect_before_login': return t('errors.oauth_disconnect_before_login')
    default: return t(key)
  }
}

export function SubscriptionConnections({ profiles, refresh, onCreated }: { profiles: PersonalApiProfile[]; refresh: () => void; onCreated?: (profile: PersonalApiProfile) => void }): React.JSX.Element {
  const { t } = useTranslation('subscription')
  const [available, setAvailable] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<Notice | null>(null)
  React.useEffect(() => {
    let stopped = false
    void window.scholarseed?.subscriptionLogin({ action: 'available' }).then(result => { if (!stopped) setAvailable(result.available) }).catch(() => { if (!stopped) setAvailable(false) })
    return () => { stopped = true }
  }, [])
  const add = async (): Promise<void> => {
    setBusy(true); setError(null)
    const result = await createSubscriptionProfile()
    setBusy(false)
    if (result.ok) { refresh(); if (result.data.profile) onCreated?.(result.data.profile) } else setError(profileMessage(result))
  }
  return <section aria-label={t('title')} className="mb-4 grid gap-3">
    {profiles.length === 0 && <div className="flex items-center justify-between gap-3"><span className="text-sm text-[var(--vds-text-primary)]">{t('title')}</span><Button disabled={!available || busy} onClick={() => { void add() }}>{t('connect')}</Button></div>}
    {!available && <p className="text-sm text-[var(--vds-text-secondary)]">{t('unavailable')}</p>}
    {profiles.filter(profile => profile.authentication === 'oauth').map(profile => <Connection key={profile.id} profile={profile} available={available} refresh={refresh} />)}
    {error && <p role="alert" className="text-sm text-[var(--vds-text-secondary)]">{noticeText(t, error)}</p>}
  </section>
}
