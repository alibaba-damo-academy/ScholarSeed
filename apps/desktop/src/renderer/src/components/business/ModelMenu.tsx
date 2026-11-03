import type { TFunction } from 'i18next'
import { modelDisabledReason, modelDisabledTag, modelDisplayLabels } from './profile'
import { feedback } from '../../contracts/feedback'
import React from 'react'
import { useTranslation } from 'react-i18next'
import { Brain, Check } from 'lucide-react'

import type { ModelInfo } from '../../api'
import {
  currentRuntimeReconfiguration,
  getModels,
  setDefaultModel,
  setSessionModel,
} from '../../api'
import { effectiveSessionModelKey, hasSelectableModel, personalModelId } from '../../catalog'
import { Icon } from '../../icons'
import {
  confirmedReasoningSelection,
  declaredEffortValues,
  reasoningPreference,
} from '../../reasoning'
import { useApp } from '../../store'
import {
  Badge,
  Button,
  DropdownMenuArrow,
  EllipsisText,
  EmptyState,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../ui'
import IconFont from '../primitive'
import { useEffort } from './Effort'
import { HOST_CONFIGURATION_CONFLICT } from '../../../../reconfiguration'
import { PREPARATION_SUPERSEDED_ERROR } from '../../preparation'

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
    'mb-[var(--vds-space-1)] flex min-h-[var(--vds-control-height-standard)] w-full items-center gap-[var(--vds-space-2)] rounded-[var(--vds-model-menu-row-radius)] border-0 px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-left text-[length:var(--vds-font-body-lv2)]',
    selected
      ? 'bg-[var(--vds-brand-light-bg-default)]'
      : 'bg-transparent hover:bg-[var(--vds-bg-white-hover-transparent)]',
    disabled
      ? 'cursor-not-allowed opacity-[var(--vds-model-menu-disabled-opacity)]'
      : 'cursor-pointer',
    'transition-[background-color] duration-150',
  ].join(' ')
const MODEL_CHIP_CLASS = [
  'group flex min-h-8 items-center justify-between gap-[6px] rounded-[8px] border-0 bg-transparent px-[12px] py-[5px]',
  'text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)]',
  'hover:bg-[var(--vds-surface-hover)] focus-visible:bg-[var(--vds-surface-hover)]',
].join(' ')
const MODEL_CHIP_FRAME_CLASS = 'relative min-w-0 flex-[0_1_auto]'
// 单弹窗卡片携带圆角抬升表面; 思考强度展开时左侧再并排一张二级卡片 —— 二级卡在左,
// 弹窗行右缘恒为主菜单(锚定触发器), 展开/收起不会把主菜单推得左右移动。
const MENU_SHEET_CLASS = [
  'flex shrink-0 flex-col items-end overflow-hidden rounded-[var(--vds-radius-4)] bg-[var(--vds-surface-raised)]',
  'w-[var(--model-menu-measured-width)] shadow-[var(--vds-shadow-2-center)]',
  'transition-[width,opacity,visibility] duration-[var(--vds-duration-normal)] ease-[var(--vds-ease-standard)] motion-reduce:transition-none',
].join(' ')

const ModelMenuSheet = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { open?: boolean }
>(({ children, className = '', open = true, ...props }, ref) => {
  const contentRef = React.useRef<HTMLDivElement>(null)
  const [width, setWidth] = React.useState<number | null>(null)
  const setSheetRef = React.useCallback(
    (element: HTMLDivElement | null) => {
      if (element) element.inert = !open
      if (typeof ref === 'function') ref(element)
      else if (ref) ref.current = element
    },
    [open, ref]
  )

  React.useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return
    const measure = (): void => setWidth(content.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      {...props}
      ref={setSheetRef}
      aria-hidden={!open}
      className={`${MENU_SHEET_CLASS} ${open ? 'visible opacity-[var(--vds-opacity-full)]' : 'invisible opacity-0'} ${className}`}
      style={
        {
          '--model-menu-measured-width': open
            ? width === null
              ? 'max-content'
              : `${width}px`
            : '0px',
        } as React.CSSProperties
      }
    >
      <div
        ref={contentRef}
        className="flex w-max min-w-[min(var(--vds-model-menu-min-width),var(--model-menu-limit))] max-w-[var(--model-menu-limit)] flex-col p-[var(--vds-space-1)]"
      >
        {children}
      </div>
    </div>
  )
})
ModelMenuSheet.displayName = 'ModelMenuSheet'
// 提供商分组标题: 订阅组与 API/个人模型组共用 —— 与模型行同字号、三级灰、常规字重,
// 只靠颜色与行区分(设计参考: 下拉菜单分组标题)。
const MODEL_GROUP_HEADER_CLASS =
  'px-[var(--vds-space-3)] pb-[var(--vds-space-1)] pt-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]'

