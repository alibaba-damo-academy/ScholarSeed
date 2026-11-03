import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  CLOUD_PAGE_ANCHORS,
  accountCredits,
  accountDisplayText,
  accountFailureText,
  accountMe,
  cloudPageUrl,
  maskPhone,
  setAccountBase,
  type AccountProfile,
  type AccountFailure,
  type CloudPage,
  type CloudPageAnchor,
} from '../../account'
import { getAuthMe, getAuthStatus, type AuthUser } from '../../api'
import { Icon } from '../../icons'
import { logoutDesktopSession } from '../../logout'
import { useApp } from '../../store'
import {
  MENU_ACTION,
  type AccountMenuAction,
  type AccountMenuView,
  type MenuDismissReason,
  type MenuPresentationReply,
  type MenuValue,
} from '../../../../menu'
import { createMenuPresenter, type MenuPresentationModel } from '../primitive/presenter'
import { DropdownMenu, DropdownMenuContent, useToast } from '../ui'
import { AccountMenuPanel } from './AccountMenuPanel'
import {
  accountActionAllowed,
  accountAlias,
  accountMenuItems,
  type AccountMenuLease,
} from './accountview'

const AVATAR_CLASS_NAME =
  'grid size-[26px] flex-none place-items-center rounded-[var(--vds-radius-circle)] bg-[var(--brand-ink)] text-[11px] font-[var(--vds-fw-semibold)] leading-none text-[var(--vds-static-white)]'
const USER_AVATAR_CLASS_NAMES = {
  lg: 'grid size-[38px] flex-none place-items-center rounded-[var(--vds-radius-circle)] border border-[var(--active-border)] bg-[var(--accent-soft)] text-[12px] font-[var(--vds-fw-semibold)] leading-none text-[var(--accent-ink)]',
  md: 'grid size-[28px] flex-none place-items-center rounded-[var(--vds-radius-circle)] border border-[var(--active-border)] bg-[var(--accent-soft)] text-[10px] font-[var(--vds-fw-semibold)] leading-none text-[var(--accent-ink)]',
  sm: 'grid size-[26px] flex-none place-items-center rounded-[var(--vds-radius-circle)] border border-[var(--active-border)] bg-[var(--accent-soft)] text-[10px] font-[var(--vds-fw-semibold)] leading-none text-[var(--accent-ink)]',
}

const ANONYMOUS_AVATAR_ICON_SIZE = 15
const ACCOUNT_LOGOUT_FAILURE: AccountFailure = {
  ok: false,
  code: 'local_logout_failed',
  error: '',
  applicationFailure: { code: 'local_logout_failed' },
}

export interface AccountIdentity {
  user: AuthUser | null
  profile: AccountProfile | null
  /** 账号服务地址（/api/auth/status 下发）；空 = 云端页跳转 affordance 不出现。 */
  cloudBase: string
  revision: number
}

const userAvatarText = (name: string): string => Array.from(name).slice(0, 2).join('').toUpperCase()

/**
 * 解析当前账号身份, 并跟随登录态变化。
 *
 * `ready` 为 false 时不发请求 —— 后端没起来时打 `/api/auth/me` 只会拿到一次
 * 无意义的失败, 而 backendReady 翻真后本 hook 会重新取。
 *
 * 登录不是门禁, 外壳在未登录期间就已挂载, 所以身份必须能在登录成功后重取:
 * `scholarseed:auth-restored` 把 epoch 加一, 同一段取数逻辑再跑一遍, 不另抄一份。
 */
