import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { updateCandidateKey, type UpdateSnapshot } from '../../../../updates'
import {
  matchesRestartConfirmation,
  runLatestUpdateAction,
  runUpdateAction,
  updateActionOf,
  updateFailureText,
  useLatestUpdateAttempt,
} from '../../features/updates/state'
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
  AlertDialogTrigger,
  Button,
  type ButtonProps,
} from '../ui'

interface UpdateActionProps extends Omit<ButtonProps, 'onClick'> {
  state: UpdateSnapshot | null
  onAction?: () => void
}

export function UpdateAction({ state, onAction, ...props }: UpdateActionProps): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: accountText } = useTranslation('account')
  const titleId = useId()
  const descriptionId = useId()
  const [requested, setRequested] = useState<UpdateSnapshot | null>(null)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const currentAttempt = useLatestUpdateAttempt(state)
  const responding = useRef(false)
  const requestedKey = updateCandidateKey(requested?.candidate)
  const followNativePromotion = window.scholarseed.platform === 'darwin'
  const valid = matchesRestartConfirmation(requested, state, followNativePromotion)

  const canRestart = updateActionOf(state) === 'install'
  const latestFailure =
    typeof currentAttempt?.result === 'object' ? currentAttempt.result : undefined
  const showPromotionHint =
    followNativePromotion &&
    valid &&
    (state?.latestCandidate || state?.candidate?.id !== requested?.candidate?.id)

  const execute = async (confirmedKey?: string): Promise<void> => {
    if (responding.current) return
    responding.current = true
    setPending(true)
    setFailed(false)
    try {
      onAction?.()
      if (
        (await runUpdateAction(
          confirmedKey ? requested : state,
          confirmedKey,
          followNativePromotion
        )) === 'candidate-changed'
      )
        return
      setRequested(null)
    } catch {
      setFailed(true)
    } finally {
      responding.current = false
      setPending(false)
    }
  }

  const button = (
    <Button
      {...props}
      disabled={props.disabled || pending}
      onClick={() => {
        if (canRestart) {
          setFailed(false)
          setRequested(state)
        } else void execute()
      }}
    />
  )

  return (
    <AlertDialog
      open={requested !== null}
      onOpenChange={(open) => {
        if (!open && !responding.current) setRequested(null)
      }}
    >
      {state?.latestCandidate && canRestart && (
        <Button
          size="sm"
          variant="outline"
          className="max-w-full whitespace-normal"
          disabled={pending || (!!currentAttempt && !latestFailure)}
          data-testid="update-download-latest"
          onClick={() => {
            if (!responding.current) void runLatestUpdateAction(state, onAction)
          }}
        >
          {t('update.downloadLatest', { build: state.latestCandidate.build_number })}
        </Button>
      )}
      {latestFailure && (
        <span role="alert">{updateFailureText(latestFailure, t, accountText)}</span>
      )}
      {/* Link the portal to its trigger so ancestor popovers retain it through pointerdown. */}
      {canRestart ? <AlertDialogTrigger asChild>{button}</AlertDialogTrigger> : button}

      {failed && requested === null && <span role="alert">{t('update.confirmRestartFailed')}</span>}
      <AlertDialogPortal>
        <AlertDialogContent
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          data-testid="update-restart-confirmation"
          className="!z-[var(--vds-z-update-confirmation)]"
          overlayClassName="!z-[var(--vds-z-update-confirmation-overlay)]"
        >
          <AlertDialogHeader>
            <AlertDialogTitle id={titleId}>{t('update.confirmRestartTitle')}</AlertDialogTitle>
            <AlertDialogDescription id={descriptionId}>
              {showPromotionHint && <>{t('update.confirmRestartLatestReady')} </>}
              {t('update.confirmRestartDetail')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {!valid && (
            <AlertDialogDescription role="alert">
              {t('update.confirmRestartChanged')}
            </AlertDialogDescription>
          )}
          {failed && (
            <AlertDialogDescription role="alert">
              {t('update.confirmRestartFailed')}
            </AlertDialogDescription>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus disabled={pending} data-testid="update-restart-cancel">
              {t('update.laterUpdate')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={pending || !valid}
              variant="danger"
              data-testid="update-restart-confirm"
              onClick={(event) => {
                event.preventDefault()
                if (valid && requestedKey) void execute(requestedKey)
              }}
            >
              {t('update.confirmRestart')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialogPortal>
    </AlertDialog>
  )
}