/** 模型行归属的分组标题: 有展示名用展示名, 否则个人连接/原始 provider/内置兜底。 */
function modelGroupLabel(
  model: ModelInfo,
  account: TFunction<'account'>,
  pick: TFunction<'components'>
): string {
  return (
    modelDisplayLabels(model, account).providerLabel ||
    (model.source === 'personal'
      ? pick('models.personal')
      : model.provider || pick('models.builtin'))
  )
}
const MENU_ENTRY_CLASS = (active: boolean, disabled: boolean): string =>
  [
    'flex min-h-[var(--vds-control-height-md)] w-full items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] border-0 px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-left',
    'text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)]',
    active
      ? 'bg-[var(--vds-bg-white-active-transparent)]'
      : 'bg-transparent hover:bg-[var(--vds-bg-white-hover-transparent)]',
    disabled ? 'cursor-not-allowed opacity-[var(--vds-opacity-menu-disabled)]' : 'cursor-pointer',
    'transition-[background,color] duration-[120ms]',
  ].join(' ')
// 模型列表在单弹窗内自己滚动: 最大高度 300px, 超出滚动; 下方强度/管理入口钉住不滚走。
const MODEL_MENU_LIST_CLASS =
  'max-h-[var(--vds-model-menu-list-max-height)] min-h-0 overflow-y-auto overscroll-contain'
// 单弹窗 PopoverContent 被抬到 modal 层(!z-modal+1), portal tooltip 默认的 z-tooltip
// 会被整张弹窗盖住; 菜单内溢出 tooltip 的内容层再抬一级才能浮在弹窗之上。
const MODEL_MENU_TOOLTIP_CONTENT_CLASS = '!z-[var(--vds-z-modal-nested-flyout)]'
const MODEL_MENU_MANAGE_CLASS = [
  'flex w-full items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] border-0 bg-transparent',
  'px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-left',
  'text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]',
  'hover:bg-[var(--vds-bg-white-hover-transparent)] focus-visible:bg-[var(--vds-bg-white-hover-transparent)]',
  'transition-[background,color] duration-[120ms]',
].join(' ')

function ModelRow({
  model,
  selected,
  onSelect,
  tag,
}: {
  model: ModelInfo
  selected: boolean
  onSelect: (model: ModelInfo) => void
  tag?: string
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
        className={`text-[length:var(--vds-font-body-lv2)] font-medium leading-[var(--vds-model-menu-line-height)] ${selected ? 'text-[var(--vds-brand-bg-default)]' : 'text-[var(--vds-text-primary)]'}`}
        tooltipContentClassName={MODEL_MENU_TOOLTIP_CONTENT_CLASS}
        tooltipPortalled
      >
        {modelDisplayLabels(model, account).label}
      </EllipsisText>
      {tag ? (
        <Badge size="sm" tone="neutral" className="shrink-0">
          {tag}
        </Badge>
      ) : null}
      <span className="flex w-[var(--vds-icon-9)] shrink-0 items-center justify-center" aria-hidden>
        {selected ? (
          <Check className="text-[var(--vds-brand-bg-default)]" size={18} strokeWidth={1.8} />
        ) : null}
      </span>
    </Button>
  )
}