export function useAccountIdentity(ready: boolean): AccountIdentity {
  const [user, setUser] = React.useState<AuthUser | null>(null)
  const [profile, setProfile] = React.useState<AccountProfile | null>(null)
  const [cloudBase, setCloudBase] = React.useState('')
  const [epoch, setEpoch] = React.useState(0)
  const [revision, setRevision] = React.useState(0)
  const requests = React.useRef(0)

  React.useEffect(() => {
    if (!ready) return undefined
    let cancelled = false
    const request = ++requests.current
    // 账号服务地址由后端下发, 而 account.ts 的每个请求都要它。这里自己取自己设:
    // 子组件的 effect 先于父组件跑, 指望别处先设好地址就会输在时序上。
    void (async () => {
      const status = await getAuthStatus()
      if (cancelled || request !== requests.current || !status?.account_base_url) return
      setAccountBase(status.account_base_url)
      setCloudBase(status.account_base_url)
      const account = await accountMe()
      if (!cancelled && request === requests.current && account.ok) setProfile(account.data)
    })()
    // serve 侧身份不依赖账号服务地址, 与上面那条并行取。
    void getAuthMe().then((me) => {
      if (!cancelled && request === requests.current && me?.auth) setUser(me)
    })
    const clear = (): void => {
      requests.current += 1
      setRevision((current) => current + 1)
      setUser(null)
      setProfile(null)
    }
    const restored = (): void => {
      requests.current += 1
      setRevision((current) => current + 1)
      setEpoch((current) => current + 1)
    }
    const renamed = (event: Event): void => {
      const nickname = String((event as CustomEvent<{ nickname?: unknown }>).detail?.nickname || '')
      if (!nickname) return
      setUser((current) => (current ? { ...current, nickname, display_name: nickname } : current))
      setProfile((current) => (current ? { ...current, nickname } : current))
    }
    window.addEventListener('scholarseed:auth-required', clear)
    window.addEventListener('scholarseed:auth-restored', restored)
    window.addEventListener('scholarseed:account-updated', renamed)
    return () => {
      cancelled = true
      window.removeEventListener('scholarseed:auth-required', clear)
      window.removeEventListener('scholarseed:auth-restored', restored)
      window.removeEventListener('scholarseed:account-updated', renamed)
    }
  }, [epoch, ready])

  return { user, profile, cloudBase, revision }
}

export interface AccountLogout {
  busy: boolean
  error: string
  logout: (afterSuccess?: () => Promise<void>) => Promise<boolean>
}

/** 退出登录。成功后广播 scholarseed:auth-required, 所有表面的头像一起回到未登录态。 */
export function useAccountLogout(identity = ''): AccountLogout {
  const { t } = useTranslation('account')
  const [busy, setBusy] = React.useState(false)
  const current = React.useRef(identity)
  current.current = identity
  const active = React.useRef<{ identity: string; epoch: number } | null>(null)
  const epoch = React.useRef(0)
  const mounted = React.useRef(true)
  const [error, setError] = React.useState<AccountFailure | null>(null)

  const logout = React.useCallback(async (afterSuccess?: () => Promise<void>): Promise<boolean> => {
    if (active.current?.identity === current.current && active.current.epoch === epoch.current)
      return false
    const expected = current.current
    const requested = epoch.current
    const flight = { identity: expected, epoch: requested }
    active.current = flight
    setBusy(true)
    setError(null)
    let result: Awaited<ReturnType<typeof logoutDesktopSession>>
    try {
      result = await logoutDesktopSession()
    } catch {
      result = ACCOUNT_LOGOUT_FAILURE
    }
    if (active.current === flight) active.current = null
    if (!mounted.current || expected !== current.current || requested !== epoch.current)
      return false
    setBusy(false)
    if (!result.ok) {
      setError(result)
      return false
    }
    await afterSuccess?.()
    if (!mounted.current || expected !== current.current || requested !== epoch.current)
      return false
    window.dispatchEvent(new CustomEvent('scholarseed:auth-required'))
    return true
  }, [])

  React.useEffect(() => {
    setBusy(false)
    setError(null)
  }, [identity])
  React.useEffect(() => {
    mounted.current = true
    const invalidate = (): void => {
      epoch.current += 1
      setBusy(false)
      setError(null)
    }
    window.addEventListener('scholarseed:auth-required', invalidate)
    window.addEventListener('scholarseed:auth-restored', invalidate)
    return () => {
      mounted.current = false
      epoch.current += 1
      window.removeEventListener('scholarseed:auth-required', invalidate)
      window.removeEventListener('scholarseed:auth-restored', invalidate)
    }
  }, [])
  return { busy, error: error ? accountFailureText(error, t) : '', logout }
}

