import { VAULT_ERROR_KEYS, VAULT_INTENT_KEYS } from './messages'
import { useEffect, useMemo, useRef, useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { Button, Card, CardDescription, CardTitle, PasswordInput } from '../../components/ui'
import {
  VAULT_ERROR,
  type VaultError,
  type VaultSeed,
  type VaultViewBridge,
} from '../../../../vault'
import { createLocalization } from '../../../../localization/engine'
import english from '../../../../localization/locales/en/browser.json'
import chinese from '../../../../localization/locales/zh/browser.json'
import englishUi from '../../../../localization/locales/en/ui.json'
import chineseUi from '../../../../localization/locales/zh/ui.json'

export function Vault({ bridge }: { bridge: VaultViewBridge }): React.JSX.Element | null {
  const [seed, setSeed] = useState<VaultSeed | null>(null)
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<VaultError | null>(null)
  const submitting = useRef(false)
  const localization = useMemo(
    () =>
      seed
        ? createLocalization(
            seed.language,
            { en: { browser: english, ui: englishUi }, zh: { browser: chinese, ui: chineseUi } },
            { report: () => undefined }
          )
        : null,
    [seed]
  )
  useEffect(() => {
    let active = true
    void bridge
      .seed()
      .then((value) => {
        if (!active || !value) return
        document.documentElement.lang = value.language
        document.documentElement.dataset.theme = value.theme
        document.documentElement.classList.toggle(
          'dark',
          value.theme === 'dark' ||
            (value.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
        )
        setSeed(value)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [bridge])
  if (!seed || !localization) return null
  const t = localization.getFixedT(seed.language, 'browser')
  const request = () => ({
    sessionId: seed.sessionId,
    generation: seed.generation,
    requestId: crypto.randomUUID(),
  })
  const cancel = () => {
    setPassword('')
    setConfirmation('')
    void bridge.cancel(request()).catch(() => undefined)
  }
  const submit = async (): Promise<void> => {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(null)
    let input = password
    let confirmed = confirmation
    setPassword('')
    setConfirmation('')
    try {
      const pending =
        seed.intent === 'reset'
          ? bridge.confirmReset({ ...request(), confirmation: true })
          : seed.intent === 'create'
            ? bridge.submit({
                ...request(),
                kind: 'create',
                password: input,
                confirmation: confirmed,
              })
            : bridge.submit({ ...request(), kind: 'unlock', password: input })
      input = ''
      confirmed = ''
      const reply = await pending
      if (!reply.ok) setError(reply.error)
    } catch {
      setError(VAULT_ERROR.revoked)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  return (
    <I18nextProvider i18n={localization}>
      <main
        className="grid h-screen place-items-center overflow-auto bg-[var(--vds-bg-primary)] p-[var(--vds-space-6)] text-[var(--vds-text-primary)]"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            cancel()
          }
        }}
      >
        <Card
          className="grid w-full max-w-lg gap-[var(--vds-space-4)]"
          data-testid="vault-protected-prompt"
        >
          <div>
            <CardTitle>{t(VAULT_INTENT_KEYS[seed.intent])}</CardTitle>
            <CardDescription>
              {t(seed.intent === 'reset' ? 'vault.resetWarning' : 'vault.protectedDescription')}
            </CardDescription>
          </div>
          <form
            autoComplete="off"
            onCopy={(event) => event.preventDefault()}
            onCut={(event) => event.preventDefault()}
            onDragStart={(event) => event.preventDefault()}
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
            className="grid gap-[var(--vds-space-4)]"
          >
            {seed.intent !== 'reset' && (
              <>
                <PasswordInput
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="off"
                  label={t('vault.password')}
                  aria-label={t('vault.password')}
                  value={password}
                  disabled={busy}
                  showLabel={t('vault.show')}
                  hideLabel={t('vault.hide')}
                  onChange={(event) => setPassword(event.target.value)}
                />
                {seed.intent === 'create' && (
                  <PasswordInput
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                    label={t('vault.confirmation')}
                    aria-label={t('vault.confirmation')}
                    value={confirmation}
                    disabled={busy}
                    showLabel={t('vault.show')}
                    hideLabel={t('vault.hide')}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                )}
                <p className="text-[var(--vds-text-secondary)]">
                  {t('vault.budget', {
                    minimum: seed.minimumCodepoints,
                    maximum: seed.passwordBytes,
                  })}
                </p>
              </>
            )}
            {error && (
              <p role="alert" className="text-[var(--vds-error-text-primary)]">
                {t(VAULT_ERROR_KEYS[error])}
              </p>
            )}
            <div className="flex flex-wrap gap-[var(--vds-space-2)]">
              <Button type="button" variant="outline" onClick={cancel}>
                {t('vault.cancel')}
              </Button>
              <Button type="submit" disabled={busy}>
                {t(
                  busy
                    ? 'vault.busy'
                    : seed.intent === 'reset'
                      ? 'vault.confirmReset'
                      : 'vault.submit'
                )}
              </Button>
            </div>
          </form>
        </Card>
      </main>
    </I18nextProvider>
  )
}
