import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '../../components/ui'
import { menuActions, type MenuDismissReason, type MenuItem, type MenuModel, type MenuViewBridge } from '../../../../menu'
import { AccountMenuPanel } from '../../components/business/AccountMenuPanel'
import { accountMenuText } from '../../components/business/accountview'
import { FindPanel } from './Find'
import type { FindState } from '../../../../browser'
import { createLocalization } from '../../../../localization/engine'
import english from '../../../../localization/locales/en/browser.json'
import chinese from '../../../../localization/locales/zh/browser.json'

const localizations = {
  en: createLocalization('en', { en: { browser: english }, zh: { browser: chinese } }),
  'zh-CN': createLocalization('zh', { en: { browser: english }, zh: { browser: chinese } })
}
const FIND_SURFACE_SELECTOR = '[role="menu"], [role="region"]'

function Submenu({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement | null>(null)
  return <DropdownMenuSub open={open} onOpenChange={setOpen}>
    <DropdownMenuSubTrigger onFocus={event => { trigger.current = event.currentTarget }}>{label}</DropdownMenuSubTrigger>
    <DropdownMenuSubContent onKeyDown={event => {
      if (event.key !== 'ArrowLeft') return
      event.preventDefault()
      setOpen(false)
      trigger.current?.focus({ preventScroll: true })
    }}>{children}</DropdownMenuSubContent>
  </DropdownMenuSub>
}

export function Menu({ bridge }: { bridge: MenuViewBridge }): JSX.Element | null {
  const [model, setModel] = useState<MenuModel | null>(null)
  const latest = useRef(model)
  latest.current = model
  const reason = useRef<MenuDismissReason>('outside')
  const busy = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const focusedSession = useRef<string | null>(null)
  const querySequence = useRef(0)
  const [text, setText] = useState('')
  const [found, setFound] = useState<FindState | null>(null)
  const [findFailed, setFindFailed] = useState(false)
  const focusFind = (): void => { input.current?.focus({ preventScroll: true }); input.current?.select() }
  useEffect(() => {
    const removeFound = bridge.subscribeFind?.(state => {
      const current = latest.current
      if (current?.surface !== 'browser-find' || state.sessionId !== current.sessionId || state.revision !== current.revision || state.querySequence !== querySequence.current) return
      setFound(state)
      setFindFailed(false)
    })
    const removeFocus = bridge.subscribeRefocus?.(ack => {
      if (latest.current?.sessionId === ack.sessionId && latest.current.revision === ack.revision) focusFind()
    })
    return () => { removeFound?.(); removeFocus?.() }
  }, [bridge])
  useEffect(() => {
    let active = true
    const update = (model: MenuModel): void => {
      if (!active) return
      console.info('Menu model received', model.revision)
      document.documentElement.classList.toggle('dark', model.theme === 'dark')
      document.documentElement.dataset.theme = model.theme
      document.documentElement.lang = model.language
      setModel(current => current && (current.sessionId !== model.sessionId || current.revision > model.revision) ? current : model)
    }
    const unsubscribe = bridge.subscribe(update)
    console.info('Menu React subscribed')
    void bridge.seed().then(model => { if (model) update(model) }).catch(error => console.error('Menu seed failed', error))
    return () => { active = false; unsubscribe() }
  }, [bridge])
  useEffect(() => {
    if (!model) return
    console.info('Menu React paint scheduled', model.revision)
    let firstFrame = 0
    let paintedFrame = 0
    firstFrame = requestAnimationFrame(() => {
      console.info('Menu React first frame', model.revision)
      paintedFrame = requestAnimationFrame(() => {
        console.info('Menu React painted frame', model.revision)
        void bridge.paintReady({ sessionId: model.sessionId, revision: model.revision }).then(reply => {
          if (reply.ok && model.surface === 'browser-find' && latest.current?.sessionId === model.sessionId && focusedSession.current !== model.sessionId) {
            focusedSession.current = model.sessionId
            focusFind()
          }
        }).catch(() => {
          void bridge.send({ kind: 'dismiss', sessionId: model.sessionId, revision: model.revision, reason: 'invalid' }).catch(error => console.error('Menu paint dismissal failed', error))
        })
      })
    })
    return () => { cancelAnimationFrame(firstFrame); cancelAnimationFrame(paintedFrame) }
  }, [bridge, model])
  useEffect(() => {
    const outside = (event: MouseEvent): boolean => !(event.target instanceof Element && event.target.closest(FIND_SURFACE_SELECTOR))
    const pointer = (event: PointerEvent): void => {
      reason.current = 'outside'
      if (outside(event)) { event.preventDefault(); event.stopImmediatePropagation() }
    }
    const click = (event: MouseEvent): void => {
      if (!model || !outside(event)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      void bridge.send({ kind: 'dismiss', sessionId: model.sessionId, revision: model.revision, reason: 'outside' })
    }
    const key = (event: KeyboardEvent): void => {
      if (model?.surface === 'browser-find' && !event.isComposing && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f'
        && (navigator.platform.startsWith('Mac') ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) {
        event.preventDefault()
        focusFind()
        return
      }
      if (event.key !== 'Escape') return
      reason.current = 'escape'
      if (!model || document.activeElement?.closest('[role="menu"]')) return
      event.preventDefault()
      void bridge.send({ kind: 'dismiss', sessionId: model.sessionId, revision: model.revision, reason: 'escape' })
    }
    document.addEventListener('pointerdown', pointer, true)
    document.addEventListener('click', click, true)
    document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('pointerdown', pointer, true); document.removeEventListener('click', click, true); document.removeEventListener('keydown', key, true) }
  }, [bridge, model])
  if (!model) return null
  const send = (event: Parameters<MenuViewBridge['send']>[0]): void => {
    void bridge.send(event).then(reply => {
      if (!reply.ok && event.kind === 'action') return bridge.send({ kind: 'dismiss', sessionId: model.sessionId, revision: model.revision, reason: 'invalid' })
      return undefined
    }).catch(() => {
      void bridge.send({ kind: 'dismiss', sessionId: model.sessionId, revision: model.revision, reason: 'invalid' }).catch(error => console.error('Menu action dismissal failed', error))
    }).finally(() => { busy.current = false })
  }
  const dismiss = (): void => {
    const current = latest.current
    if (current) send({ kind: 'dismiss', sessionId: current.sessionId, revision: current.revision, reason: reason.current })
  }
  const find = (text: string, direction: 'forward' | 'backward'): void => {
    const sequence = ++querySequence.current
    setFound(null)
    setFindFailed(false)
    void bridge.send({ kind: 'find', sessionId: model.sessionId, revision: model.revision, requestId: crypto.randomUUID(), querySequence: sequence, text, direction }).then(reply => {
      if (!reply.ok && querySequence.current === sequence) setFindFailed(true)
    }).catch(() => { if (querySequence.current === sequence) setFindFailed(true) })
  }
  if (model.surface === 'browser-find') {
    const translate = localizations[model.language].getFixedT(null, 'browser')
    return <FindPanel anchor={model.anchor} input={input} text={text} labels={{ title: translate('find.title'), previous: translate('find.previous'), next: translate('find.next'), close: translate('find.close'),
      status: findFailed ? translate('find.failed') : !text ? '' : found?.phase === 'ready' ? translate('find.count', { matchIndex: found.ordinal, total: found.count }) : translate('find.waiting') }}
      onText={(next, composing) => { setText(next); if (!composing) find(next, 'forward'); else { querySequence.current += 1; setFound(null) } }} onSubmit={direction => find(text, direction)}
      onClose={() => { reason.current = 'escape'; dismiss() }} />
  }
  const items = (values: MenuItem[], glyph?: string): JSX.Element[] => values.map(item => {
    if (item.kind === 'separator') return <DropdownMenuSeparator key={item.id} />
    if (item.kind === 'submenu') return <Submenu key={item.id} label={item.label}>{items(item.items)}</Submenu>
    if (item.kind === 'zoom') return <div key={item.id} role="group" aria-label={item.label} className="flex items-center gap-[var(--vds-space-1)]">
      <DropdownMenuLabel>{item.label}</DropdownMenuLabel>
      {items(item.items.slice(0, 1), '−')}<span className="shrink-0 text-[var(--vds-text-secondary)]">{item.percentage}%</span>{items(item.items.slice(1, 2), '+')}{items(item.items.slice(2))}
    </div>
    const Item = item.value.kind === 'boolean' ? DropdownMenuCheckboxItem : DropdownMenuItem
    return <Item key={item.id} aria-label={glyph ? item.label : undefined} disabled={item.disabled} checked={item.checked} onClick={event => {
      event.preventDefault()
      if (busy.current || item.disabled) return
      busy.current = true
      send({ kind: 'action', sessionId: model.sessionId, revision: model.revision, requestId: crypto.randomUUID(), actionId: item.actionId, value: item.value })
    }}>{glyph ?? item.label}</Item>
  })
  const anchor = model.anchor
  const account = model.surface === 'account-menu' ? model.account : undefined
  return <DropdownMenu open onOpenChange={open => { if (!open) dismiss() }}>
    <DropdownMenuContent trapFocus side={account ? 'top' : 'bottom'} align={account ? 'start' : 'end'} aria-label={account ? accountMenuText(account.locale)('accountMenu.title') : undefined}
      data-testid={account ? 'account-menu' : undefined} className={account ? 'w-[var(--vds-popover-width-md)]' : undefined}
      position={{ kind: 'anchor', left: anchor.x, right: anchor.x + anchor.width, top: anchor.y, bottom: anchor.y + anchor.height, width: anchor.width }}>
      {account ? <AccountMenuPanel view={account} onAction={(action, value) => {
        const item = menuActions(model.items).find(item => item.actionId === action && !item.disabled && JSON.stringify(item.value) === JSON.stringify(value))
        if (busy.current || !item) return
        busy.current = true
        send({ kind: 'action', sessionId: model.sessionId, revision: model.revision, requestId: crypto.randomUUID(), actionId: action, value })
      }} /> : items(model.items)}
    </DropdownMenuContent>
  </DropdownMenu>
}
