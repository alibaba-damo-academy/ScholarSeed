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
import { Button, Popover, PopoverContent, PopoverTrigger } from '../ui'
import { IconFont } from '../primitive'

/** Model parameter scoped to a session; remembered separately for new conversations. */
export function Effort(): React.JSX.Element {
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
  const [menuOpen, setMenuOpen] = React.useState(false)
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

  const selectedLabel = reasoningLabel(value, t)
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

  return (
    // 与模型选择器同一套宽度逻辑: 跟随内容宽度, 以 160px 收口, 空间不足时压缩并截断。
    <div className="min-w-0 flex-[0_1_auto] max-w-[160px]">
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            data-testid="reasoning-selector"
            aria-label={t('reasoning.label')}
            aria-haspopup="listbox"
            disabled={Boolean(unavailable || pending || fixedThinking)}
            variant="ghost"
            size="content"
            unstyled
            className="group flex min-h-8 w-full items-center justify-between gap-[12px] rounded-[8px] border-0 bg-transparent px-[12px] py-[5px] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)] transition-colors duration-[var(--vds-duration-fast)] hover:bg-[var(--vds-other-overlay-1)] focus-visible:bg-[var(--vds-surface-hover)]"
          >
            <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">
              {fixedThinking
                ? t('reasoning.fixed')
                : t('reasoning.selected', { effort: selectedLabel })}
            </span>
            <IconFont
              aria-hidden="true"
              className="flex-none text-[14px] leading-none text-[var(--vds-text-tertiary)]"
              type="a-line-switch-arrow-down-s"
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="no-drag z-[var(--vds-z-popover)] min-w-[146px] gap-[var(--vds-space-1)] rounded-[var(--vds-radius-4)] p-[var(--vds-space-1)]"
          data-testid="reasoning-menu"
        >
          {options.map((option) => {
            const selected = option.value === value
            return (
              <Button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                variant="ghost"
                size="content"
                unstyled
                className={[
                  'flex min-h-8 w-full items-center rounded-[var(--vds-radius-3)] border-0 px-[var(--vds-space-3)] py-[var(--vds-space-1)] text-left text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)]',
                  selected
                    ? 'bg-[var(--vds-bg-white-active)]'
                    : 'bg-transparent hover:bg-[var(--vds-bg-white-hover)]'
                ].join(' ')}
                onClick={() => {
                  void select(option.value)
                  setMenuOpen(false)
                }}
              >
                {option.label}
              </Button>
            )
          })}
        </PopoverContent>
      </Popover>
    </div>
  )
}
