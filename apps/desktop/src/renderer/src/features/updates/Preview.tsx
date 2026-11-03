import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  isPreviewUpdateChannel,
  updateCandidateKey,
  type PreviewUpdateLine,
  type PreviewUpdatePolicy,
  type PreviewUpdateScope,
  type UpdateSnapshot,
} from '../../../../updates'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  Select,
  Spinner,
} from '../../components/ui'

/** Preview policy is main-owned; this view only submits explicit user choices. */
export function PreviewUpdates({
  state,
}: {
  state: UpdateSnapshot | null
}): React.JSX.Element | null {
  if (!isPreviewUpdateChannel(window.scholarseed.channel)) return null
  return <PreviewControls state={state} />
}

function PreviewControls({ state }: { state: UpdateSnapshot | null }): React.JSX.Element {
  const { t } = useTranslation('components')
  const [policy, setPolicy] = useState<PreviewUpdatePolicy | null>(null)
  const [open, setOpen] = useState(false)
  const [lines, setLines] = useState<PreviewUpdateLine[]>([])
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const request = useRef(0)
  const submitting = useRef(false)
  const mounted = useRef(false)
  const titleId = useId()
  const descriptionId = useId()
  const blocked = Boolean(
    state?.restartPending ||
    state?.phase === 'installing' ||
    state?.phase === 'restarting' ||
    state?.phase === 'unsupported' ||
    state?.errorFallback === 'activation_recovery_required'
  )
  const candidate = lines.find((item) => item.latest.id === selected)?.latest

  useEffect(() => {
    mounted.current = true
    let active = true
    void window.scholarseed.getPreviewUpdatePolicy().then(
      (value) => {
        if (active) setPolicy(value)
      },
      () => {
        if (active) setFailed(true)
      }
    )
    return () => {
      active = false
      mounted.current = false
      request.current += 1
    }
  }, [])

  async function mutate(action: () => Promise<PreviewUpdatePolicy>): Promise<void> {
    if (submitting.current || blocked) return
    submitting.current = true
    setBusy(true)
    setFailed(false)
    try {
      const next = await action()
      if (mounted.current) {
        setPolicy(next)
        setOpen(false)
        setLines([])
        setSelected('')
      }
    } catch {
      // A failed target revalidation can revoke consent in main. Never keep a
      // stale UI policy after a mutation that partially committed its intent.
      try {
        const current = await window.scholarseed.getPreviewUpdatePolicy()
        if (mounted.current) setPolicy(current)
      } catch {
        // The original failure remains visible; no optimistic policy is adopted.
      }
      if (mounted.current) setFailed(true)
    } finally {
      submitting.current = false
      if (mounted.current) setBusy(false)
    }
  }

  async function loadLines(): Promise<void> {
    const generation = ++request.current
    setOpen(true)
    setLoading(true)
    setFailed(false)
    setLines([])
    setSelected('')
    try {
      const available = await window.scholarseed.listPreviewUpdateLines()
      if (mounted.current && generation === request.current) setLines(available)
    } catch {
      if (mounted.current && generation === request.current) setFailed(true)
    } finally {
      if (mounted.current && generation === request.current) setLoading(false)
    }
  }

  return (
    <div
      className="grid gap-[var(--vds-space-3)] border-t border-[var(--vds-border-default)] p-[var(--vds-space-4)]"
      data-testid="preview-update-controls"
    >
      <Select
        label={t('update.preview.scope')}
        value={policy?.scope ?? 'current-line'}
        disabled={!policy || busy || blocked || Boolean(policy.target)}
        onChange={(event) =>
          void mutate(() =>
            window.scholarseed.setPreviewUpdateScope(event.target.value as PreviewUpdateScope)
          )
        }
        data-testid="preview-update-scope"
      >
        <option value="current-line">{t('update.preview.currentLine')}</option>
        <option value="current-version">{t('update.preview.currentVersion')}</option>
      </Select>
      <p className="text-[length:var(--vds-type-body-size)] leading-[var(--vds-type-body-line)] text-[var(--vds-text-secondary)]">
        {t('update.preview.scopeHelp')}
      </p>
      {policy?.target && state?.reason === 'preview-target-unavailable' && (
        <p
          role="alert"
          className="text-[length:var(--vds-type-body-size)] leading-[var(--vds-type-body-line)] text-[var(--vds-text-secondary)]"
        >
          {t('update.preview.targetUnavailable')}
        </p>
      )}
      {policy?.target ? (
        <div className="flex flex-wrap items-center gap-[var(--vds-space-3)]">
          <p className="min-w-0 break-words text-[length:var(--vds-type-body-size)] leading-[var(--vds-type-body-line)] text-[var(--vds-text-secondary)]">
            {t('update.preview.target', {
              version: policy.target.version,
              build: policy.target.build_number,
            })}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || blocked}
            onClick={() => void mutate(() => window.scholarseed.cancelPreviewUpdateTarget())}
            data-testid="preview-update-cancel"
          >
            {t('update.preview.cancelTarget')}
          </Button>
        </div>
      ) : (
        <div>
          <Button
            size="sm"
            variant="outline"
            disabled={!policy || busy || blocked || loading}
            onClick={() => void loadLines()}
            data-testid="preview-update-lines"
          >
            {t('update.preview.switchLine')}
          </Button>
        </div>
      )}
      {failed && !open && (
        <div
          role="alert"
          className="text-[length:var(--vds-type-body-size)] leading-[var(--vds-type-body-line)] text-[var(--vds-text-secondary)]"
        >
          {t('update.preview.failed')}
          {!policy && (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void mutate(() => window.scholarseed.getPreviewUpdatePolicy())}
              >
                {t('update.preview.retry')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || blocked}
                onClick={() =>
                  void mutate(() => window.scholarseed.setPreviewUpdateScope('current-line'))
                }
              >
                {t('update.preview.reset')}
              </Button>
            </>
          )}
        </div>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!submitting.current) {
            setOpen(value)
            if (!value) {
              request.current += 1
              setLoading(false)
            }
          }
        }}
      >
        <DialogPortal>
          <DialogContent
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            data-testid="preview-update-dialog"
            className="!z-[var(--vds-z-update-confirmation)]"
            overlayClassName="!z-[var(--vds-z-update-confirmation-overlay)]"
          >
            <DialogHeader>
              <DialogTitle id={titleId}>{t('update.preview.switchLine')}</DialogTitle>
              <DialogDescription id={descriptionId}>
                {t('update.preview.switchHelp')}
              </DialogDescription>
            </DialogHeader>
            {loading ? (
              <Spinner size="sm" />
            ) : (
              <Select
                label={t('update.preview.targetLine')}
                value={selected}
                disabled={busy || blocked || lines.length === 0}
                onChange={(event) => setSelected(event.target.value)}
                data-testid="preview-update-target"
              >
                <option value="">{t('update.preview.choose')}</option>
                {lines.map(({ line, latest }) => (
                  <option key={latest.id} value={latest.id}>
                    {t('update.preview.lineOption', {
                      line,
                      version: latest.version,
                      build: latest.build_number,
                    })}
                  </option>
                ))}
              </Select>
            )}
            {!loading && !failed && lines.length === 0 && (
              <p className="text-[length:var(--vds-type-body-size)] leading-[var(--vds-type-body-line)] text-[var(--vds-text-secondary)]">
                {t('update.preview.noLines')}
              </p>
            )}
            {candidate && (
              <div className="grid gap-[var(--vds-space-2)] text-[length:var(--vds-type-body-size)] leading-[var(--vds-type-body-line)] text-[var(--vds-text-secondary)]">
                <p className="max-h-[var(--vds-dialog-list-max-height)] overflow-auto whitespace-pre-wrap break-words">
                  {candidate.release_notes || t('update.preview.noNotes')}
                </p>
                <p>{t('update.preview.confirmHelp')}</p>
              </div>
            )}
            {failed && (
              <p
                role="alert"
                className="text-[length:var(--vds-type-body-size)] leading-[var(--vds-type-body-line)] text-[var(--vds-text-secondary)]"
              >
                {t('update.preview.failed')}
              </p>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  request.current += 1
                  setLoading(false)
                  setOpen(false)
                }}
              >
                {t('update.preview.back')}
              </Button>
              {failed && (
                <Button
                  variant="outline"
                  disabled={busy || loading}
                  onClick={() => void loadLines()}
                >
                  {t('update.preview.retry')}
                </Button>
              )}
              <Button
                disabled={!candidate || busy || blocked || loading}
                loading={busy}
                onClick={() => {
                  if (candidate)
                    void mutate(() => window.scholarseed.selectPreviewUpdateTarget(candidate.id))
                }}
                data-testid="preview-update-confirm"
              >
                {candidate
                  ? t('update.preview.confirm', { version: updateCandidateKey(candidate) ?? '' })
                  : t('update.preview.choose')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </DialogPortal>
      </Dialog>
    </div>
  )
}
