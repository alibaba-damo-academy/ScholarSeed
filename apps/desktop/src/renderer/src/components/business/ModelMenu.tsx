import { modelDisabledReason, modelDisplayLabels } from './profile'
import { feedback } from '../../contracts/feedback'
import React from 'react'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'

import {
  getModels,
  ModelInfo,
  setDefaultModel,
  setSessionModel
} from '../../api'
import {
  effectiveSessionModelKey,
  hasSelectableModel,
  personalModelId
} from '../../catalog'
import { Icon } from '../../icons'
import { modelDefaultEffort } from '../../reasoning'
import { useApp } from '../../store'
import {
  Button,
  EllipsisText,
  Popover,
  PopoverContent,
  PopoverTrigger
} from '../ui'
import IconFont from '../primitive'
import { useEffort } from './Effort'

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
    'mb-[var(--vds-space-1)] flex min-h-[36px] w-full items-center gap-[var(--vds-space-2)] rounded-[7px] border-0 px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-left text-[14px]',
    selected
      ? 'bg-[var(--vds-brand-light-bg-default)]'
      : 'bg-transparent hover:bg-[var(--vds-bg-gray-hover-transparent)]',
    disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
    'transition-[background-color] duration-150'
  ].join(' ')
const MODEL_CHIP_CLASS = [
  'group flex min-h-8 items-center justify-between gap-[6px] rounded-[8px] border-0 bg-transparent px-[12px] py-[5px]',
  'text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)]',
  'hover:bg-[var(--vds-surface-hover)] focus-visible:bg-[var(--vds-surface-hover)]'
].join(' ')
const MODEL_CHIP_FRAME_CLASS = 'relative min-w-0 flex-[0_1_auto]'
// 单弹窗卡片携带圆角抬升表面; 思考强度展开时右侧再并排一张二级卡片。
const MENU_SHEET_CLASS = [
  'flex flex-col rounded-[var(--vds-radius-4)] bg-[var(--vds-surface-raised)]',
  'shadow-[var(--vds-shadow-2-center)]'
].join(' ')
const MENU_ENTRY_CLASS = (active: boolean, disabled: boolean): string =>
  [
    'flex min-h-8 w-full items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] border-0 px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-left',
    'text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)]',
    active ? 'bg-[var(--vds-surface-hover)]' : 'bg-transparent hover:bg-[var(--vds-surface-hover)]',
    disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
    'transition-[background,color] duration-[120ms]'
  ].join(' ')
// 模型列表在单弹窗内自己滚动: 最大高度 300px, 超出滚动; 下方强度/管理入口钉住不滚走。
const MODEL_MENU_LIST_CLASS =
  'max-h-[300px] min-h-0 overflow-y-auto overscroll-contain'