/** The shared menu owns portal positioning, viewport collision and dismissal. */
export function ModelMenu({
  compact = false,
  iconOnly = false,
  independent = false,
  testIdPrefix = 'model',
  modelKey,
  onModelSelect,
  modelFilter,
  showEffort = true,
}: {
  compact?: boolean
  iconOnly?: boolean
  independent?: boolean
  testIdPrefix?: string
  modelKey?: string
  onModelSelect?: (model: ModelInfo) => void
  modelFilter?: (model: ModelInfo) => boolean
  showEffort?: boolean
}): React.JSX.Element {
  const {
    state,
    set,
    act,
    patchThread,
    getSnapshot,
    prepareModel,
    runModelSelection,
    rememberEffort,
  } = useApp()
  const { t } = useTranslation('components')
  const { t: account } = useTranslation('account')
  const { models, subscriptionGroups } = state.catalog
  const effort = useEffort()
  const [localOpen, setLocalOpen] = React.useState(false)
  const [submenu, setSubmenu] = React.useState<'effort' | null>(null)
  const menuOpen = independent ? localOpen : state.modelMenuOpen
  const setMenuOpen = (open: boolean): void => {
    if (independent) setLocalOpen(open)
    else set({ modelMenuOpen: open })
  }
  const sessionModelKey = effectiveSessionModelKey(
    models,
    state.model,
    state.activeSession,
    state.threads,
    state.draftModelId
  )
  const controlled = onModelSelect !== undefined
  const selectedModelKey = controlled ? (modelKey ?? '') : sessionModelKey
  const selectedModel = models.find((model) => model.key === selectedModelKey)
  const visibleModels = React.useMemo(
    () => (modelFilter ? models.filter(modelFilter) : models),
    [modelFilter, models]
  )
  // 一个可选模型都没有时（未登录且未配置自有连接），持久化的默认键即使还指向某个置灰行,
  // 也不该再把它当「当前模型」展示: 按钮回到「选择模型」, 灰行上也不留选中标记。
  const modelAvailable = hasSelectableModel(visibleModels)
  // 未选择模型(无可选模型, 或默认键未命中任何可选行, 如登出后仅剩置灰行): 强度入口
  // 整体禁用、回显占位符并隐藏其上方分割线。目录里的置灰行不算当前模型。
  const hasCurrentModel = modelAvailable && Boolean(selectedModel && !selectedModel.disabled)
  // 选中的模型可能已不在目录里(用户在模型管理里关掉了它的显示、停用了那条连接, 或删了它)。
  // 此时**不自动换成别的模型** —— 如实标不可用, 由用户决定。渲染必须走模型段而不是整串,
  // 否则复合 key 会以 `personal-<hex>:<model>` 的形态泄漏成用户可见文案。
  const unavailableModelId = selectedModel ? '' : personalModelId(selectedModelKey)
  const selectedLabel =
    controlled && selectedModel
      ? modelDisplayLabels(selectedModel, account).label
      : !modelAvailable
        ? t('models.choose')
        : (selectedModel && modelDisplayLabels(selectedModel, account).label) ||
          (unavailableModelId && t('models.unavailable', { model: unavailableModelId })) ||
          (compact ? t('models.choose') : '—')
  const subscriptionModels = React.useMemo(
    () =>
      visibleModels.filter(
        (model) => model.billing === 'subscription' && model.source !== 'builtin'
      ),
    [visibleModels]
  )
  const apiModels = React.useMemo(
    () => visibleModels.filter((model) => model.billing !== 'subscription'),
    [visibleModels]
  )
  // API/个人模型按提供商分组(与订阅组同口径): 归属信息交给组标题, 行内模型名整行
  // 铺开, 不再被右侧提供商副标签挤到只剩省略号。
  const apiModelGroups = React.useMemo(() => {
    const groups: { label: string; models: ModelInfo[] }[] = []
    for (const model of apiModels) {
      const label = modelGroupLabel(model, account, t)
      const group = groups.find((entry) => entry.label === label)
      if (group) group.models.push(model)
      else groups.push({ label, models: [model] })
    }
    return groups
  }, [apiModels, account, t])
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const controlsRef = React.useRef<HTMLDivElement | null>(null)
  const switching = React.useRef<string | null>(null)
  const [pending, setPending] = React.useState<{
    sessionId: string | null
    model: ModelInfo
  } | null>(null)
  const pendingHere = pending?.sessionId === state.activeSession ? pending : null

  // Subscription groups render first, so once a subscription is logged in the api models
  // sit below the capped popover's fold. Opening at the top would leave the active model
  // off-screen, so open at the selection instead of making the user hunt for it.
  React.useEffect(() => {
    if (!menuOpen) return
    const selected = panelRef.current?.querySelector<HTMLElement>('[data-selected="true"]')
    selected?.scrollIntoView({ block: 'nearest' })
    controlsRef.current?.focus()
  }, [menuOpen, selectedModelKey, submenu])

  const rememberModel = async (
    model: ModelInfo,
    selectionCurrent: () => boolean
  ): Promise<boolean> => {
    const result = await setDefaultModel(model.key)
    if (!selectionCurrent()) return false
    set({ model: model.key })
    if (result?.current_model !== model.key) {
      set({ foregroundError: feedback('components', 'models.defaultFailed') })
      return false
    }
    act.applyModelCatalog(result)
    return true
  }

  const selectModel = async (model: ModelInfo): Promise<void> => {
    if (switching.current && switching.current === state.activeSession) return
    setSubmenu(null)
    setMenuOpen(false)
    if (controlled) {
      if (model.key !== selectedModelKey) onModelSelect(model)
      return
    }
    const sessionId = state.activeSession
    if (!sessionId) {
      const generation = state.draftGeneration
      const instance = state.serviceInstanceId
      const projectId = state.homeSelectedProjectId
      const effort = reasoningPreference(model, getSnapshot().reasoningPreferences)
      const preparation = prepareModel(model.key, true)
      const selectionGeneration = getSnapshot().modelSelectionGeneration
      const selectionCurrent = (): boolean => {
        const current = getSnapshot()
        return (
          current.activeSession === null &&
          current.model === model.key &&
          current.draftGeneration === generation &&
          current.serviceInstanceId === instance &&
          current.modelSelectionGeneration === selectionGeneration &&
          current.homeSelectedProjectId === projectId
        )
      }
      void preparation
        .then(async (operation) => {
          if (!selectionCurrent()) return
          if (operation.state !== 'applied') throw new Error(operation.error)
          if (declaredEffortValues(model).includes(effort)) {
            await rememberEffort(model.key, effort)
            if (!selectionCurrent()) return
          }
        })
        .catch((error) => {
          if (
            !selectionCurrent() ||
            (error instanceof Error && error.message === PREPARATION_SUPERSEDED_ERROR)
          )
            return
          set({ foregroundError: feedback('components', 'models.retryFailed') })
        })
      return
    }
    switching.current = sessionId
    setPending({ sessionId, model: { ...model } })
    let currentSelection = (): boolean => false
    try {
      await runModelSelection(async (selectionCurrent) => {
        currentSelection = selectionCurrent
        if (!selectionCurrent()) return
        const current = getSnapshot()
        const target = current.catalog.models.find((item) => item.key === model.key)
        if (!target || target.disabled) return
        const currentModelKey = effectiveSessionModelKey(
          current.catalog.models,
          current.model,
          current.activeSession,
          current.threads,
          current.draftModelId
        )
        if (model.key !== currentModelKey) {
          const effort = reasoningPreference(target, current.reasoningPreferences)
          const result = await setSessionModel(sessionId, model.key, effort, true)
          if (!selectionCurrent()) return
          if (
            result?.session_id === sessionId &&
            (result.runtime || (result.ok && result.model_id))
          ) {
            patchThread(sessionId, (thread) => ({
              runtime: {
                name: 'codex',
                ...thread.runtime,
                ...result.runtime,
                model_id: result.model_id,
              },
            }))
          }
          const confirmed = confirmedReasoningSelection(result, sessionId, model.key, effort)
          const remembered =
            confirmed && declaredEffortValues(target).includes(effort)
              ? await rememberEffort(model.key, effort)
              : true
          if (!selectionCurrent()) return
          if (result?.session_id === sessionId && result.model_id === model.key) {
            set({ model: model.key })
            if (result.default_model_id !== model.key) {
              set({ foregroundError: feedback('components', 'models.defaultFailed') })
              return
            }
          }
          if (!result?.ok || !confirmed) {
            if (result?.error === HOST_CONFIGURATION_CONFLICT && result.model_id === model.key) {
              const operation = await currentRuntimeReconfiguration(sessionId).catch(
                () => undefined
              )
              if (!selectionCurrent()) return
              if (
                operation?.model_id === model.key &&
                (operation.state === 'accepted' || operation.state === 'applied')
              ) {
                set((current) =>
                  current.activeSession === sessionId
                    ? { ...(remembered ? { foregroundError: null } : {}), foregroundNotice: null }
                    : {}
                )
                return
              }
            }
            set({
              foregroundError:
                result?.detail || result?.error || feedback('components', 'models.failed'),
              foregroundNotice: result?.deferred
                ? feedback('conversation', 'models.deferred')
                : null,
            })
            return
          }
          set((latest) => ({
            draftModelId: latest.draftModelId ? model.key : null,
            ...(remembered ? { foregroundError: null } : {}),
            foregroundNotice: result.deferred ? feedback('conversation', 'models.nextTurn') : null,
          }))
          return
        }
        const effort = current.threads[sessionId]?.runtime?.reasoning_effort
        const rememberedModel = await rememberModel(model, selectionCurrent)
        if (!selectionCurrent()) return
        const rememberedEffort =
          typeof effort === 'string' && declaredEffortValues(target).includes(effort)
            ? await rememberEffort(model.key, effort)
            : true
        if (selectionCurrent() && rememberedModel && rememberedEffort)
          set({ foregroundError: null })
      })
    } catch (error) {
      if (
        currentSelection() &&
        !(error instanceof Error && error.message === PREPARATION_SUPERSEDED_ERROR)
      )
        set({ foregroundError: feedback('components', 'models.retryFailed') })
    } finally {
      if (switching.current === sessionId) switching.current = null
      setPending((current) => (current?.sessionId === sessionId ? null : current))
    }
  }

  const recheckSubscription = async (): Promise<void> => {
    act.applyModelCatalog(await getModels(true))
  }

  return (
    <Popover
      open={menuOpen}
      onOpenChange={(open) => {
        if (open) setSubmenu(null)
        setMenuOpen(open)
      }}
    >
      <div className={`${MODEL_CHIP_FRAME_CLASS}${iconOnly ? ' order-3 !flex-none' : ''}`}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            data-testid={`${testIdPrefix}-selector-toggle`}
            className={`${MODEL_CHIP_CLASS} w-full overflow-hidden ${compact ? 'min-h-8 !border-transparent !bg-transparent hover:!bg-[var(--vds-other-overlay-1)]' : ''} ${iconOnly ? '!size-[var(--vds-space-8)] !justify-center !p-0' : ''}`}
            size="content"
            unstyled
            disabled={Boolean(pendingHere)}
            aria-busy={Boolean(pendingHere) || effort.pending}
            title={
              pendingHere
                ? t('models.switchingTo', {
                    model: modelDisplayLabels(pendingHere.model, account).label,
                  })
                : showEffort
                  ? `${selectedLabel} · ${hasCurrentModel ? effort.label : '-'}`
                  : selectedLabel
            }
            aria-expanded={menuOpen}
          >
            {iconOnly ? (
              <Brain
                className="size-[var(--vds-space-4)] text-[var(--vds-icon-outline-default)]"
                aria-hidden="true"
              />
            ) : (
              <>
                <span
                  className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left text-[var(--text)]"
                  title={unavailableModelId ? t('models.reenable') : undefined}
                >
                  {pendingHere ? t('models.switching') : selectedLabel}
                </span>
                {showEffort ? (
                  <span className="shrink-0 text-[var(--vds-text-tertiary)]">
                    {hasCurrentModel ? effort.label : '-'}
                  </span>
                ) : null}
                <span className="inline-flex size-3 shrink-0 items-center justify-center text-[var(--text-3)]">
                  <IconFont
                    type="icon-a-line-switch-arrow-down-s"
                    className="flex-none text-[14px] leading-none text-[var(--vds-text-tertiary)]"
                  />
                </span>
              </>
            )}
          </Button>
        </PopoverTrigger>

        <PopoverContent
          align="end"
          aria-label={t('models.selection')}
          className={`!z-[var(--vds-z-modal-nested-overlay)] !flex !items-end !gap-[var(--vds-space-2)] !max-w-[var(--vds-model-menu-viewport-max-width)] !rounded-none !bg-transparent !p-0 !shadow-none ${showEffort && submenu === 'effort' ? '[--model-menu-limit:var(--vds-model-menu-paired-max-width)]' : '[--model-menu-limit:var(--vds-model-menu-max-width)]'}`}
        >
          {showEffort ? (
            <ModelMenuSheet
              open={submenu === 'effort'}
              role="menu"
              aria-label={t('models.effortRow')}
              data-testid="model-effort-menu"
            >
              <div className="[contain:inline-size] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] leading-[var(--vds-model-menu-line-height)] text-[var(--vds-text-tertiary)]">
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
                    className={MODEL_ROW_CLASS(selected, effort.pending || Boolean(pendingHere))}
                    aria-disabled={effort.pending || Boolean(pendingHere)}
                    onClick={() => {
                      setSubmenu(null)
                      void effort.select(option.value)
                    }}
                  >
                    <EllipsisText
                      wrapperClassName="flex-1"
                      className="text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-model-menu-line-height)] text-[var(--vds-text-primary)]"
                      tooltipContentClassName={MODEL_MENU_TOOLTIP_CONTENT_CLASS}
                      tooltipPortalled
                    >
                      {option.label}
                    </EllipsisText>
                    <span
                      className="w-[var(--vds-icon-8)] shrink-0 text-center text-[var(--vds-brand-text-primary)]"
                      aria-hidden
                    >
                      {selected ? '✓' : ''}
                    </span>
                  </Button>
                )
              })}
            </ModelMenuSheet>
          ) : null}

          <ModelMenuSheet
            ref={controlsRef}
            tabIndex={-1}
            role="menu"
            aria-label={t('models.selection')}
            data-testid="model-selector-menu"
          >
            <div ref={panelRef} className={MODEL_MENU_LIST_CLASS}>
              {subscriptionModels.length > 0 && (
                <>
                  {subscriptionGroups.map(({ provider, label }) => {
                    const group = subscriptionModels.filter((model) => model.provider === provider)
                    if (group.length === 0) return null
                    const blocked = group.filter((model) => model.disabled)
                    return (
                      <div key={provider} className="mb-[var(--vds-space-1)]">
                        <EllipsisText
                          wrapperClassName="block"
                          className={MODEL_GROUP_HEADER_CLASS}
                          tooltipContentClassName={MODEL_MENU_TOOLTIP_CONTENT_CLASS}
                          tooltipPortalled
                        >
                          {label}
                        </EllipsisText>
                        {blocked.length > 0 && (
                          <div className="[contain:inline-size] mb-[var(--vds-space-2)] flex items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] border border-[var(--border-soft)] bg-[var(--bg-3)] px-[10px] py-[var(--vds-space-2)] text-[11px] leading-[1.35] text-[var(--text-3)]">
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
                            tag={modelDisabledTag(model, account)}
                          />
                        ))}
                      </div>
                    )
                  })}
                </>
              )}

              {apiModelGroups.map((group) => (
                <div key={group.label} className="mb-[var(--vds-space-1)]">
                  <EllipsisText
                    wrapperClassName="block"
                    className={MODEL_GROUP_HEADER_CLASS}
                    tooltipContentClassName={MODEL_MENU_TOOLTIP_CONTENT_CLASS}
                    tooltipPortalled
                  >
                    {group.label}
                  </EllipsisText>
                  {group.models.map((model) => (
                    <ModelRow
                      key={model.key}
                      model={model}
                      selected={modelAvailable && model.key === selectedModelKey}
                      onSelect={(picked) => void selectModel(picked)}
                      tag={modelDisabledTag(model, account)}
                    />
                  ))}
                </div>
              ))}

              {visibleModels.length === 0 && (
                <EmptyState
                  variant="compact"
                  icon={<Icon name="search" />}
                  title={t('models.empty')}
                />
              )}
            </div>
            {showEffort ? (
              <>
                <div
                  aria-hidden="true"
                  className="mx-[var(--vds-space-2)] my-[var(--vds-space-1)] h-[var(--vds-border-width-1)] shrink-0 bg-[var(--vds-divider-default)]"
                />
                <Button
                  type="button"
                  role="menuitem"
                  data-testid="model-effort-row"
                  size="content"
                  unstyled
                  className={MENU_ENTRY_CLASS(
                    submenu === 'effort',
                    !hasCurrentModel || !effort.selectable
                  )}
                  disabled={
                    !hasCurrentModel || !effort.selectable || effort.pending || Boolean(pendingHere)
                  }
                  aria-haspopup="menu"
                  aria-expanded={submenu === 'effort'}
                  aria-busy={effort.pending}
                  onClick={() => setSubmenu(submenu === 'effort' ? null : 'effort')}
                >
                  <span className="min-w-0 flex-1 text-left">{t('models.effortRow')}</span>
                  <span className="shrink-0 text-[var(--vds-text-tertiary)]">
                    {hasCurrentModel && effort.selectable ? effort.label : '-'}
                  </span>
                  <DropdownMenuArrow />
                </Button>
              </>
            ) : null}
            <div
              aria-hidden="true"
              className="mx-[var(--vds-space-2)] my-[var(--vds-space-1)] h-[var(--vds-border-width-1)] shrink-0 bg-[var(--vds-divider-default)]"
            />
            <Button
              type="button"
              role="menuitem"
              data-testid="model-menu-manage"
              className={MODEL_MENU_MANAGE_CLASS}
              size="content"
              unstyled
              onClick={() => {
                setMenuOpen(false)
                act.openSettings('models')
              }}
            >
              <span className="min-w-0 flex-1 text-[var(--vds-text-primary)]">
                {t('models.manage')}
              </span>
              <DropdownMenuArrow />
            </Button>
          </ModelMenuSheet>
        </PopoverContent>
      </div>
    </Popover>
  )
}
