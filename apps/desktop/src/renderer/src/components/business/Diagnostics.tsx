import React from 'react'
import { useTranslation } from 'react-i18next'

import type { DiagnosticPolicy, DiagnosticPreview } from '../../api'
import {
  DiagnosticOperationError, clearDetailedDiagnostics, downloadDetailedDiagnostics,
  getDiagnosticPolicy, previewDetailedDiagnostics, SESSION_DIAGNOSTIC_FILENAME, setDiagnosticPolicy
} from '../../api'
import { Button, Checkbox } from '../ui'

const KIB = 1024
const CATEGORY_KEYS = {
  user_message: 'diagnostics.categories.user_message', product_context: 'diagnostics.categories.product_context', runtime_submission: 'diagnostics.categories.runtime_submission',
  assistant_response: 'diagnostics.categories.assistant_response', tool_input: 'diagnostics.categories.tool_input', tool_output: 'diagnostics.categories.tool_output', permission: 'diagnostics.categories.permission'
} as const
const GAP_KEYS = {
  cleared: 'diagnostics.gaps.cleared', expired: 'diagnostics.gaps.expired', truncated: 'diagnostics.gaps.truncated',
  upstream_truncated: 'diagnostics.gaps.upstream_truncated', upstream_unavailable: 'diagnostics.gaps.upstream_unavailable',
  interrupted: 'diagnostics.gaps.interrupted', unsafe_partial_omitted: 'diagnostics.gaps.unsafe_partial_omitted',
  budget_exhausted: 'diagnostics.gaps.budget_exhausted',
  budget_evicted: 'diagnostics.gaps.budget_evicted'
} as const
type Confirmation = 'clear' | null

export function Diagnostics({ sessionId, disabled }: { sessionId: string; disabled: boolean }): React.JSX.Element {
  const { t } = useTranslation('components')
  const [policy, setPolicy] = React.useState<DiagnosticPolicy | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<'diagnostics.enabled' | 'diagnostics.disabled' | 'diagnostics.cleared' | 'diagnostics.saved' | null>(null)
  const [error, setError] = React.useState<{ text: string } | { messageKey: 'diagnostics.failed' | 'diagnostics.saveFailed' } | null>(null)
  const [confirmation, setConfirmation] = React.useState<Confirmation>(null)
  const [preview, setPreview] = React.useState<DiagnosticPreview | null>(null)
  const [accepted, setAccepted] = React.useState(false)

  React.useEffect(() => {
    let active = true
    void getDiagnosticPolicy(sessionId).then(value => { if (active) setPolicy(value) })
      .catch(reason => { if (active) setError(reason instanceof DiagnosticOperationError
        ? { messageKey: 'diagnostics.failed' } : { text: String(reason instanceof Error ? reason.message : reason) }) })
    return () => { active = false }
  }, [sessionId])

  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (busy || disabled) return
    setBusy(true); setError(null); setMessage(null)
    try { await operation() } catch (reason) {
      setError(reason instanceof Error && !(reason instanceof DiagnosticOperationError)
        ? { text: reason.message } : { messageKey: 'diagnostics.failed' })
      setPreview(null); setAccepted(false)
    } finally { setBusy(false) }
  }

  const change = async (enabled: boolean): Promise<void> => {
    if (!policy) return
    const updated = await setDiagnosticPolicy(sessionId, policy, enabled)
    setPolicy(updated); setConfirmation(null); setPreview(null)
    setMessage(enabled ? 'diagnostics.enabled' : 'diagnostics.disabled')
  }

  return <section aria-label={t('diagnostics.title')} className="flex flex-col gap-2 rounded-lg border border-[var(--vds-border-default)] p-3 text-xs text-[var(--vds-text-secondary)]">
    <strong className="text-[var(--vds-text-primary)]">{t('diagnostics.title')}</strong>
    <p>{t('diagnostics.policy')}</p>
    <p>{t('diagnostics.privacy')}</p>
    <p data-testid="diagnostic-policy-status">{!policy ? t('diagnostics.loading') : policy.active ? t('diagnostics.active') : t('diagnostics.inactive')}</p>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" disabled={!policy || busy || disabled} onClick={() => {
        void run(() => change(!policy?.active))
      }}>{policy?.active ? t('diagnostics.disable') : t('diagnostics.enable')}</Button>
      <Button size="sm" variant="secondary" disabled={busy || disabled} onClick={() => void run(async () => {
        setPreview(await previewDetailedDiagnostics(sessionId)); setConfirmation(null); setAccepted(false)
      })}>{t('diagnostics.preview')}</Button>
      <Button size="sm" variant="ghost" disabled={busy || disabled} onClick={() => { setConfirmation('clear'); setAccepted(false); setPreview(null) }}>{t('diagnostics.clear')}</Button>
    </div>
    {confirmation && <div className="flex flex-col gap-2" role="group" aria-label={t('diagnostics.confirmation')}>
      <p>{t('diagnostics.clearDescription')}</p>
      <Checkbox label={t('diagnostics.acceptClear')} checked={accepted} onCheckedChange={setAccepted} />
      <div className="flex gap-2">
        <Button size="sm" disabled={!accepted || busy || disabled} onClick={() => void run(async () => {
          await clearDetailedDiagnostics(sessionId); setPolicy(await getDiagnosticPolicy(sessionId))
          setConfirmation(null); setMessage('diagnostics.cleared')
        })}>{t('diagnostics.confirmClear')}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmation(null)}>{t('diagnostics.cancel')}</Button>
      </div>
    </div>}
    {preview && <div className="flex flex-col gap-2" aria-label={t('diagnostics.exportPreview')}>
      {!preview.manifest.content_available && <p>{t('diagnostics.empty')}</p>}
      <p>{t('diagnostics.available', { categories: preview.manifest.content_categories.map(category => Object.prototype.hasOwnProperty.call(CATEGORY_KEYS, category) ? t(CATEGORY_KEYS[category as keyof typeof CATEGORY_KEYS]) : category).join(', ') || t('diagnostics.none') })}</p>
      <p>{t('diagnostics.coverage', { submissions: preview.manifest.submissions.length, size: Math.ceil(preview.bytes / KIB), blocks: preview.manifest.truncated_blocks })}</p>
      <p>{t('diagnostics.gapSummary', { count: preview.manifest.missing_blocks, reasons: preview.manifest.missing_reasons.map(reason => Object.prototype.hasOwnProperty.call(GAP_KEYS, reason) ? t(GAP_KEYS[reason as keyof typeof GAP_KEYS]) : reason).join(', ') || t('diagnostics.noGaps') })}</p>
      <p>{t('diagnostics.retention')}</p>
      <Checkbox label={t('diagnostics.acceptSave')} checked={accepted} onCheckedChange={setAccepted} />
      <Button size="sm" disabled={!accepted || busy || disabled} onClick={() => void run(async () => {
        const bytes = await downloadDetailedDiagnostics(sessionId, preview)
        const result = await window.scholarseed?.saveFileCopy({ suggestedName: SESSION_DIAGNOSTIC_FILENAME, bytes: new Uint8Array(bytes) })
        if (result?.ok) { setMessage('diagnostics.saved'); setPreview(null) }
        else if (!result?.canceled) { setError({ messageKey: 'diagnostics.saveFailed' }); setPreview(null); setAccepted(false) }
      })}>{t('diagnostics.save')}</Button>
    </div>}
    {message && <p role="status">{t(message)}</p>}
    {error && <p role="alert" className="text-[var(--vds-error-default)]">{'messageKey' in error ? t(error.messageKey) : error.text}</p>}
  </section>
}