interface CreditsState {
  phase: 'loading' | 'ready' | 'error'
  /** 可用余额（注册赠送 + 补发, 逐笔核销后的余量）; null = 上游没给数。 */
  balance: number | null
  unlimited: boolean
}

/**
 * 菜单打开期间取一次本人积分余额。网关未配置/降级走 error 占位 ——
 * 把失败渲染成「0 积分」会让用户以为自己被清零了。
 */
function useAccountCredits(active: boolean, identityRevision: number): CreditsState {
  const [state, setState] = React.useState<CreditsState>({
    phase: 'loading',
    balance: null,
    unlimited: false,
  })
  const settled = React.useRef(identityRevision)
  const current = React.useRef({ active, identityRevision })
  current.current = { active, identityRevision }

  React.useEffect(() => {
    if (!active) return
    let cancelled = false
    settled.current = identityRevision
    setState({ phase: 'loading', balance: null, unlimited: false })
    void accountCredits().then((result) => {
      if (
        cancelled ||
        !current.current.active ||
        identityRevision !== current.current.identityRevision
      )
        return
      setState(
        result.ok
          ? {
              phase: 'ready',
              balance: result.data.balance_credits,
              unlimited: result.data.unlimited,
            }
          : { phase: 'error', balance: null, unlimited: false }
      )
    })
    return () => {
      cancelled = true
    }
  }, [active, identityRevision])

  return settled.current === identityRevision
    ? state
    : { phase: 'loading', balance: null, unlimited: false }
}

/** 跳云端网页（个人信息 / 积分页, 可指定页内锚点）。地址未下发时静默不跳，不弹错。 */
export function openCloudPage(page: CloudPage, anchor?: CloudPageAnchor): void {
  const url = cloudPageUrl(page, anchor)
  if (url && window.scholarseed?.openExternal) void window.scholarseed.openExternal(url)
}

/** 已登录头像: 颜色底色 + 账户昵称字符 (PRD「账号入口与快捷设置」②)。 */
export function UserAvatar({
  user,
  displayName,
  size = 26,
}: {
  user: AuthUser
  displayName?: string
  size?: number
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: accountText } = useTranslation('account')
  const label = displayName ?? accountDisplayText(user, null, accountText)
  const sizeClassName =
    size <= 26
      ? USER_AVATAR_CLASS_NAMES.sm
      : size <= 28
        ? USER_AVATAR_CLASS_NAMES.md
        : USER_AVATAR_CLASS_NAMES.lg
  return (
    <span aria-label={t('accountMenu.avatar', { name: label })} className={sizeClassName}>
      {userAvatarText(label)}
    </span>
  )
}

/** 未登录头像: PRD 要求「通用用户头像」, 不是品牌字。与已登录头像同尺寸, 避免登录前后入口跳动。 */
export function AnonymousAvatar(): React.JSX.Element {
  return (
    <span className={AVATAR_CLASS_NAME} aria-hidden>
      <Icon name="user" size={ANONYMOUS_AVATAR_ICON_SIZE} />
    </span>
  )
}