// 单弹窗 PopoverContent 被抬到 modal 层(!z-modal+1), portal tooltip 默认的 z-tooltip
// 会被整张弹窗盖住; 菜单内溢出 tooltip 的内容层再抬一级才能浮在弹窗之上。
const MODEL_MENU_TOOLTIP_CONTENT_CLASS = '!z-[calc(var(--vds-z-modal)+2)]'
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
      <EllipsisText
        wrapperClassName="flex-1"
        className={`text-[length:var(--vds-font-body-lv1)] font-medium leading-relaxed ${selected ? 'text-[var(--vds-brand-bg-default)]' : 'text-[var(--vds-text-primary)]'}`}
        tooltipContentClassName={MODEL_MENU_TOOLTIP_CONTENT_CLASS}
        tooltipPortalled
      >
        {modelDisplayLabels(model, account).label}
      </EllipsisText>
      {trailing}
      <span className="flex w-[18px] shrink-0 items-center justify-center" aria-hidden>
        {selected ? (
          <Check className="text-[var(--vds-brand-bg-default)]" size={18} strokeWidth={1.8} />
        ) : null}
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
  const effort = useEffort()
  const [submenu, setSubmenu] = React.useState<'effort' | null>(null)
  const selectedModelKey = effectiveSessionModelKey(
    models,
    state.model,
    state.activeSession,
    state.threads
  )
  const selectedModel = models.find((model) => model.key === selectedModelKey)
  // 一个可选模型都没有时（未登录且未配置自有连接），持久化的默认键即使还指向某个置灰行,
  // 也不该再把它当「当前模型」展示: 按钮回到「选择模型」, 灰行上也不留选中标记。
  const modelAvailable = hasSelectableModel(models)
  // 未选择模型(无可选模型, 或默认键未命中任何可选行, 如登出后仅剩置灰行): 强度入口
  // 整体禁用、回显占位符并隐藏其上方分割线。目录里的置灰行不算当前模型。
  const hasCurrentModel = modelAvailable && Boolean(selectedModel)
  // 选中的模型可能已不在目录里(用户在模型管理里关掉了它的显示、停用了那条连接, 或删了它)。
  // 此时**不自动换成别的模型** —— 如实标不可用, 由用户决定。渲染必须走模型段而不是整串,
  // 否则复合 key 会以 `personal-<hex>:<model>` 的形态泄漏成用户可见文案。
  const unavailableModelId = selectedModel
    ? ''
    : personalModelId(selectedModelKey)
  const selectedLabel = !modelAvailable
    ? t('models.choose')
    : (selectedModel && modelDisplayLabels(selectedModel, account).label) ||
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
  const controlsRef = React.useRef<HTMLDivElement | null>(null)
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
    const selected = panelRef.current?.querySelector<HTMLElement>('[data-selected="true"]')
    selected?.scrollIntoView({ block: 'nearest' })
    controlsRef.current?.focus()
  }, [state.modelMenuOpen, selectedModelKey, submenu])

  const selectModel = async (model: ModelInfo): Promise<void> => {
    if (switching.current) return
    setSubmenu(null)
    set({ modelMenuOpen: false })
    if (model.key === selectedModelKey) return
    const sessionId = state.activeSession
    switching.current = true
    setPending({ sessionId, model: { ...model } })
    try {
      if (sessionId) {
        const previousEffort =
          state.threads[sessionId]?.runtime?.reasoning_effort ?? ''
        // 「模型默认」伪档位已去除：旧档位不被新模型支持时，显式回落到新模型定义的
        // 确定默认档（未声明默认时取最低档），不再发空档让 provider 决定。
        const effort = model.reasoning_efforts?.includes(previousEffort)
          ? previousEffort
          : modelDefaultEffort(model)
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
            previousEffort && effort !== previousEffort
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
      onOpenChange={(open) => {
        if (open) setSubmenu(null)
        set({ modelMenuOpen: open })
      }}
    >
      <div className={MODEL_CHIP_FRAME_CLASS}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            data-testid="model-selector-toggle"
            className={`${MODEL_CHIP_CLASS} w-full overflow-hidden ${compact ? 'min-h-8 !border-transparent !bg-transparent hover:!bg-[var(--vds-other-overlay-1)]' : ''}`}
            size="content"
            unstyled
            disabled={Boolean(pending)}
            aria-busy={Boolean(pendingHere) || effort.pending}
            title={
              pendingHere
                ? t('models.switchingTo', { model: modelDisplayLabels(pendingHere.model, account).label })
                : `${selectedLabel} · ${hasCurrentModel ? effort.label : '-'}`
            }
            aria-expanded={state.modelMenuOpen}
          >
            <span
              className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left text-[var(--text)]"
              title={unavailableModelId ? t('models.reenable') : undefined}
            >
              {pendingHere ? t('models.switching') : selectedLabel}
            </span>
            <span className="shrink-0 text-[var(--vds-text-tertiary)]">
              {hasCurrentModel ? effort.label : '-'}
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
          align="end"
          aria-label={t('models.selection')}
          className="!z-[calc(var(--vds-z-modal)+1)] !flex !items-end !gap-[var(--vds-space-2)] !max-w-[calc(100vw_-_var(--vds-space-6))] !rounded-none !bg-transparent !p-0 !shadow-none"
        >
          <div
            ref={controlsRef}
            tabIndex={-1}
            role="menu"
            aria-label={t('models.selection')}
            data-testid="model-selector-menu"
            className={`${MENU_SHEET_CLASS} w-[var(--vds-model-menu-width)] p-[var(--vds-space-1)]`}
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
                            selected={modelAvailable && model.key === selectedModelKey}
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
                      selected={modelAvailable && model.key === selectedModelKey}
                      onSelect={(picked) => void selectModel(picked)}
                      trailing={
                        <EllipsisText
                          wrapperClassName="max-w-[40%] shrink-0"
                          className="text-[length:var(--vds-font-caption)] text-[var(--vds-text-tertiary)]"
                          tooltipContentClassName={MODEL_MENU_TOOLTIP_CONTENT_CLASS}
                          tooltipPortalled
                        >
                          {modelDisplayLabels(model, account).providerLabel || (model.source === 'personal' ? t('models.personal') : model.provider || t('models.builtin'))}
                        </EllipsisText>
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
            <div aria-hidden="true" className="mx-[var(--vds-space-2)] my-[var(--vds-space-1)] h-px shrink-0 bg-[var(--vds-divider-default)]" />
            <Button
              type="button"
              role="menuitem"
              data-testid="model-effort-row"
              size="content"
              unstyled
              className={MENU_ENTRY_CLASS(submenu === 'effort', !hasCurrentModel || !effort.selectable)}
              disabled={!hasCurrentModel || !effort.selectable || effort.pending || Boolean(pending)}
              aria-haspopup="menu"
              aria-expanded={submenu === 'effort'}
              aria-busy={effort.pending}
              onClick={() => setSubmenu(submenu === 'effort' ? null : 'effort')}
            >
              <span className="min-w-0 flex-1 text-left">{t('models.effortRow')}</span>
              <span className="shrink-0 text-[var(--vds-text-tertiary)]">
                {hasCurrentModel && effort.selectable ? effort.label : '-'}
              </span>
              <span className="inline-flex size-3 shrink-0 items-center justify-center text-[var(--text-3)]">
                <Icon name="chevron-right" size={12} />
              </span>
            </Button>
            <div aria-hidden="true" className="mx-[var(--vds-space-2)] my-[var(--vds-space-1)] h-px shrink-0 bg-[var(--vds-divider-default)]" />
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
              <span className="min-w-0 flex-1">{t('models.manage')}</span>
              <span className="inline-flex size-3 shrink-0 items-center justify-center text-[var(--text-3)]">
                <Icon name="chevron-right" size={12} />
              </span>
            </Button>
          </div>

          {submenu === 'effort' ? (
            <div
              role="menu"
              aria-label={t('models.effortRow')}
              data-testid="model-effort-menu"
              className={`${MENU_SHEET_CLASS} w-[var(--vds-model-menu-width)] p-[var(--vds-space-1)]`}
            >
              <div className="px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-caption)] leading-relaxed text-[var(--vds-text-tertiary)]">
                {t('models.effortHint')}
              </div>
              {effort.options.map((option) => {
                const selected = option.value === effort.value
                return (
                  <Button
                    key={option.value || 'default'}
                    type="button"
                    role="menuitem"
                    data-testid={`model-effort-option-${option.value || 'default'}`}
                    size="content"
                    unstyled
                    className={MODEL_ROW_CLASS(selected, effort.pending || Boolean(pending))}
                    aria-disabled={effort.pending || Boolean(pending)}
                    onClick={() => {
                      setSubmenu(null)
                      void effort.select(option.value)
                    }}
                  >
                    <span className="min-w-0 flex-1 whitespace-nowrap text-[length:var(--vds-font-body-lv1)] font-medium leading-relaxed text-[var(--vds-text-primary)]">
                      {option.label}
                    </span>
                    <span className="w-4 shrink-0 text-center text-[var(--vds-brand-text-primary)]" aria-hidden>
                      {selected ? '✓' : ''}
                    </span>
                  </Button>
                )
              })}
            </div>
          ) : null}

        </PopoverContent>
      </div>
    </Popover>
  )
}
