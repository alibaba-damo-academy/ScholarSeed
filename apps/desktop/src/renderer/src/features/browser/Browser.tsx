import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRight, CircleHelp, Ellipsis, Plus, RotateCw } from 'lucide-react'
import {
  BROWSER_CDP_STATUS,
  BROWSER_ERROR,
  PAGE_ZOOM_DEFAULT,
  PAGE_ZOOM_FACTORS,
  pageZoomSteps,
  samePageTarget,
} from '../../../../browser'
import type {
  BrowserCommand,
  BrowserErrorCode,
  BrowserPageTarget,
  BrowserSnapshot,
  BrowserVisit,
} from '../../../../browser'
import type { BrowserOverlayModel } from '../../../../overlay'
import {
  Button,
  Card,
  CardDescription,
  CardTitle,
  IconButton,
  Input,
  NavigationTabs,
  Page,
  PageBody,
  PageHeader,
  Tooltip,
} from '../../components/ui'
import { useBrowserViewport, useChromiumFrame } from './viewport'
import { createSuggestions } from './presenter'
import { SEARCH_ITEM_ID, SuggestionsPanel } from './Suggestions'
import { MENU_ACTION } from '../../../../menu'
import type { BrowserSettingsSection } from '../../../../navigation'
import {
  createMenuPresenter,
  type MenuPresentationModel,
} from '../../components/primitive/presenter'

const EMPTY_SNAPSHOT: BrowserSnapshot = {
  tabs: [],
  activeTabId: null,
  automation: { enabled: false, port: null },
}
const BLANK_PAGE = 'about:blank'
const START_TAB_ID = 'browser-start'
const START_GUIDES = [
  {
    id: 'navigation',
    titleKey: 'start.navigation.title',
    descriptionKey: 'start.navigation.description',
  },
  { id: 'tabs', titleKey: 'start.tabs.title', descriptionKey: 'start.tabs.description' },
  {
    id: 'devtools',
    titleKey: 'start.devtools.title',
    descriptionKey: 'start.devtools.description',
  },
  { id: 'cdp', titleKey: 'start.cdp.title', descriptionKey: 'start.cdp.description' },
] as const
const ERROR_MESSAGES = {
  invalid_url: 'errors.invalid_url',
  invalid_command: 'errors.invalid_command',
  invalid_sender: 'errors.invalid_sender',
  navigation_failed: 'errors.navigation_failed',
  permission_denied: 'errors.permission_denied',
  cdp_disabled: 'errors.cdp_disabled',
  cdp_busy: 'errors.cdp_busy',
  print_busy: 'errors.print_busy',
  devtools_conflict: 'errors.devtools_conflict',
  target_closed: 'errors.target_closed',
  unsupported_cdp_method: 'errors.unsupported_cdp_method',
  desktop_bridge_unavailable: 'errors.desktop_bridge_unavailable',
  operation_failed: 'errors.operation_failed',
  partial_clear: 'errors.partial_clear',
  automatic_download_unavailable: 'errors.automatic_download_unavailable',
  browser_policy_io_unavailable: 'errors.browser_policy_io_unavailable',
  browser_policy_revision_conflict: 'errors.browser_policy_revision_conflict',
  browser_policy_invalid: 'errors.browser_policy_invalid',
  browser_history_delivery_pending: 'errors.browser_history_delivery_pending',
} as const satisfies Record<BrowserErrorCode, string>
const TAB_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End'])
const HISTORY_SUGGESTION_LIMIT = 8
const HISTORY_QUERY_DELAY_MS = 150
const WEB_SEARCH_QUERY_LIMIT = 512
const GOOGLE_SEARCH_URL = 'https://www.google.com/search?q='
const PRIORITY_SURFACES = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'
const PRIORITY_ATTRIBUTES = ['class', 'style', 'hidden', 'open', 'aria-hidden', 'data-state']
const MENU_SETTINGS_SEPARATOR_ID = 'browser.menu.settings.separator'

