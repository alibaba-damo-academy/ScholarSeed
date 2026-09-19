import { modelDisabledReason, modelDisplayLabels } from './profile'
import { feedback } from '../../contracts/feedback'
import React from 'react'
import { useTranslation } from 'react-i18next'

import {
  getModels,
  ModelInfo,
  runCommand,
  setDefaultModel,
  setSessionModel
} from '../../api'
import { personalModelId, selectedSessionModelKey } from '../../catalog'
import { Icon } from '../../icons'
import { useApp } from '../../store'
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger
} from '../ui'
import IconFont from '../primitive'

// ModelMenu.tsx — the model picker, anchored under the composer control row
// (PRD 2.1.2 modification 1). It keeps the three catalogue groups the product
// needs: local CLI subscriptions with login
// guidance, then built-in and personal-API models.
//
// The catalogue itself lives in the store, so this menu and the settings
// panel's connection section always render the same truth. Subscription group
// names and their order come from the backend (`subscription_groups`) rather
// than a constant table here — adding a subscription provider is a catalogue
// change, not a UI change.

const MODEL_ROW_CLASS = (selected: boolean, disabled: boolean): string =>
  [
    'mb-[var(--vds-space-1)] flex min-h-8 w-full items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] border-0 px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-left',
    selected
      ? 'bg-[var(--vds-bg-white-active)]'
      : 'bg-transparent hover:bg-[var(--vds-bg-white-hover)]',
    disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
    'transition-[background,color,border-color] duration-[120ms]'
  ].join(' ')
const MODEL_CHIP_CLASS = [
  'group flex min-h-8 items-center justify-between gap-[6px] rounded-[8px] border-0 bg-transparent px-[12px] py-[5px]',
  'text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)]',
  'hover:bg-[var(--vds-surface-hover)] focus-visible:bg-[var(--vds-surface-hover)]'
].join(' ')
// 触发器外框宽度: 跟随内容宽度, 紧凑态(AI 面板)以 160px 收口、完整态以 180px 收口,
// 工具栏够宽时不再被固定宽度提前截断; 收窄时仍可压缩, 由内部标签走 ellipsis。
const MODEL_CHIP_FRAME_CLASS = (compact: boolean): string =>
  [
    'relative min-w-0 flex-[0_1_auto]',
    compact ? 'max-w-[160px]' : 'max-w-[180px]'
  ].join(' ')
const MODEL_MENU_PANEL_CLASS = [
  // 宽度跟随目录内容收口, 上限仍是原来的 320px 与视口边距的较小者: 短模型名不再撑出
  // 大片空白, 长个人模型标签照旧在上限内换行。
  '!z-[calc(var(--vds-z-modal)+1)] !flex !w-fit max-w-[var(--vds-model-menu-max-width)] flex-col',
  'max-h-[min(270px,36vh)]',
  'rounded-[var(--vds-radius-4)] bg-[var(--vds-surface-raised)] p-[var(--vds-space-2)] shadow-[var(--vds-shadow-2-center)]'
].join(' ')
// 模型列表自己滚动, 底部「模型管理」入口钉在面板下沿, 不跟着列表滚走。
const MODEL_MENU_LIST_CLASS = 'min-h-0 flex-1 overflow-y-auto overscroll-contain'
const MODEL_MENU_MANAGE_CLASS = [
  'flex w-full items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] border-0 bg-transparent',
  'px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-left',
  'text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]',
  'hover:bg-[var(--vds-bg-white-hover)] focus-visible:bg-[var(--vds-bg-white-hover)]',
  'transition-[background,color] duration-[120ms]'
].join(' ')

function ModelRow({
  model,
  selected,
  onSelect,
  trailing
}: {
  model: ModelInfo
  selected: boolean
  onSelect: (model: ModelInfo) => void
  trailing?: React.ReactNode
}): React.JSX.Element {
  const { t: account } = useTranslation('account')
  return (
    <Button
      type="button"
      role="menuitem"
      data-testid={`model-option-${model.key}`}
      data-selected={selected ? 'true' : undefined}
      className={MODEL_ROW_CLASS(selected, Boolean(model.disabled))}
      size="content"
      unstyled
      onClick={() => !model.disabled && onSelect(model)}
      title={model.disabled ? modelDisabledReason(model, account) : undefined}
    >
      <span className="min-w-0 flex-1 whitespace-normal break-words text-[length:var(--vds-font-body-lv1)] font-medium leading-relaxed text-[var(--vds-text-primary)]">
        {modelDisplayLabels(model, account).label}
      </span>
      {trailing}
      <span
        className="w-4 shrink-0 text-center text-[var(--vds-brand-text-primary)]"
        aria-hidden
      >
        {selected ? '✓' : ''}
      </span>
    </Button>
  )
}

