import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider, useTranslation } from 'react-i18next'
import type {
  BrowserOverlayEvent,
  BrowserOverlayModel,
  SuggestionsBridge,
} from '../../../../overlay'
import { createLocalization } from '../../../../localization/engine'
import { resources } from '../../../../localization/resources'
import {
  Button,
  Command,
  CommandEmpty,
  CommandItem,
  CommandList,
  Tooltip,
  TooltipContent,
} from '../../components/ui'

const SEARCH_ITEM_ID = 'search'
const OPTION_SELECTOR = '[role="option"]:not([hidden]), [data-search-action]'
const STATUS_MESSAGES = {
  loading: { key: 'searchingHistory' },
  empty: { key: 'noHistoryMatches' },
  error: { key: 'historyUnavailable' },
} as const
interface FocusRequest {
  revision: number
  sequence: number
}

export { SEARCH_ITEM_ID }

export function SuggestionsPanel({
  model,
  onEvent,
  focusRequest,
}: {
  model: BrowserOverlayModel
  onEvent?: (event: BrowserOverlayEvent) => void
  focusRequest?: FocusRequest | null
}): React.JSX.Element {
  const { t } = useTranslation('browser')
  const panel = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<string>()
  const select = (itemId: string): void =>
    onEvent?.({ kind: 'select', revision: model.revision, itemId })
  useLayoutEffect(() => {
    if (focusRequest?.revision !== model.revision) return
    panel.current?.querySelector<HTMLElement>(OPTION_SELECTOR)?.focus()
  }, [focusRequest, model.revision])
  const search = model.items.find((item) => item.id === SEARCH_ITEM_ID)
  return (
    <div
      ref={panel}
      data-testid="browser-address-suggestions"
      className="flex max-h-full min-h-0 flex-col overflow-hidden rounded-[var(--vds-radius-3)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] text-[var(--vds-text-primary)] shadow-[var(--vds-shadow-2-center)]"
      onKeyDownCapture={(event) => {
        if (!onEvent || event.nativeEvent.isComposing) return
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault()
          onEvent({
            kind: 'focus-return',
            revision: model.revision,
            target: event.key === 'Escape' || event.shiftKey ? 'address' : 'next',
          })
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const options = [...(panel.current?.querySelectorAll<HTMLElement>(OPTION_SELECTOR) ?? [])]
          if (!options.length) return
          event.preventDefault()
          const index = options.indexOf(document.activeElement as HTMLElement)
          options[
            (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
          ].focus()
        }
      }}
    >
      <Command className="min-h-0 overflow-hidden" value={selected} onValueChange={setSelected}>
        <CommandList aria-label={t('historySuggestions')}>
          {model.items
            .filter((item) => item.id !== SEARCH_ITEM_ID)
            .map((item) => (
              <CommandItem
                key={item.id}
                value={item.id}
                onFocus={() => setSelected(item.id)}
                onSelect={() => select(item.id)}
              >
                <span className="min-w-0 truncate">
                  <span className="block truncate">{item.title}</span>
                  <span className="block truncate text-[var(--vds-text-tertiary)]">
                    {item.detail}
                  </span>
                </span>
              </CommandItem>
            ))}
          {model.status !== 'ready' && (
            <CommandEmpty>{t(STATUS_MESSAGES[model.status].key)}</CommandEmpty>
          )}
        </CommandList>
      </Command>
      {search && (
        <Button
          type="button"
          variant="ghost"
          data-search-action=""
          className="w-full min-w-0 shrink-0 justify-start truncate"
          onClick={() => select(search.id)}
        >
          {search.title}
        </Button>
      )}
    </div>
  )
}

export function Suggestions({ bridge }: { bridge: SuggestionsBridge }): React.JSX.Element | null {
  const [model, setModel] = useState<BrowserOverlayModel | null>(null)
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null)
  const currentModel = useRef<BrowserOverlayModel | null>(null)
  const focusSequence = useRef(0)
  const [localization] = useState(() => createLocalization('en', resources, { escapeValue: false }))
  useEffect(() => {
    const unsubscribeModel = bridge.subscribe((next) => {
      currentModel.current = next
      setModel(next)
      setFocusRequest(null)
    })
    const unsubscribeFocus = bridge.subscribeFocus((revision) => {
      if (revision !== currentModel.current?.revision) return
      setFocusRequest({ revision, sequence: ++focusSequence.current })
    })
    return () => {
      currentModel.current = null
      unsubscribeModel()
      unsubscribeFocus()
    }
  }, [bridge])
  useLayoutEffect(() => {
    if (!model) return
    document.documentElement.dataset.theme = model.theme
    document.documentElement.lang = model.language
    const tooltip = model.tooltip !== undefined
    document.documentElement.classList.toggle('!bg-transparent', tooltip)
    document.body.classList.toggle('!bg-transparent', tooltip)
    document.getElementById('root')?.classList.toggle('overflow-hidden', !tooltip)
    document.getElementById('root')?.classList.toggle('overflow-visible', tooltip)
    void localization.changeLanguage(model.language === 'zh-CN' ? 'zh' : 'en')
  }, [model, localization])
  return model ? (
    <I18nextProvider i18n={localization}>
      {model.tooltip !== undefined ? (
        <Tooltip
          open
          className="!block !h-full !w-full"
          onClick={() => {
            void bridge.send({ kind: 'dismiss', revision: model.revision })
          }}
        >
          <TooltipContent
            data-testid="browser-native-tooltip"
            className="!pointer-events-auto !absolute !block !max-w-none !transform-none !translate-x-0 !translate-y-0 !animate-none"
            style={{
              left: model.tooltipBounds!.x,
              top: model.tooltipBounds!.y,
              width: model.tooltipBounds!.width,
              height: model.tooltipBounds!.height,
            }}
          >
            {model.tooltip}
          </TooltipContent>
        </Tooltip>
      ) : (
        <SuggestionsPanel
          model={model}
          focusRequest={focusRequest}
          onEvent={(event) => {
            void bridge.send(event)
          }}
        />
      )}
    </I18nextProvider>
  ) : null
}

export function mountSuggestions(): void {
  if (window.suggestions)
    createRoot(document.getElementById('root')!).render(<Suggestions bridge={window.suggestions} />)
}