interface AccountMenuProps {
  user: AuthUser | null
  profile: AccountProfile | null
  cloudBase: string
  identityRevision: number
  open: boolean
  trigger: React.RefObject<HTMLButtonElement | null>
  onClose(): void
  onLogin(): void
  onLogout(afterSuccess?: () => Promise<void>): Promise<boolean>
  onSettings(): void
  onGuide(): void
  onOpenProfile(): void
  onOpenCredits(anchor?: CloudPageAnchor): void
  logoutBusy: boolean
  logoutError: string
}
export function AccountMenu(props: AccountMenuProps): React.JSX.Element | null {
  const { state, act } = useApp()
  const { t: accountText } = useTranslation('account')
  const { t } = useTranslation('components')
  const [presenter] = React.useState(() =>
    window.scholarseed.menu ? createMenuPresenter(window.scholarseed.menu, 'account-menu') : null
  )
  const { toast } = useToast()
  const [presentation, setPresentation] = React.useState<MenuPresentationReply | null>(
    window.scholarseed.menu ? null : { ok: true, revision: 1, presentation: 'inline' }
  )
  const [failure, setFailure] = React.useState(0)
  const presentationFailed = React.useRef(false)
  React.useEffect(() => {
    if (failure) toast({ title: t('accountMenu.presentationFailed'), tone: 'error' })
  }, [failure, toast, t])
  const identity = `${props.identityRevision}:${props.user?.user_id ?? ''}:${props.profile?.user_id ?? ''}:${props.cloudBase}`
  const identityRef = React.useRef(identity)
  const revisions = React.useRef<AccountMenuLease>({ identityRevision: 1, menuRevision: 1 })
  if (identityRef.current !== identity) {
    identityRef.current = identity
    revisions.current = {
      identityRevision: revisions.current.identityRevision + 1,
      menuRevision: revisions.current.menuRevision + 1,
    }
  }
  const previousOpen = React.useRef(props.open)
  if (previousOpen.current !== props.open) {
    previousOpen.current = props.open
    revisions.current = { ...revisions.current, menuRevision: revisions.current.menuRevision + 1 }
  }
  const credits = useAccountCredits(
    props.open && Boolean(props.user && props.cloudBase),
    revisions.current.identityRevision
  )
  const availableActions: AccountMenuAction[] = [
    MENU_ACTION.language,
    MENU_ACTION.guide,
    MENU_ACTION.settings,
    ...(props.user ? [MENU_ACTION.logout] : [MENU_ACTION.login]),
    ...(props.user && props.cloudBase
      ? [MENU_ACTION.profile, MENU_ACTION.credits, MENU_ACTION.creditsMore]
      : []),
  ]
  const alias = props.user
    ? accountAlias(
        maskPhone(props.profile?.phone || '') ||
          accountDisplayText(props.user, props.profile, accountText)
      )
    : null
  const view: AccountMenuView = {
    alias,
    avatar: alias ? Array.from(alias).slice(0, 2).join('').toUpperCase() : '',
    credits: { phase: credits.phase, value: credits.balance, unlimited: credits.unlimited },
    availableActions,
    logoutBusy: props.logoutBusy,
    logoutError: props.logoutError || null,
    locale: state.lang === 'en' ? 'en' : 'zh-CN',
  }
  const live = React.useRef({ props, view, lease: { ...revisions.current } })
  live.current = { props, view, lease: { ...revisions.current } }
  const opening = React.useRef<AccountMenuLease | null>(null)
  const executing = React.useRef<AccountMenuLease | null>(null)
  const qualifier = React.useRef<MenuPresentationReply | null>(presentation)
  const openedIdentity = React.useRef<number | null>(null)
  const close = React.useCallback(
    async (reason: MenuDismissReason): Promise<void> => {
      const expected = { ...live.current.lease }
      opening.current = null
      await presenter?.dismiss(reason)
      if (
        expected.identityRevision === live.current.lease.identityRevision &&
        expected.menuRevision === live.current.lease.menuRevision
      ) {
        if (reason === 'escape') live.current.props.trigger.current?.focus({ preventScroll: true })
        live.current.props.onClose()
      }
    },
    [presenter]
  )
  const execute = React.useCallback(
    async (action: AccountMenuAction, value: MenuValue): Promise<void> => {
      const expected = opening.current
      const current = live.current
      if (
        !expected ||
        (executing.current?.identityRevision === expected.identityRevision &&
          executing.current.menuRevision === expected.menuRevision) ||
        !accountActionAllowed(
          expected,
          {
            ...current.lease,
            open: current.props.open,
            busy: current.props.logoutBusy,
            availableActions: current.view.availableActions,
          },
          action
        )
      )
        return
      if (action === MENU_ACTION.language) {
        if (value.kind !== 'choice' || !['en', 'zh-CN'].includes(value.value)) return
        await act.setLang(value.value === 'en' ? 'en' : 'zh', () => close('action'))
        return
      }
      if (value.kind !== 'none') return
      if (action === MENU_ACTION.logout) {
        executing.current = expected
        try {
          await current.props.onLogout(async () => {
            if (
              accountActionAllowed(
                expected,
                {
                  ...live.current.lease,
                  open: live.current.props.open,
                  busy: false,
                  availableActions: live.current.view.availableActions,
                },
                action
              )
            )
              await close('action')
          })
        } finally {
          if (executing.current === expected) executing.current = null
        }
        return
      }
      executing.current = expected
      await close('action')
      if (executing.current === expected) executing.current = null
      if (
        expected.identityRevision !== live.current.lease.identityRevision ||
        opening.current ||
        live.current.lease.menuRevision > expected.menuRevision + 1
      )
        return
      const callbacks: Partial<Record<AccountMenuAction, () => void>> = {
        [MENU_ACTION.login]: current.props.onLogin,
        [MENU_ACTION.profile]: current.props.onOpenProfile,
        [MENU_ACTION.credits]: () => current.props.onOpenCredits(),
        [MENU_ACTION.creditsMore]: () =>
          current.props.onOpenCredits(CLOUD_PAGE_ANCHORS.creditsMore),
        [MENU_ACTION.guide]: current.props.onGuide,
        [MENU_ACTION.settings]: current.props.onSettings,
      }
      callbacks[action]?.()
    },
    [act, close]
  )
  const executeRef = React.useRef(execute)
  executeRef.current = execute
  React.useEffect(() => {
    const bridge = window.scholarseed.menu
    if (!bridge) return
    let active = true
    const update = (reply: MenuPresentationReply): void => {
      if (!active || (qualifier.current && reply.revision <= qualifier.current.revision)) return
      const previous = qualifier.current
      qualifier.current = reply
      setPresentation(reply)
      if (
        previous &&
        opening.current &&
        (previous.ok !== reply.ok ||
          (previous.ok && reply.ok && previous.presentation !== reply.presentation))
      )
        void close('target')
    }
    const unsubscribe = bridge.subscribePresentation(update)
    void bridge
      .presentation()
      .then(update)
      .catch(() => {
        if (active) {
          presentationFailed.current = true
          console.info('[account-menu]', JSON.stringify({ stage: 'presentation-failed' }))
          if (live.current.props.open) setFailure((revision) => revision + 1)
          void close('invalid')
        }
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [close])
  React.useEffect(() => {
    if (!presenter) return
    const unsubscribe = presenter.subscribe((model, reason) => {
      if (model || reason === 'action' || (reason === 'replaced' && !opening.current)) return
      if (reason === 'invalid' || reason === 'crash' || reason === 'timeout') {
        console.info('[account-menu]', JSON.stringify({ stage: 'failed', reason }))
        setFailure((revision) => revision + 1)
      }
      if (reason === 'escape') live.current.props.trigger.current?.focus({ preventScroll: true })
      if (reason) {
        opening.current = null
        live.current.props.onClose()
      }
    })
    const actions = presenter.subscribeAction((event) => {
      void executeRef.current(event.actionId as AccountMenuAction, event.value)
    })
    return () => {
      unsubscribe()
      actions()
      presenter.dispose()
    }
  }, [presenter])
  const model = React.useCallback(
    (): MenuPresentationModel => ({
      request: { surface: 'account-menu', identityRevision: live.current.lease.identityRevision },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
      language: live.current.view.locale,
      account: live.current.view,
      items: accountMenuItems(live.current.view),
    }),
    []
  )
  const projected = React.useRef<{ lease: AccountMenuLease; snapshot: string } | null>(null)
  const projecting = React.useRef<AccountMenuLease | null>(null)
  const synchronize = React.useCallback(
    async (expected: AccountMenuLease): Promise<void> => {
      if (projecting.current === expected) return
      projecting.current = expected
      try {
        while (
          opening.current === expected &&
          live.current.props.open &&
          expected.identityRevision === live.current.lease.identityRevision &&
          expected.menuRevision === live.current.lease.menuRevision &&
          presenter?.current()
        ) {
          const desired = model()
          const snapshot = JSON.stringify(desired)
          if (projected.current?.lease === expected && projected.current.snapshot === snapshot)
            return
          projected.current = { lease: expected, snapshot }
          await presenter.update(desired)
        }
      } catch {
        if (opening.current === expected) {
          setFailure((revision) => revision + 1)
          void close('invalid')
        }
      } finally {
        if (projecting.current === expected) projecting.current = null
      }
    },
    [presenter, model, close]
  )
  React.useLayoutEffect(() => {
    if (!props.open) {
      opening.current = null
      openedIdentity.current = null
      void presenter?.dismiss('outside')
      return
    }
    if (
      openedIdentity.current !== null &&
      openedIdentity.current !== revisions.current.identityRevision
    ) {
      void close('target')
      return
    }
    console.info(
      '[account-menu]',
      JSON.stringify({
        stage: 'open-requested',
        menuRevision: revisions.current.menuRevision,
        presentationRevision: presentation?.revision,
        presentation: presentation?.ok ? presentation.presentation : 'unavailable',
      })
    )
    if (!presentation) {
      if (presentationFailed.current) {
        setFailure((revision) => revision + 1)
        void close('invalid')
      }
      return
    }
    if (!presentation.ok) {
      console.info(
        '[account-menu]',
        JSON.stringify({ stage: 'presentation-rejected', revision: presentation.revision })
      )
      setFailure((revision) => revision + 1)
      void close('invalid')
      return
    }
    const expected = { ...revisions.current }
    opening.current = expected
    openedIdentity.current = expected.identityRevision
    setFailure(0)
    if (presentation.presentation === 'native') {
      const bounds = props.trigger.current?.getBoundingClientRect()
      if (!bounds || !bounds.width || !bounds.height || !presenter) {
        setFailure((revision) => revision + 1)
        console.info('[account-menu]', JSON.stringify({ stage: 'anchor-invalid' }))
        void close('invalid')
        return
      }
      const initial = model()
      projected.current = { lease: expected, snapshot: JSON.stringify(initial) }
      void presenter
        .open(
          'account-menu',
          { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          initial
        )
        .then(() => synchronize(expected))
        .catch(() => {
          if (opening.current === expected) {
            setFailure((revision) => revision + 1)
            void close('invalid')
          }
        })
    }
    return () => {
      opening.current = null
      void presenter?.dismiss('target')
    }
  }, [
    props.open,
    revisions.current.identityRevision,
    presentation?.ok,
    presentation?.revision,
    presenter,
    close,
    model,
    synchronize,
  ])
  const serialized = JSON.stringify(view)
  const inline = presentation?.ok && presentation.presentation === 'inline'
  React.useEffect(() => {
    if (!props.open || !inline) return
    const blurred = (): void => {
      void close('blur')
    }
    const resized = (): void => {
      void close('resize')
    }
    window.addEventListener('blur', blurred)
    window.addEventListener('resize', resized)
    return () => {
      window.removeEventListener('blur', blurred)
      window.removeEventListener('resize', resized)
    }
  }, [props.open, inline, close])
  React.useEffect(() => {
    const update = (): void => {
      const expected = opening.current
      if (expected) void synchronize(expected)
    }
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => observer.disconnect()
  }, [serialized, synchronize])
  if (failure) return null
  if (!props.open || !presentation?.ok || presentation.presentation !== 'inline') return null
  const anchor = props.trigger.current?.getBoundingClientRect()
  if (!anchor) return null
  return (
    <DropdownMenu
      open
      onOpenChange={(open) => {
        if (!open) void close('outside')
      }}
    >
      <DropdownMenuContent
        id={props.trigger.current?.getAttribute('aria-controls') ?? undefined}
        side="top"
        align="start"
        aria-label={t('accountMenu.title')}
        data-testid="account-menu"
        className="no-drag grid-cols-1 min-w-[var(--vds-popover-width-sm)] max-w-[var(--vds-popover-width-md)]"
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            event.key !== 'Escape' ||
            (event.target as HTMLElement).closest('[role="menu"]') !== event.currentTarget
          )
            return
          event.preventDefault()
          void close('escape')
        }}
        position={{
          kind: 'anchor',
          left: anchor.left,
          right: anchor.right,
          top: anchor.top,
          bottom: anchor.bottom,
          width: anchor.width,
        }}
      >
        <AccountMenuPanel
          view={view}
          onAction={(action, value) => {
            void execute(action, value)
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