/** The shared menu owns portal positioning, viewport collision and dismissal. */
export function ModelMenu({
  compact = false
}: {
  compact?: boolean
}): React.JSX.Element {
  const { state, set, act, patchThread } = useApp()
  const { t } = useTranslation('components')
  const { t: account } = useTranslation('account')
  const { models, subscriptionGroups } = state.catalog
  const selectedModelKey = selectedSessionModelKey(
    state.model,
    state.activeSession,
    state.threads
  )
  const selectedModel = models.find((model) => model.key === selectedModelKey)
  // 选中的模型可能已不在目录里(用户在模型管理里关掉了它的显示、停用了那条连接, 或删了它)。
  // 此时**不自动换成别的模型** —— 如实标不可用, 由用户决定。渲染必须走模型段而不是整串,
  // 否则复合 key 会以 `personal-<hex>:<model>` 的形态泄漏成用户可见文案。
  const unavailableModelId = selectedModel
    ? ''
    : personalModelId(selectedModelKey)
  const selectedLabel =
    (selectedModel && modelDisplayLabels(selectedModel, account).label) ||
    (unavailableModelId &&
      t('models.unavailable', { model: unavailableModelId })) ||
    (compact ? t('models.choose') : '—')
  const subscriptionModels = React.useMemo(
    () => models.filter((model) => model.billing === 'subscription' && model.source !== 'builtin'),
    [models]
  )
  const apiModels = React.useMemo(
    () => models.filter((model) => model.billing !== 'subscription'),
    [models]
  )
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const switching = React.useRef(false)
  const [pending, setPending] = React.useState<{
    sessionId: string | null
    model: ModelInfo
  } | null>(null)
  const pendingHere =
    pending?.sessionId === state.activeSession ? pending : null

  // Subscription groups render first, so once a subscription is logged in the api models
  // sit below the capped popover's fold. Opening at the top would leave the active model
  // off-screen, so open at the selection instead of making the user hunt for it.
  React.useEffect(() => {
    if (!state.modelMenuOpen) return
    panelRef.current
      ?.querySelector<HTMLElement>('[data-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [state.modelMenuOpen, selectedModelKey])

  const selectModel = async (model: ModelInfo): Promise<void> => {
    if (switching.current) return
    set({ modelMenuOpen: false })
    if (model.key === selectedModelKey) return
    const sessionId = state.activeSession
    switching.current = true
    setPending({ sessionId, model: { ...model } })
    try {
      if (sessionId) {
        const previousEffort =
          state.threads[sessionId]?.runtime?.reasoning_effort ?? ''
        const effort = model.reasoning_efforts?.includes(previousEffort)
          ? previousEffort
          : ''
        const result = await setSessionModel(sessionId, model.key, effort)
        if (result?.runtime || (result?.ok && result.model_id)) {
          patchThread(sessionId, (thread) => ({
            runtime: {
              name: 'codex',
              ...thread.runtime,
              ...result.runtime,
              model_id: result.model_id
            }
          }))
        }
        if (!result?.ok || !result.model_id) {
          set({
            foregroundError:
              result?.detail || result?.error || feedback('components', 'models.failed'),
            foregroundNotice: result?.deferred ? feedback('conversation', 'models.deferred') : null
          })
          return
        }
        set({
          foregroundError: null,
          foregroundNotice:
            previousEffort && !effort
              ? feedback('conversation', 'models.effortReset')
              : result.deferred
                ? feedback('conversation', 'models.nextTurn')
                : null
        })
        return
      }
      // 个人模型与内置模型的选中态已归一: 都是把这个 key 记成默认选择, 不再有
      // "激活某条连接"这回事。
      const result = await setDefaultModel(model.key)
      act.applyModelCatalog(result)
      if (!result?.current_model) set({ foregroundError: feedback('components', 'models.failed') })
    } catch {
      set({ foregroundError: feedback('components', 'models.retryFailed') })
    } finally {
      switching.current = false
      setPending(null)
    }
  }

  const recheckSubscription = async (): Promise<void> => {
    act.applyModelCatalog(await getModels(true))
  }

  return (
    <Popover
      open={state.modelMenuOpen}
      onOpenChange={(open) => set({ modelMenuOpen: open })}
    >
      <div className={MODEL_CHIP_FRAME_CLASS(compact)}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            data-testid="model-selector-toggle"
            className={`${MODEL_CHIP_CLASS} w-full overflow-hidden ${compact ? 'min-h-8 !border-transparent !bg-transparent hover:!bg-[var(--vds-other-overlay-1)]' : ''}`}
            size="content"
            unstyled
            disabled={Boolean(pending)}
            aria-busy={Boolean(pendingHere)}
            title={
              pendingHere
                ? t('models.switchingTo', { model: modelDisplayLabels(pendingHere.model, account).label })
                : t('models.selection')
            }
            aria-expanded={state.modelMenuOpen}
          >
            {!compact && (
              <span className="text-[var(--text-3)]">{t('models.name')}</span>
            )}
            <span
              className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left text-[var(--text)]"
              title={unavailableModelId ? t('models.reenable') : undefined}
            >
              {pendingHere ? t('models.switching') : selectedLabel}
            </span>
            <span className="inline-flex size-3 shrink-0 items-center justify-center text-[var(--text-3)]">
              <IconFont
                type="icon-a-line-switch-arrow-down-s"
                className="flex-none text-[14px] leading-none text-[var(--vds-text-tertiary)]"
              />
            </span>
          </Button>
        </PopoverTrigger>

        <PopoverContent
          aria-label={t('models.selection')}
          data-testid="model-selector-menu"
          className={MODEL_MENU_PANEL_CLASS}
        >
          <div ref={panelRef} className={MODEL_MENU_LIST_CLASS}>
            {subscriptionModels.length > 0 && (
              <>
                {subscriptionGroups.map(({ provider, label }) => {
                  const group = subscriptionModels.filter(
                    (model) => model.provider === provider
                  )
                  if (group.length === 0) return null
                  const blocked = group.filter((model) => model.disabled)
                  return (
                    <div key={provider} className="mb-[var(--vds-space-1)]">
                      <div className="px-[10px] pb-[2px] pt-[var(--vds-space-1)] text-[10px] font-[var(--vds-fw-medium)] text-[var(--text-3)]">
                        {label}
                      </div>
                      {blocked.length > 0 && (
                        <div className="mb-[var(--vds-space-2)] flex items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] border border-[var(--border-soft)] bg-[var(--bg-3)] px-[10px] py-[var(--vds-space-2)] text-[11px] leading-[1.35] text-[var(--text-3)]">
                          <span className="flex-1">
                            {modelDisabledReason(blocked[0], account)}
                          </span>
                          <Button
                            type="button"
                            size="content"
                            unstyled
                            className="rounded-[var(--vds-radius-2)] border border-[var(--border)] bg-[var(--bg-2)] px-[var(--vds-space-2)] py-[var(--vds-space-1)] text-[10.5px] text-[var(--text-2)] transition-[background,color,border-color] duration-[120ms] hover:bg-[var(--vds-bg-white-hover)]"
                            onClick={() => void recheckSubscription()}
                          >
                            {t('models.recheck')}
                          </Button>
                        </div>
                      )}
                      {group.map((model) => (
                        <ModelRow
                          key={model.key}
                          model={model}
                          selected={model.key === selectedModelKey}
                          onSelect={(picked) => void selectModel(picked)}
                        />
                      ))}
                    </div>
                  )
                })}
              </>
            )}

            {apiModels.length > 0 && (
              <>
                {apiModels.map((model) => (
                  <ModelRow
                    key={model.key}
                    model={model}
                    selected={model.key === selectedModelKey}
                    onSelect={(picked) => void selectModel(picked)}
                    trailing={
                      <span className="max-w-[40%] whitespace-normal break-words text-[length:var(--vds-font-caption)] text-[var(--vds-text-tertiary)]">
                        {modelDisplayLabels(model, account).providerLabel || (model.source === 'personal' ? t('models.personal') : model.provider || t('models.builtin'))}
                      </span>
                    }
                  />
                ))}
              </>
            )}

            {models.some((model) => model.source === 'personal') && (
              <div className="px-[10px] pb-[var(--vds-space-1)] pt-[6px] text-[9.5px] leading-[1.35] text-[var(--text-3)]">
                {t('models.effect')}
              </div>
            )}
            {models.length === 0 && (
              <div className="px-[10px] py-[var(--vds-space-2)] text-[11px] text-[var(--text-3)]">
                {t('models.empty')}
              </div>
            )}
          </div>
          <div className="mt-[var(--vds-space-1)] border-t border-[var(--border-soft)] pt-[var(--vds-space-1)]">
            <Button
              type="button"
              role="menuitem"
              data-testid="model-menu-manage"
              className={MODEL_MENU_MANAGE_CLASS}
              size="content"
              unstyled
              onClick={() => {
                set({ modelMenuOpen: false })
                act.openSettings('models')
              }}
            >
              <span className="flex-none text-[var(--vds-text-tertiary)]">
                <Icon name="settings" size={14} />
              </span>
              <span className="min-w-0 flex-1">{t('models.manage')}</span>
            </Button>
          </div>
        </PopoverContent>
      </div>
    </Popover>
  )
}
