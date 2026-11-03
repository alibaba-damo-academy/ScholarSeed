import React from 'react'
import { useTranslation } from 'react-i18next'
import type { ConvItem } from '../../model'
import { isRecoverableTurnFailure } from '../../failures'
import aiThinking from '../../assets/ai-thinking.gif'
import { IconFont } from '../primitive/Iconfont'
import { Alert, AlertDescription, Button, Card, Spinner } from '../ui'

export interface FailureProps {
  item: Extract<ConvItem, { kind: 'error' }>
  failureText: { title: string; message: string; action: string }
  recoveryAvailable: boolean
  onContinue: (item: Extract<ConvItem, { kind: 'error' }>) => Promise<void>
  actionError?: string
  authenticationAction?: 'login' | 'configure' | 'continue_turn'
  authenticationChecking?: boolean
  authenticationCheckFailed?: boolean
  onRepair?: (continueRequested: boolean) => Promise<void>
  children?: React.ReactNode
}

export function Failure({
  item,
  failureText,
  recoveryAvailable,
  onContinue,
  actionError,
  authenticationAction,
  authenticationChecking,
  authenticationCheckFailed,
  onRepair,
  children,
}: FailureProps): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: conversation } = useTranslation('conversation')
  const authenticationFailed = item.failure?.kind === 'auth'
  const confirming = item.actionState === 'submitting'
  const continuing = item.runtimeAction === 'continue_turn' && item.actionState === 'submitting'
  const continueUnknown =
    item.runtimeAction === 'continue_turn' && item.actionState === 'outcome_unknown'
  const turnUnknown = item.runtimeAction === 'confirm_turn_unknown'
  const recoverableFailure = isRecoverableTurnFailure(item)
  const failureDescription =
    item.failure?.kind === 'unknown'
      ? failureText.action
      : failureText.action && failureText.action !== failureText.message
        ? `${failureText.message} ${failureText.action}`
        : failureText.message || failureText.action
  if (turnUnknown) {
    return (
      <Alert
        action={
          recoveryAvailable ? (
            <Button
              data-testid="turn-unknown-continue"
              disabled={confirming || item.actionState === 'outcome_unknown'}
              loading={confirming}
              loadingIcon={<Spinner imageSrc={aiThinking} size="sm" aria-hidden="true" />}
              onClick={() => void onContinue(item)}
              size="sm"
              variant="outline"
            >
              {item.actionState === 'outcome_unknown'
                ? t('stream.continuePending')
                : t('stream.continueInterrupted')}
            </Button>
          ) : null
        }
        className="mb-[var(--vds-space-3)] w-full !gap-[var(--vds-space-half)] !rounded-[var(--vds-radius-6)] px-[var(--vds-space-3)] py-[var(--vds-space-3)]"
        data-testid="turn-interrupted-notice"
        layout="stacked"
        title={failureText.title}
        tone="warning"
      >
        <AlertDescription truncate={false}>{failureDescription}</AlertDescription>
        {actionError ? (
          <span className="text-[var(--vds-error-text-primary)]">{actionError}</span>
        ) : null}
      </Alert>
    )
  }
  if (recoverableFailure) {
    return (
      <div
        className="mb-[var(--vds-space-5)] grid grid-cols-[minmax(0,1fr)_auto] items-center gap-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
        data-testid="turn-recoverable-notice"
        role="status"
      >
        <div className="flex min-w-0 items-center gap-[var(--vds-space-2)]">
          <IconFont type="fill-status-tips" className="shrink-0" />
          <span className="min-w-0 break-words">
            {item.failure?.kind === 'unknown'
              ? conversation('failure.interrupted.message')
              : failureText.message}
          </span>
        </div>
        {recoveryAvailable ? (
          <Button
            data-testid="turn-continue"
            disabled={continuing || continueUnknown}
            loading={continuing}
            loadingIcon={<Spinner imageSrc={aiThinking} size="sm" aria-hidden="true" />}
            onClick={() => void onContinue(item)}
            size="sm"
            variant="outline"
          >
            {continueUnknown ? t('stream.continuePending') : t('stream.continueInterrupted')}
          </Button>
        ) : null}
        {actionError ? (
          <span
            className="col-span-full break-words text-[var(--vds-error-text-primary)]"
            data-testid="turn-continue-error"
          >
            {actionError}
          </span>
        ) : null}
      </div>
    )
  }
  return (
    <Card
      className="mb-[var(--vds-space-5)] grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-[var(--vds-space-2)] gap-y-[var(--vds-space-2)] border border-solid border-[var(--vds-error-light-border)] !bg-[var(--vds-error-light-bg-default)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] [--vds-card-radius:var(--vds-radius-6)]"
      data-testid="turn-failure-card"
      padding="none"
      role="alert"
      variant="tinted"
    >
      <div className="flex min-w-0 items-center gap-[var(--vds-space-1)]">
        <IconFont
          type="fill-status-error"
          aria-hidden="true"
          className="shrink-0 text-[length:var(--vds-icon-8)] text-[var(--vds-error-bg-default)]"
        />
        <h5 className="m-0 text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-error-bg-default)]">
          {failureText.title}
        </h5>
      </div>
      {item.runtimeAction === 'continue_turn' &&
      (authenticationFailed ? onRepair : recoveryAvailable) ? (
        <Button
          data-testid="turn-continue"
          disabled={!recoveryAvailable || continuing || continueUnknown || authenticationChecking}
          loading={continuing || authenticationChecking}
          loadingIcon={<Spinner imageSrc={aiThinking} size="sm" aria-hidden="true" />}
          onClick={() => {
            if (authenticationFailed) void onRepair?.(true)
            else void onContinue(item)
          }}
          size="sm"
          variant="outline"
        >
          {continueUnknown
            ? t('stream.continuePending')
            : authenticationFailed
              ? t('stream.continueInterrupted')
              : t('stream.retry')}
        </Button>
      ) : null}
      {failureDescription ? (
        <p
          data-testid="turn-failure-description"
          className="col-span-2 m-0 min-w-0 whitespace-pre-wrap break-words text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-secondary)]"
        >
          {failureDescription}
        </p>
      ) : null}
      {authenticationFailed && onRepair ? (
        <Button
          className="col-span-2 justify-self-start"
          data-testid="turn-authentication-repair"
          disabled={authenticationChecking}
          onClick={() => void onRepair?.(false)}
          size="sm"
          variant="ghost"
        >
          {authenticationAction === 'login'
            ? conversation('failure.auth.login')
            : conversation('failure.auth.configure')}
        </Button>
      ) : null}
      {authenticationCheckFailed ? (
        <p className="col-span-2 m-0 text-[var(--vds-error-text-primary)]" role="status">
          {t('composer.checkFailed')}
        </p>
      ) : null}
      {actionError ? (
        <div
          className="col-span-2 text-[length:var(--vds-font-body-lv1)] text-[var(--vds-error-text-primary)]"
          data-testid={
            item.runtimeAction === 'continue_turn'
              ? 'turn-continue-error'
              : 'turn-unknown-confirm-error'
          }
        >
          {actionError}
        </div>
      ) : null}
      {children}
    </Card>
  )
}