export function Browser({
  onSettings,
}: { onSettings?: (section: BrowserSettingsSection) => void } = {}): React.JSX.Element {
  const { t, i18n } = useTranslation('browser')
  const [snapshot, setSnapshot] = useState<BrowserSnapshot>(EMPTY_SNAPSHOT)
  const [tabOrder, setTabOrder] = useState<string[]>([])
  const orderedTabs = useMemo(() => {
    const rank = new Map(tabOrder.map((id, index) => [id, index]))
    return [...snapshot.tabs].sort(
      (first, second) =>
        (rank.get(first.tabId) ?? tabOrder.length) - (rank.get(second.tabId) ?? tabOrder.length)
    )
  }, [snapshot.tabs, tabOrder])
  const [error, setError] = useState<BrowserErrorCode | null>(null)
  const [address, setAddress] = useState('')
  const [suggestions, setSuggestions] = useState<BrowserVisit[]>([])
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState(false)
  const [pending, setPending] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const suggestionsProbe = useRef<HTMLDivElement>(null)
  const helpControl = useRef<HTMLButtonElement>(null)
  const feedbackId = useId()
  const moreControl = useRef<HTMLButtonElement>(null)
  const [menu] = useState(() =>
    window.scholarseed.menu ? createMenuPresenter(window.scholarseed.menu) : null
  )
  const [findMenu] = useState(() =>
    window.scholarseed.menu ? createMenuPresenter(window.scholarseed.menu, 'browser-find') : null
  )
  const findOrigin = useRef<'page' | 'menu'>('page')
  const pageOperation = useRef(0)
  const [menuShown, setMenuShown] = useState(false)
  const [menuPending, setMenuPending] = useState(false)
  const [menuFailure, setMenuFailure] = useState(false)
  const menuOpening = useRef(false)
  const [overlay] = useState(() =>
    window.scholarseed.browserOverlay ? createSuggestions(window.scholarseed.browserOverlay) : null
  )
  const openSuggestions = useRef(false)
  const publishSuggestions = useRef<() => void>(() => undefined)
  const restoreAddressFocus = useRef(false)
  const mounted = useRef(false)
  const busy = useRef(false)
  const operation = useRef(0)
  const editRevision = useRef(0)
  const editing = useRef(false)
  const addressTab = useRef<string | null>(null)
  const openingAddress = useRef<{ value: string; editRevision: number } | null>(null)
  const sequence = useRef(0)
  const workspace = useRef<HTMLElement>(null)
  const focusTab = useRef(false)
  const composing = useRef(false)
  const compositionStarted = useRef(false)
  const discardCompositionEnd = useRef(false)
  const pressedKeys = useRef(
    new Map<
      string,
      { key: string; code: string; windowsVirtualKeyCode: number; modifiers: number }
    >()
  )
  const inputTab = useRef<string | null>(null)
  const active = snapshot.tabs.find((tab) => tab.tabId === snapshot.activeTabId)
  const startPage = !active?.url || active.url === BLANK_PAGE
  const activeTab = useRef(active?.tabId)
  activeTab.current = active?.tabId
  const openFind = useCallback(
    async (target: BrowserPageTarget, origin: 'page' | 'menu'): Promise<void> => {
      if (!findMenu || !moreControl.current || activeTab.current !== target.tabId) return
      const current = findMenu.current()
      if (current?.target.kind === 'browser' && samePageTarget(current.target, target)) {
        const reply = await window.scholarseed.menu?.refocus?.({
          sessionId: current.sessionId,
          revision: current.revision,
        })
        if (!reply?.ok) setMenuFailure(true)
        return
      }
      findOrigin.current = origin
      const bounds = moreControl.current.getBoundingClientRect()
      await findMenu.open(
        'browser-find',
        { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        {
          request: { surface: 'browser-find', target },
          items: [],
          find: { origin },
          viewport: { width: window.innerWidth, height: window.innerHeight },
          theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
          language: i18n.resolvedLanguage === 'en' ? 'en' : 'zh-CN',
        }
      )
    },
    [findMenu, i18n.resolvedLanguage]
  )
  const requestFind = useCallback(async (): Promise<void> => {
    const tabId = activeTab.current
    const expected = pageOperation.current
    if (!tabId || !window.scholarseed.browser.page) return
    const reply = await window.scholarseed.browser.page({ kind: 'target', tabId })
    if (expected !== pageOperation.current || !mounted.current) return
    if (reply.ok) await openFind(reply.target, 'page')
    else if (reply.error !== BROWSER_ERROR.targetClosed) setError(reply.error)
  }, [openFind])
  const zoomFactor = active?.zoomFactor ?? PAGE_ZOOM_DEFAULT
  const { lower: lowerZoom, higher: higherZoom, reset: resetZoom } = pageZoomSteps(zoomFactor)
  const nativePage = Boolean(window.scholarseed.browser.page)
  const menuData = useMemo(
    (): MenuPresentationModel => ({
      request: { surface: 'browser-menu', tabId: active?.tabId ?? null },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
      language: i18n.resolvedLanguage === 'en' ? 'en' : 'zh-CN',
      items: [
        {
          kind: 'action',
          id: MENU_ACTION.find,
          actionId: MENU_ACTION.find,
          label: t('find.title'),
          disabled: !active || !nativePage,
          checked: false,
          value: { kind: 'none' },
        },
        {
          kind: 'action',
          id: MENU_ACTION.print,
          actionId: MENU_ACTION.print,
          label: t('print'),
          disabled: !active || !nativePage,
          checked: false,
          value: { kind: 'none' },
        },
        {
          kind: 'zoom',
          id: MENU_ACTION.zoom,
          label: t('zoom.title'),
          percentage: Math.round(zoomFactor * 100),
          items: [
            {
              kind: 'action',
              id: `${MENU_ACTION.zoom}.out`,
              actionId: MENU_ACTION.zoom,
              label: t('zoom.out'),
              disabled: !active || !nativePage || lowerZoom === undefined,
              checked: false,
              value: { kind: 'number', value: lowerZoom ?? PAGE_ZOOM_FACTORS[0] },
            },
            {
              kind: 'action',
              id: `${MENU_ACTION.zoom}.in`,
              actionId: MENU_ACTION.zoom,
              label: t('zoom.in'),
              disabled: !active || !nativePage || higherZoom === undefined,
              checked: false,
              value: { kind: 'number', value: higherZoom ?? PAGE_ZOOM_FACTORS.at(-1)! },
            },
            {
              kind: 'action',
              id: `${MENU_ACTION.zoom}.reset`,
              actionId: MENU_ACTION.zoom,
              label: t('zoom.reset'),
              disabled: !active || !nativePage || !resetZoom,
              checked: false,
              value: { kind: 'number', value: PAGE_ZOOM_DEFAULT },
            },
          ],
        },
        {
          kind: 'action',
          id: MENU_ACTION.devtools,
          actionId: MENU_ACTION.devtools,
          label: t(active?.devtoolsOpen ? 'closeDevtools' : 'openDevtools'),
          disabled: !active,
          checked: active?.devtoolsOpen ?? false,
          value: { kind: 'boolean', value: !(active?.devtoolsOpen ?? false) },
        },
        { kind: 'separator', id: MENU_SETTINGS_SEPARATOR_ID },
        {
          kind: 'action',
          id: MENU_ACTION.browserHistory,
          actionId: MENU_ACTION.browserHistory,
          label: t('settings.historyPageTitle'),
          disabled: false,
          checked: false,
          value: { kind: 'none' },
        },
        {
          kind: 'action',
          id: MENU_ACTION.browserSettings,
          actionId: MENU_ACTION.browserSettings,
          label: t('settings.title'),
          disabled: false,
          checked: false,
          value: { kind: 'none' },
        },
      ],
    }),
    [
      active?.tabId,
      active?.devtoolsOpen,
      zoomFactor,
      lowerZoom,
      higherZoom,
      resetZoom,
      nativePage,
      i18n.resolvedLanguage,
      t,
    ]
  )
  const currentMenuData = useCallback(
    (): MenuPresentationModel => ({
      ...menuData,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
    }),
    [menuData]
  )
  useEffect(() => {
    if (!menu) return
    const unsubscribe = menu.subscribe((model, reason) => {
      setMenuShown(Boolean(model))
      if (reason === 'escape') moreControl.current?.focus({ preventScroll: true })
      if (reason === 'invalid' || reason === 'crash' || reason === 'timeout') setMenuFailure(true)
    })
    const unsubscribeAction = menu.subscribeAction((event, approved) => {
      if (event.actionId === MENU_ACTION.browserSettings) {
        onSettings?.('overview')
        return
      }
      if (event.actionId === MENU_ACTION.browserHistory) {
        onSettings?.('history')
        return
      }
      if (approved.target.kind !== 'browser') return
      const target = {
        tabId: approved.target.tabId,
        instanceId: approved.target.instanceId,
        navigationId: approved.target.navigationId,
      }
      if (event.actionId === MENU_ACTION.find)
        void openFind(target, 'menu').catch(() => setMenuFailure(true))
      if (event.actionId === MENU_ACTION.print && window.scholarseed.browser.page) {
        const expected = pageOperation.current
        void window.scholarseed.browser
          .page({ kind: 'print', target })
          .then((reply) => {
            if (
              !mounted.current ||
              expected !== pageOperation.current ||
              activeTab.current !== target.tabId
            )
              return
            if (!reply.ok) {
              if (reply.error !== BROWSER_ERROR.targetClosed) setError(reply.error)
            } else if (reply.print?.status === 'failed') setError(BROWSER_ERROR.operationFailed)
          })
          .catch(() => {
            if (mounted.current && expected === pageOperation.current)
              setError(BROWSER_ERROR.operationFailed)
          })
      }
    })
    const unsubscribeResult = menu.subscribeResult((result) => {
      if (result.outcome === 'failed') setMenuFailure(true)
    })
    return () => {
      unsubscribe()
      unsubscribeAction()
      unsubscribeResult()
    }
  }, [menu, onSettings, openFind])
  useEffect(() => {
    const remove = findMenu?.subscribe((_model, reason) => {
      if (reason === 'escape' && findOrigin.current === 'menu')
        moreControl.current?.focus({ preventScroll: true })
      if (reason === 'invalid' || reason === 'timeout' || reason === 'crash') setMenuFailure(true)
    })
    const removeShortcut = window.scholarseed.browser.subscribeFind?.((target) => {
      void openFind(target, 'page').catch(() => setMenuFailure(true))
    })
    return () => {
      remove?.()
      removeShortcut?.()
    }
  }, [findMenu, openFind])
  useEffect(() => () => findMenu?.dispose(), [findMenu])
  useEffect(() => () => menu?.dispose(), [menu])
  useLayoutEffect(() => {
    pageOperation.current += 1
    void menu?.dismiss('target').catch(() => setMenuFailure(true))
    void findMenu?.dismiss('target').catch(() => setMenuFailure(true))
  }, [menu, findMenu, active?.tabId, active?.url])
  useEffect(() => {
    const update = (): void => {
      if (menu?.current()) void menu.update(currentMenuData()).catch(() => setMenuFailure(true))
      const current = findMenu?.current()
      if (current?.target.kind === 'browser')
        void findMenu
          ?.update({
            request: {
              surface: 'browser-find',
              target: {
                tabId: current.target.tabId,
                instanceId: current.target.instanceId,
                navigationId: current.target.navigationId,
              },
            },
            items: [],
            find: current.find,
            viewport: { width: window.innerWidth, height: window.innerHeight },
            theme: currentMenuData().theme,
            language: menuData.language,
          })
          .catch(() => setMenuFailure(true))
    }
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => observer.disconnect()
  }, [menu, findMenu, currentMenuData, menuData.language])
  const sidecar = snapshot.engine === 'chromium-sidecar'
  const viewportTabId = startPage ? undefined : active?.tabId
  const viewport = useBrowserViewport(
    viewportTabId,
    setError,
    sidecar ? 'chromium-sidecar' : 'electron-view'
  )
  const chromium = useChromiumFrame(viewportTabId, viewport, sidecar, setError)
  const visibleFrame = chromium.frame
  const closeSuggestions = useCallback(() => {
    openSuggestions.current = false
    setSuggestionsOpen(false)
    try {
      overlay?.dismissSync()
    } catch {
      setError(BROWSER_ERROR.operationFailed)
    }
  }, [overlay])
  const suggestionData = useMemo(() => {
    const query = address.trim()
    const targets = new Map<string, string>()
    const items = suggestions.map((visit) => {
      const id = `history:${visit.id}`
      targets.set(id, visit.url)
      return { id, title: visit.title || visit.url, detail: visit.url }
    })
    if (!historyLoading && query && query.length <= WEB_SEARCH_QUERY_LIMIT) {
      targets.set(SEARCH_ITEM_ID, `${GOOGLE_SEARCH_URL}${encodeURIComponent(query)}`)
      items.push({ id: SEARCH_ITEM_ID, title: t('searchWeb', { query }), detail: '' })
    }
    const model: BrowserOverlayModel = {
      revision: 1,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      theme: 'light',
      language: i18n.resolvedLanguage === 'en' ? 'en' : 'zh-CN',
      status: historyLoading
        ? 'loading'
        : historyError
          ? 'error'
          : suggestions.length
            ? 'ready'
            : 'empty',
      items,
    }
    return { model, targets }
  }, [address, suggestions, historyLoading, historyError, t, i18n.resolvedLanguage])
  const suggestionDataRef = useRef(suggestionData)
  suggestionDataRef.current = suggestionData
  useLayoutEffect(() => {
    if (!overlay) return
    let signature = ''
    const priorityVisible = (): boolean =>
      [...document.querySelectorAll<HTMLElement>(PRIORITY_SURFACES)].some(
        (element) =>
          !suggestionsProbe.current?.contains(element) &&
          element.checkVisibility({ visibilityProperty: true })
      )
    const update = (): void => {
      if (!openSuggestions.current || !input.current || !suggestionsProbe.current) return
      if (priorityVisible()) {
        closeSuggestions()
        return
      }
      const bounds = input.current.getBoundingClientRect()
      suggestionsProbe.current.style.width = `${bounds.width}px`
      const height = suggestionsProbe.current.scrollHeight
      if (!bounds.width || !height || !input.current.checkVisibility()) {
        closeSuggestions()
        return
      }
      const { model, targets } = suggestionDataRef.current
      const next = {
        ...model,
        bounds: {
          x: Math.max(0, bounds.left),
          y: Math.max(0, bounds.bottom),
          width: bounds.width,
          height,
        },
        theme:
          document.documentElement.dataset.theme === 'dark'
            ? ('dark' as const)
            : ('light' as const),
      }
      const serialized = JSON.stringify(next)
      if (signature === serialized && overlay.current()) return
      signature = serialized
      void overlay.publish(next, targets).catch(() => {
        if (mounted.current) {
          closeSuggestions()
          setError(BROWSER_ERROR.operationFailed)
        }
      })
    }
    publishSuggestions.current = update
    const pointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && input.current?.contains(event.target)) return
      if (openSuggestions.current) closeSuggestions()
    }
    const focus = (event: FocusEvent): void => {
      if (event.target instanceof Node && input.current?.contains(event.target)) return
      if (openSuggestions.current) closeSuggestions()
    }
    const changes = (): void => {
      if (priorityVisible() && openSuggestions.current) closeSuggestions()
      else update()
    }
    const resize = new ResizeObserver(update)
    if (input.current) resize.observe(input.current)
    if (suggestionsProbe.current) {
      suggestionsProbe.current.inert = true
      resize.observe(suggestionsProbe.current)
    }
    const mutations = new MutationObserver(changes)
    mutations.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: PRIORITY_ATTRIBUTES,
    })
    mutations.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    document.addEventListener('pointerdown', pointer, true)
    document.addEventListener('focusin', focus, true)
    return () => {
      publishSuggestions.current = () => undefined
      resize.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      document.removeEventListener('pointerdown', pointer, true)
      document.removeEventListener('focusin', focus, true)
      overlay.invalidate()
      void overlay
        .dismiss()
        .catch((error) => console.error('Browser suggestions disposal failed', error))
    }
  }, [overlay, closeSuggestions])
  useLayoutEffect(() => {
    publishSuggestions.current()
  }, [suggestionData, suggestionsOpen])
  useLayoutEffect(() => {
    closeSuggestions()
  }, [active?.tabId, closeSuggestions])
  useLayoutEffect(() => {
    const tabId = sidecar ? (active?.tabId ?? null) : null
    if (inputTab.current === tabId) return
    if (composing.current || compositionStarted.current) discardCompositionEnd.current = true
    inputTab.current = tabId
    pressedKeys.current.clear()
    composing.current = false
    compositionStarted.current = false
    const editable = viewport.current?.querySelector<HTMLElement>('[contenteditable]')
    if (editable) editable.textContent = ''
  }, [active?.tabId, sidecar, viewport])
  const sendPointer = (
    event: React.PointerEvent<HTMLDivElement>,
    type: 'mouseMoved' | 'mousePressed' | 'mouseReleased'
  ): void => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const { width, height } = chromium.dimensions.current
    if (!width || !height || !bounds.width || !bounds.height) return
    const x = Math.min(
      width - 1,
      Math.max(0, Math.floor(((event.clientX - bounds.left) * width) / bounds.width))
    )
    const y = Math.min(
      height - 1,
      Math.max(0, Math.floor(((event.clientY - bounds.top) * height) / bounds.height))
    )
    const button = event.button === 1 ? 'middle' : event.button === 2 ? 'right' : 'left'
    chromium.input({ kind: 'mouse', type, x, y, button, clickCount: event.detail || 1 })
  }
  const sendKey = (event: React.KeyboardEvent<HTMLDivElement>, type: 'keyDown' | 'keyUp'): void => {
    if (composing.current || event.key === 'Process') return
    const modifiers =
      (event.altKey ? 1 : 0) |
      (event.ctrlKey ? 2 : 0) |
      (event.metaKey ? 4 : 0) |
      (event.shiftKey ? 8 : 0)
    const shortcut = event.altKey || event.ctrlKey || event.metaKey
    if (type === 'keyDown') {
      if (event.key.length === 1 && !shortcut) return
      pressedKeys.current.set(event.code, {
        key: event.key,
        code: event.code,
        windowsVirtualKeyCode: event.keyCode,
        modifiers,
      })
      chromium.input({
        kind: 'key',
        type,
        key: event.key,
        code: event.code,
        windowsVirtualKeyCode: event.keyCode,
        modifiers,
      })
      event.preventDefault()
    } else {
      const pressed = pressedKeys.current.get(event.code)
      if (!pressed) return
      pressedKeys.current.delete(event.code)
      chromium.input({ kind: 'key', type, ...pressed })
      event.preventDefault()
    }
  }

  useEffect(() => {
    mounted.current = true
    const bridge = window.scholarseed.browser
    const unsubscribe = bridge.subscribe((next) => {
      sequence.current += 1
      setSnapshot(next)
    })
    const revision = sequence.current
    void bridge
      .snapshot()
      .then((reply) => {
        if (!mounted.current) return
        if (!reply.ok) setError(reply.error)
        else if (sequence.current === revision) setSnapshot(reply.snapshot)
      })
      .catch(() => {
        if (mounted.current) setError(BROWSER_ERROR.operationFailed)
      })
    return () => {
      mounted.current = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (addressTab.current !== (active?.tabId ?? null)) {
      addressTab.current = active?.tabId ?? null
      if (openingAddress.current && openingAddress.current.editRevision !== editRevision.current)
        return
      editing.current = false
    } else if (editing.current) return
    if (
      openingAddress.current &&
      openingAddress.current.editRevision === editRevision.current &&
      (!active?.url || active.url === BLANK_PAGE)
    ) {
      setAddress(openingAddress.current.value)
      return
    }
    setAddress(active?.url === BLANK_PAGE ? '' : (active?.url ?? ''))
  }, [active?.tabId, active?.url])
  useEffect(() => {
    const query = address.trim()
    if (!suggestionsOpen || !query) {
      setSuggestions([])
      setHistoryLoading(false)
      setHistoryError(false)
      return
    }
    let cancelled = false
    setHistoryLoading(true)
    setHistoryError(false)
    const timer = window.setTimeout(() => {
      void window.scholarseed.browser
        .history({
          kind: 'query',
          query: { search: query, offset: 0, limit: HISTORY_SUGGESTION_LIMIT },
        })
        .then((reply) => {
          if (cancelled) return
          if (!reply.ok || !reply.page) {
            setHistoryError(true)
            setSuggestions([])
            return
          }
          const urls = new Set<string>()
          setSuggestions(
            reply.page.items.filter((visit) => {
              if (urls.has(visit.url)) return false
              urls.add(visit.url)
              return true
            })
          )
        })
        .catch(() => {
          if (!cancelled) {
            setHistoryError(true)
            setSuggestions([])
          }
        })
        .finally(() => {
          if (!cancelled) setHistoryLoading(false)
        })
    }, HISTORY_QUERY_DELAY_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [address, suggestionsOpen])
  useEffect(() => {
    if (!focusTab.current) return
    focusTab.current = false
    workspace.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
  }, [snapshot.activeTabId])

  const dispatch = useCallback(async (command: BrowserCommand) => {
    if (busy.current && command.kind !== 'navigate') return
    const currentOperation = ++operation.current
    const currentEditRevision = editRevision.current
    busy.current = true
    setPending(true)
    setError(null)
    const revision = sequence.current
    try {
      const reply = await window.scholarseed.browser.dispatch(command)
      if (!mounted.current || currentOperation !== operation.current) return
      if (!reply.ok) {
        setError(reply.error)
        return
      }
      if (sequence.current === revision) setSnapshot(reply.snapshot)
      if (
        command.kind === 'navigate' &&
        currentEditRevision === editRevision.current &&
        !editing.current
      ) {
        const current = reply.snapshot.tabs.find((tab) => tab.tabId === reply.snapshot.activeTabId)
        setAddress(current?.url === BLANK_PAGE ? '' : (current?.url ?? ''))
      }
      if (command.kind === 'open' || command.kind === 'close') input.current?.focus()
    } catch {
      if (mounted.current && currentOperation === operation.current)
        setError(BROWSER_ERROR.operationFailed)
    } finally {
      if (currentOperation === operation.current) {
        if (command.kind === 'open') openingAddress.current = null
        busy.current = false
        if (mounted.current) setPending(false)
      }
    }
  }, [])

  const failure = error ?? active?.navigationError
  const feedback = [
    failure ? t(ERROR_MESSAGES[failure]) : null,
    menuFailure ? t('errors.operation_failed') : null,
    active?.cdpStatus === BROWSER_CDP_STATUS.connected ? t('connected') : null,
    active?.cdpStatus === BROWSER_CDP_STATUS.conflict ? t('errors.devtools_conflict') : null,
  ].filter(Boolean)
  const help = [...new Set(feedback)].join(' ') || t('help.description')
  const unavailable = error === BROWSER_ERROR.desktopBridgeUnavailable
  const navigate = (target: string): void => {
    openingAddress.current = active ? null : { value: target, editRevision: editRevision.current }
    editing.current = false
    closeSuggestions()
    void dispatch(
      active
        ? { kind: 'navigate', tabId: active.tabId, input: target }
        : { kind: 'open', input: target }
    )
  }
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  useEffect(() => {
    if (!overlay || !window.scholarseed.browserOverlay) return
    return window.scholarseed.browserOverlay.subscribe((event) => {
      if (!overlay.accepts(event)) return
      const target = overlay.select(event)
      overlay.invalidate()
      openSuggestions.current = false
      setSuggestionsOpen(false)
      if (target) {
        navigateRef.current(target)
        return
      }
      if (event.kind === 'focus-return') {
        restoreAddressFocus.current = true
        if (event.target === 'address') input.current?.focus()
        else helpControl.current?.focus()
        restoreAddressFocus.current = false
      }
    })
  }, [overlay])
  return (
    <section
      ref={workspace}
      aria-label={t('title')}
      aria-busy={pending}
      data-testid="browser-workspace"
      className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--vds-bg-gray-default)] text-[var(--vds-text-primary)]"
      onKeyDown={(event) => {
        if (
          !event.nativeEvent.isComposing &&
          !event.altKey &&
          !event.shiftKey &&
          event.key.toLowerCase() === 'f' &&
          (window.scholarseed.platform === 'darwin'
            ? event.metaKey && !event.ctrlKey
            : event.ctrlKey && !event.metaKey) &&
          active &&
          nativePage
        ) {
          event.preventDefault()
          void requestFind().catch(() => setMenuFailure(true))
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
          event.preventDefault()
          input.current?.focus()
          input.current?.select()
        }
      }}
    >
      <fieldset
        disabled={pending || unavailable}
        aria-label={t('tabs')}
        className="m-0 flex min-w-0 shrink-0 items-center border-0 p-0"
      >
        <NavigationTabs
          aria-label={t('tabs')}
          onReorder={pending || unavailable ? undefined : setTabOrder}
          showOverview={false}
          value={snapshot.activeTabId ?? START_TAB_ID}
          trailing={
            <Tooltip content={t('newTabAction')} side="bottom">
              <IconButton
                label={t('newTabAction')}
                title={undefined}
                variant="ghost"
                className="shrink-0 !rounded-[var(--vds-radius-circle)]"
                icon={<Plus />}
                disabled={pending || unavailable}
                onClick={() => {
                  void dispatch({ kind: 'open' })
                }}
              />
            </Tooltip>
          }
          getTabProps={() => ({
            'aria-disabled': pending || unavailable,
            className: 'aria-disabled:cursor-not-allowed',
          })}
          onKeyDown={(event) => {
            if (
              !TAB_KEYS.has(event.key) ||
              (event.target as HTMLElement).getAttribute('role') !== 'tab' ||
              pending ||
              !snapshot.tabs.length
            )
              return
            event.preventDefault()
            const index = orderedTabs.findIndex((tab) => tab.tabId === snapshot.activeTabId)
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? snapshot.tabs.length - 1
                  : (index + (event.key === 'ArrowRight' ? 1 : -1) + snapshot.tabs.length) %
                    snapshot.tabs.length
            if (next === index) return
            focusTab.current = true
            void dispatch({ kind: 'select', tabId: orderedTabs[next].tabId })
          }}
          tabs={
            snapshot.tabs.length
              ? orderedTabs.map((tab) => ({
                  id: tab.tabId,
                  label: tab.url === BLANK_PAGE ? t('newTab') : tab.title || t('newTab'),
                }))
              : [{ id: START_TAB_ID, label: t('start.tab'), closable: false }]
          }
          onValueChange={(tabId) => {
            if (snapshot.tabs.length) void dispatch({ kind: 'select', tabId })
          }}
          onClose={(tabId) => {
            void dispatch({ kind: 'close', tabId })
          }}
        />
      </fieldset>
      <form
        aria-label={t('navigation')}
        className="flex shrink-0 flex-wrap items-start gap-[var(--vds-layout-control-gap)] p-[var(--vds-space-2)]"
        onSubmit={(event) => {
          event.preventDefault()
          if (address.trim()) navigate(address)
        }}
      >
        <IconButton
          label={t('back')}
          variant="ghost"
          icon={<ArrowLeft />}
          disabled={pending || !active?.canGoBack}
          onClick={() => {
            if (active) void dispatch({ kind: 'back', tabId: active.tabId })
          }}
        />
        <IconButton
          label={t('forward')}
          variant="ghost"
          icon={<ArrowRight />}
          disabled={pending || !active?.canGoForward}
          onClick={() => {
            if (active) void dispatch({ kind: 'forward', tabId: active.tabId })
          }}
        />
        <IconButton
          label={t('reload')}
          variant="ghost"
          icon={<RotateCw />}
          disabled={pending || !active || active.loading}
          onClick={() => {
            if (active) void dispatch({ kind: 'reload', tabId: active.tabId })
          }}
        />
        <div
          className="min-w-0 flex-1"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Escape' && suggestionsOpen) {
              event.preventDefault()
              closeSuggestions()
              restoreAddressFocus.current = true
              input.current?.focus()
              restoreAddressFocus.current = false
            }
          }}
        >
          <Input
            ref={input}
            aria-label={t('address')}
            aria-describedby={feedbackId}
            aria-invalid={Boolean(failure)}
            placeholder={t('addressPlaceholder')}
            value={address}
            disabled={unavailable}
            aria-expanded={suggestionsOpen && Boolean(address.trim())}
            onClick={() => {
              openSuggestions.current = Boolean(address.trim())
              setSuggestionsOpen(true)
            }}
            onChange={(event) => {
              try {
                overlay?.dismissSync()
              } catch {
                setError(BROWSER_ERROR.operationFailed)
              }
              editing.current = true
              editRevision.current += 1
              setAddress(event.target.value)
              setSuggestions([])
              setHistoryLoading(Boolean(event.target.value.trim()))
              openSuggestions.current = Boolean(event.target.value.trim())
              setSuggestionsOpen(true)
            }}
            onFocus={(event) => {
              if (restoreAddressFocus.current) return
              event.target.select()
              openSuggestions.current = Boolean(address.trim())
              setSuggestionsOpen(true)
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Tab') closeSuggestions()
              if (
                event.key === 'ArrowDown' &&
                suggestionsOpen &&
                suggestionData.model.items.length
              ) {
                event.preventDefault()
                void overlay?.focus().catch(() => setError(BROWSER_ERROR.operationFailed))
              }
            }}
          />
          <div
            ref={suggestionsProbe}
            aria-hidden="true"
            className="invisible pointer-events-none fixed"
          >
            <SuggestionsPanel model={suggestionData.model} />
          </div>
        </div>
        <Tooltip content={help} side="top" portalled disabled={menuShown || menuPending}>
          <IconButton
            ref={helpControl}
            label={t('help.label')}
            title={undefined}
            aria-describedby={feedbackId}
            variant="ghost"
            icon={<CircleHelp />}
            type="button"
          />
        </Tooltip>
        <span
          id={feedbackId}
          role={failure || menuFailure ? 'alert' : 'status'}
          aria-atomic="true"
          className="sr-only"
        >
          {help}
        </span>
        <Tooltip content={t('moreFeatures')} portalled disabled={menuShown || menuPending}>
          <IconButton
            ref={moreControl}
            label={t('moreFeatures')}
            title={undefined}
            variant="ghost"
            icon={<Ellipsis />}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuShown}
            aria-busy={menuPending}
            disabled={pending || menuPending || unavailable || !menu}
            onClick={() => {
              closeSuggestions()
              if (!menu || !moreControl.current || menuOpening.current) return
              menuOpening.current = true
              setMenuPending(true)
              setMenuFailure(false)
              const bounds = moreControl.current.getBoundingClientRect()
              void (
                menu.current()
                  ? menu.dismiss('replaced')
                  : menu.open(
                      'browser-menu',
                      { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
                      currentMenuData()
                    )
              )
                .catch(() => {
                  if (mounted.current) setMenuFailure(true)
                })
                .finally(() => {
                  menuOpening.current = false
                  if (mounted.current) setMenuPending(false)
                })
            }}
          />
        </Tooltip>
      </form>
      <div
        ref={viewport}
        data-browser-viewport=""
        data-testid="browser-viewport"
        className="relative min-h-0 flex-1 overflow-hidden"
        onPointerDown={sidecar ? (event) => sendPointer(event, 'mousePressed') : undefined}
        onPointerUp={sidecar ? (event) => sendPointer(event, 'mouseReleased') : undefined}
        onPointerMove={sidecar ? (event) => sendPointer(event, 'mouseMoved') : undefined}
        onWheel={
          sidecar
            ? (event) => {
                const bounds = event.currentTarget.getBoundingClientRect()
                const { width, height } = chromium.dimensions.current
                if (!width || !height || !bounds.width || !bounds.height) return
                chromium.input({
                  kind: 'wheel',
                  x: Math.min(
                    width - 1,
                    Math.max(0, Math.floor(((event.clientX - bounds.left) * width) / bounds.width))
                  ),
                  y: Math.min(
                    height - 1,
                    Math.max(0, Math.floor(((event.clientY - bounds.top) * height) / bounds.height))
                  ),
                  deltaX: event.deltaX,
                  deltaY: event.deltaY,
                })
                event.preventDefault()
              }
            : undefined
        }
        onKeyDown={sidecar ? (event) => sendKey(event, 'keyDown') : undefined}
        onKeyUp={sidecar ? (event) => sendKey(event, 'keyUp') : undefined}
        onBlur={
          sidecar
            ? () => {
                for (const pressed of pressedKeys.current.values())
                  chromium.input({ kind: 'key', type: 'keyUp', ...pressed })
                pressedKeys.current.clear()
                if (compositionStarted.current)
                  chromium.input({ kind: 'composition', phase: 'cancel' })
                composing.current = false
                compositionStarted.current = false
              }
            : undefined
        }
        onInput={
          sidecar
            ? (event) => {
                const native = event.nativeEvent as InputEvent
                if (composing.current || native.isComposing) return
                if (native.inputType !== 'insertFromComposition' && native.data)
                  chromium.input({ kind: 'text', text: native.data })
                const inputTarget = event.target as HTMLElement
                inputTarget.textContent = ''
              }
            : undefined
        }
        onCompositionStart={
          sidecar
            ? () => {
                discardCompositionEnd.current = false
                composing.current = true
                compositionStarted.current = false
              }
            : undefined
        }
        onCompositionUpdate={
          sidecar
            ? (event) => {
                if (!event.data) return
                const input = {
                  kind: 'composition' as const,
                  phase: compositionStarted.current ? ('update' as const) : ('begin' as const),
                  text: event.data,
                  selectionStart: event.data.length,
                  selectionEnd: event.data.length,
                }
                compositionStarted.current = true
                chromium.input(input)
              }
            : undefined
        }
        onCompositionEnd={
          sidecar
            ? (event) => {
                if (discardCompositionEnd.current) {
                  discardCompositionEnd.current = false
                  const inputTarget = event.target as HTMLElement
                  inputTarget.textContent = ''
                  return
                }
                if (compositionStarted.current)
                  chromium.input(
                    event.data
                      ? { kind: 'composition', phase: 'commit', text: event.data }
                      : { kind: 'composition', phase: 'cancel' }
                  )
                else if (event.data) chromium.input({ kind: 'text', text: event.data })
                composing.current = false
                compositionStarted.current = false
                const inputTarget = event.target as HTMLElement
                inputTarget.textContent = ''
              }
            : undefined
        }
      >
        {sidecar && !startPage && visibleFrame && (
          <img
            key={`${visibleFrame.tabId}:${visibleFrame.sequence}`}
            src={`data:image/${visibleFrame.format};base64,${visibleFrame.data}`}
            alt=""
            draggable={false}
            className="pointer-events-none absolute inset-0 h-full w-full"
            onLoad={() => chromium.acknowledge(visibleFrame.sequence)}
            onError={() => {
              setError(BROWSER_ERROR.operationFailed)
              chromium.acknowledge(visibleFrame.sequence)
            }}
          />
        )}
        {sidecar && active && !startPage && (
          <div
            contentEditable
            suppressContentEditableWarning
            tabIndex={0}
            role="textbox"
            aria-label={t('title')}
            className="absolute inset-0 cursor-default text-transparent caret-transparent outline-none"
          />
        )}
        {startPage && (
          <Page width="reading" data-testid="browser-start-page" className="h-full overflow-y-auto">
            <PageHeader
              title={t('start.title')}
              description={t('start.description')}
              actions={
                <Button disabled={pending || unavailable} onClick={() => input.current?.focus()}>
                  {t('start.browse')}
                </Button>
              }
            />
            <PageBody>
              <div className="grid min-w-0 gap-[var(--vds-layout-section-gap)] md:grid-cols-2">
                {START_GUIDES.map((guide) => (
                  <Card
                    key={guide.id}
                    className="grid content-start gap-[var(--vds-layout-control-gap)]"
                  >
                    <CardTitle>{t(guide.titleKey)}</CardTitle>
                    <CardDescription>{t(guide.descriptionKey)}</CardDescription>
                  </Card>
                ))}
              </div>
              <p className="m-0 text-[var(--vds-text-tertiary)]">{t('start.privacy')}</p>
            </PageBody>
          </Page>
        )}
      </div>
    </section>
  )
}
