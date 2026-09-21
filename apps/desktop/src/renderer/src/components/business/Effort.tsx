import { useTranslation } from 'react-i18next'
import React from 'react'

import { getSessionModel, requestFailureFeedback, setSessionModel } from '../../api'
import { selectedSessionModelKey } from '../../catalog'
import {
  DEFAULT_REASONING_EFFORT,
  reasoningLabel,
  reasoningPreference
} from '../../reasoning'
import { feedback } from '../../contracts/feedback'
import { useApp } from '../../store'
import { Slider } from '../ui'

/** Model parameter scoped to a session; remembered separately for new conversations. */
export function useEffort() {
  const { t } = useTranslation('conversation')
  const { state, set, patchThread } = useApp()
  const sessionId = state.activeSession
  const modelKey = selectedSessionModelKey(
    state.model,
    sessionId,
    state.threads
  )
  const model = state.catalog.models.find((item) => item.key === modelKey) ||
    state.catalog.models.find((item) =>
      item.model_name === modelKey || item.model_id === modelKey ||
      item.key.endsWith(`:${modelKey}`)
    )
  const runtime = sessionId ? state.threads[sessionId]?.runtime : undefined
  const running = Boolean(sessionId && state.threads[sessionId]?.running)
  const value = sessionId
    ? (runtime?.reasoning_effort ?? DEFAULT_REASONING_EFFORT)
    : reasoningPreference(model, state.reasoningPreferences)
  const declaredEfforts = model?.reasoning_efforts ??
    (model?.reasoning_options ?? [])
      .flatMap((option) => option.values ?? [])
  const efforts = declaredEfforts
  const reasoningOptions = model?.reasoning_options ?? []
  const reasoningSupported = model?.reasoning?.supported ??
    (reasoningOptions.length > 0 || efforts.length > 0)
  const fixedThinking = reasoningSupported && reasoningOptions.length === 0 && efforts.length === 0
  const [pending, setPending] = React.useState(false)
  const switching = React.useRef(false)
  const unavailable =
    !model || (!reasoningSupported && !value)

  React.useEffect(() => {
    if (!sessionId || pending) return
    let alive = true
    void getSessionModel(sessionId).then((result) => {
      if (!alive || !result?.runtime || switching.current) return
      patchThread(sessionId, (thread) => ({
        runtime: { name: 'codex', ...thread.runtime, ...result.runtime }
      }))
    })
    return () => {
      alive = false
    }
  }, [sessionId, running, modelKey, pending])

  async function select(effort: string): Promise<void> {
    if (switching.current || effort === value) return
    switching.current = true
    setPending(true)
    try {
      if (sessionId) {
        const result = await setSessionModel(sessionId, modelKey, effort)
        if (result?.runtime) {
          patchThread(sessionId, (thread) => ({
            runtime: { name: 'codex', ...thread.runtime, ...result.runtime }
          }))
        }
        if (!result?.ok) {
          set({
            foregroundError:
              result?.applicationFailure ? requestFailureFeedback(result.applicationFailure) : result?.detail || result?.error || feedback('shell', 'foreground.effortFailed')
          })
          return
        }
      }
      set((current) => ({
        foregroundError: null,
        reasoningPreferences: {
          ...current.reasoningPreferences,
          [modelKey]: effort
        }
      }))
    } finally {
      switching.current = false
      setPending(false)
    }
  }

  const selectedLabel = reasoningLabel(value, t, true)
  const options = [
    {
      value: DEFAULT_REASONING_EFFORT,
      label: t('reasoning.default')
    },
    ...efforts.map((effort) => ({
      value: effort,
      label: reasoningLabel(effort, t)
    })),
    ...(value && !efforts.includes(value)
      ? [{ value, label: t('reasoning.unavailable', { value }) }]
      : [])
  ].filter(
    (option, index, all) =>
      all.findIndex((item) => item.value === option.value) === index
  )

  return {
    value,
    options,
    label: fixedThinking ? t('reasoning.fixed') : selectedLabel,
    disabled: Boolean(unavailable || fixedThinking),
    pending,
    select
  }
}

interface EffortProps {
  value: string
  options: { value: string; label: string }[]
  disabled: boolean
  pending?: boolean
  onSelect: (value: string) => void
}

export function Effort({ value, options, disabled, pending = false, onSelect }: EffortProps): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const [draft, setDraft] = React.useState(value)
  const draftRef = React.useRef(value)
  React.useEffect(() => {
    if (pending) return
    draftRef.current = value
    setDraft(value)
  }, [value, pending])
  const index = Math.max(0, options.findIndex((option) => option.value === draft))
  const max = Math.max(0, options.length - 1)
  const commit = (): void => {
    if (!disabled && !pending && draftRef.current !== value) onSelect(draftRef.current)
  }
  return (
    <div
      className="relative w-full"
      onPointerUp={commit}
      onKeyUp={commit}
      onBlur={commit}
      onPointerCancel={() => {
        draftRef.current = value
        setDraft(value)
      }}
    >
      <Slider
        data-testid="reasoning-slider"
        aria-label={t('reasoning.label')}
        aria-valuetext={options[index]?.label}
        aria-busy={pending}
        min={0}
        max={max}
        step={1}
        value={index}
        disabled={disabled || max === 0}
        onValueChange={(next: number) => {
          if (pending) return
          const option = options[next]
          if (!option) return
          draftRef.current = option.value
          setDraft(option.value)
        }}
      />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-between">
        {options.map((option) => (
          <span key={option.value} className="size-[var(--vds-space-1)] rounded-full bg-[var(--vds-text-tertiary)]" />
        ))}
      </div>
    </div>
  )
}
