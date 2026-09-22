import { useTranslation } from 'react-i18next'
import React from 'react'

import { getSessionModel, requestFailureFeedback, setSessionModel } from '../../api'
import { effectiveSessionModelKey } from '../../catalog'
import {
  modelDefaultEffort,
  reasoningLabel,
  reasoningPreference
} from '../../reasoning'
import { feedback } from '../../contracts/feedback'
import { useApp } from '../../store'

/** Model parameter scoped to a session; remembered separately for new conversations. */
export function useEffort() {
  const { t } = useTranslation('conversation')
  const { state, set, patchThread } = useApp()
  const sessionId = state.activeSession
  const modelKey = effectiveSessionModelKey(
    state.catalog.models,
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
  // 「模型默认」伪档位已去除：会话运行时没上报档位（存量会话）时回显模型定义的确定默认档。
  const value = sessionId
    ? (runtime?.reasoning_effort || modelDefaultEffort(model))
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
    // 模型是否声明了可选思考档位: 无档位时菜单的思考强度入口禁用并回显占位符。
    selectable: Boolean(model) && efforts.length > 0,
    disabled: Boolean(unavailable || fixedThinking),
    pending,
    select
  }
}

