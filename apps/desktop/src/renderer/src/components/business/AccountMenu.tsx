import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Compass,
  Database,
  Gift,
  GraduationCap,
  LogOut,
  MessageCircleQuestionMark,
  Settings
} from 'lucide-react'

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
  type CloudPageAnchor
} from '../../account'
import { getAuthMe, getAuthStatus, type AuthUser } from '../../api'
import { Icon } from '../../icons'
import { logoutDesktopSession } from '../../logout'
import { Button } from '../ui'
import { LanguagePopoverControl } from './Preferences'

// AccountMenu.tsx — 账号 chrome 的单一所有者: 身份解析 + 头像 + 账户菜单 + 退出登录。
//
// 0.1 侧栏底部 (Chrome) 与 0.2 工作台活动栏底部 (ActivityRail) 是同一个头像入口的
// 两个宿主, 二者按 mainView 互斥挂载。PRD 要求「登录后头像入口更新为已登录状态」在
// 任意模块都成立, 所以身份与退出逻辑不能各自持有一份局部 state —— 否则切表面就会
// 出现两处头像不一致。
//
// 身份同步沿用仓库既有的窗口事件契约 (scholarseed:auth-required 清身份 /
// scholarseed:auth-restored 登录成功后重取 / scholarseed:account-updated 改昵称),
// 不新造一套 store 字段: 事件已经是跨表面的广播机制, 再引一份 store 副本会产生
// 「哪个是权威」的第二个答案。
//
// 菜单行序与分组照 PRD 设计稿: 身份头(跳云端个人信息) | 剩余积分(跳云端积分页) +
// 获取更多(直达积分页的补发申请区) + 语言/外观 + 新手引导/问题反馈/设置 | 退出登录。
// 分隔线只出现在组间, 组内靠行距。
// 最后那一行按登录态换内容: 已登录是「退出登录」, 未登录是「登录」—— 登录不再是
// 启动门禁, 这里是它的主要入口 (另一个在设置 → 账号页), 少了它用户就再也登不进去。

const AVATAR_CLASS_NAME =
  'grid size-[26px] flex-none place-items-center rounded-[var(--vds-radius-circle)] bg-[var(--brand-ink)] text-[11px] font-[var(--vds-fw-semibold)] leading-none text-[var(--vds-static-white)]'
const USER_AVATAR_CLASS_NAMES = {
  lg: 'grid size-[38px] flex-none place-items-center rounded-[var(--vds-radius-circle)] border border-[var(--active-border)] bg-[var(--accent-soft)] text-[12px] font-[var(--vds-fw-semibold)] leading-none text-[var(--accent-ink)]',
  md: 'grid size-[28px] flex-none place-items-center rounded-[var(--vds-radius-circle)] border border-[var(--active-border)] bg-[var(--accent-soft)] text-[10px] font-[var(--vds-fw-semibold)] leading-none text-[var(--accent-ink)]',
  sm: 'grid size-[26px] flex-none place-items-center rounded-[var(--vds-radius-circle)] border border-[var(--active-border)] bg-[var(--accent-soft)] text-[10px] font-[var(--vds-fw-semibold)] leading-none text-[var(--accent-ink)]'
}
/** 身份头: 整行可点 (跳云端个人信息页), 无云端地址时退化为纯展示。 */
const MENU_USER_CLASS_NAME =
  'flex h-9 w-full items-center gap-2 rounded-[8px] border-0 bg-transparent p-2 text-left shadow-none disabled:cursor-default'
const MENU_COPY_CLASS_NAME =
  'flex min-w-0 flex-1 items-center [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap'
const MENU_NAME_CLASS_NAME =
  'text-[14px] font-[var(--vds-fw-medium)] leading-[22px] text-[var(--vds-text-primary)]'
const MENU_PHONE_CLASS_NAME =
  'text-[14px] tabular-nums leading-5 text-[var(--text-3)]'
const MENU_ANONYMOUS_CLASS_NAME =
  'flex h-[76px] w-full items-center gap-4 rounded-[8px] border-0 bg-transparent p-2 text-left shadow-none hover:bg-[var(--vds-surface-hover)]'
const MENU_ANONYMOUS_ICON_CLASS_NAME =
  'grid size-7 flex-none place-items-center rounded-[var(--vds-radius-circle)] bg-[var(--vds-other-overlay-1)] text-[var(--vds-text-tertiary)]'
const MENU_ANONYMOUS_COPY_CLASS_NAME = 'grid min-w-0 flex-1 content-center'
const MENU_ANONYMOUS_TITLE_CLASS_NAME =
  'truncate text-[14px] font-[var(--vds-fw-medium)] leading-[22px] text-[var(--vds-text-primary)]'
const MENU_ANONYMOUS_HINT_CLASS_NAME =
  'truncate text-[12px] font-[var(--vds-fw-normal)] leading-[18px] text-[var(--vds-warning-bg-default)]'
/** 组容器: 分隔线画在组顶, 组内行不再各自带线。 */
const MENU_GROUP_CLASS_NAME =
  'mt-2 grid border-t border-[var(--border-soft)] pt-2'
const MENU_ROW_CLASS_NAME =
  'flex h-9 w-full items-center justify-start gap-2 rounded-[8px] border-0 bg-transparent p-2 text-left text-[14px] font-[var(--vds-fw-normal)] leading-5 text-[var(--vds-text-primary)] shadow-none hover:bg-[var(--vds-surface-hover)] hover:text-[var(--vds-text-primary)]'
const MENU_ROW_LABEL_CLASS_NAME = 'min-w-0 flex-1 truncate'
const MENU_ROW_VALUE_CLASS_NAME =
  'ml-auto flex-none tabular-nums text-[var(--vds-text-secondary)]'
const MENU_LOGOUT_CLASS_NAME =
  'flex h-9 w-full items-center justify-start gap-2 rounded-[8px] border-0 bg-transparent p-2 text-left text-[14px] font-[var(--vds-fw-normal)] leading-5 !text-[var(--vds-error-text-primary)] shadow-none hover:bg-[var(--vds-surface-hover)] hover:!text-[var(--vds-error-bg-hover)] disabled:opacity-60'
const MENU_FOOT_CLASS_NAME = 'mt-2 border-t border-[var(--border-soft)] pt-2'
/** 菜单里快捷偏好那一格; 控件与文案本身归 Preferences.tsx。 */
const QUICK_CLASS_NAME = 'flex min-h-9 w-full items-center p-2'
const MENU_ERROR_CLASS_NAME =
  'px-[2px] py-[var(--vds-space-2)] text-[10px] leading-[1.4] text-[var(--c-tension)]'

/** 菜单的视觉基座; 定位由宿主给 (侧栏与活动栏的锚点方向不同)。 */
export const ACCOUNT_MENU_PANEL_CLASS_NAME =
  'no-drag vds-panel z-[90] p-[14px] animate-[cardIn_0.14s_ease_both]'
const ACCOUNT_MENU_EMBEDDED_CLASS_NAME = 'no-drag'

/** 未登录头像里人形图标的边长（头像本身 26px）。 */
const ANONYMOUS_AVATAR_ICON_SIZE = 15
const MENU_ICON_SIZE = 15

export interface AccountIdentity {
  user: AuthUser | null
  profile: AccountProfile | null
  /** 账号服务地址（/api/auth/status 下发）；空 = 云端页跳转 affordance 不出现。 */
  cloudBase: string
}

const userAvatarText = (name: string): string =>
  Array.from(name).slice(0, 2).join('').toUpperCase()

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

  React.useEffect(() => {
    if (!ready) return undefined
    let cancelled = false
    // 账号服务地址由后端下发, 而 account.ts 的每个请求都要它。这里自己取自己设:
    // 子组件的 effect 先于父组件跑, 指望别处先设好地址就会输在时序上。
    void (async () => {
      const status = await getAuthStatus()
      if (cancelled || !status?.account_base_url) return
      setAccountBase(status.account_base_url)
      setCloudBase(status.account_base_url)
      const account = await accountMe()
      if (!cancelled && account.ok) setProfile(account.data)
    })()
    // serve 侧身份不依赖账号服务地址, 与上面那条并行取。
    void getAuthMe().then((me) => {
      if (!cancelled && me?.auth) setUser(me)
    })
    const clear = (): void => {
      setUser(null)
      setProfile(null)
    }
    const restored = (): void => setEpoch((current) => current + 1)
    const renamed = (event: Event): void => {
      const nickname = String(
        (event as CustomEvent<{ nickname?: unknown }>).detail?.nickname || ''
      )
      if (!nickname) return
      setUser((current) =>
        current ? { ...current, nickname, display_name: nickname } : current
      )
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

  return { user, profile, cloudBase }
}

export interface AccountLogout {
  busy: boolean
  error: string
  logout: () => Promise<boolean>
}

/** 退出登录。成功后广播 scholarseed:auth-required, 所有表面的头像一起回到未登录态。 */
export function useAccountLogout(): AccountLogout {
  const { t } = useTranslation('account')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<AccountFailure | null>(null)

  const logout = React.useCallback(async (): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    setError(null)
    const result = await logoutDesktopSession()
    setBusy(false)
    if (!result.ok) {
      setError(result)
      return false
    }
    window.dispatchEvent(new CustomEvent('scholarseed:auth-required'))
    return true
  }, [busy])

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
function useAccountCredits(active: boolean): CreditsState {
  const [state, setState] = React.useState<CreditsState>({
    phase: 'loading',
    balance: null,
    unlimited: false
  })

  React.useEffect(() => {
    if (!active) return
    let cancelled = false
    setState({ phase: 'loading', balance: null, unlimited: false })
    void accountCredits().then((result) => {
      if (cancelled) return
      setState(
        result.ok
          ? {
              phase: 'ready',
              balance: result.data.balance_credits,
              unlimited: result.data.unlimited
            }
          : { phase: 'error', balance: null, unlimited: false }
      )
    })
    return () => {
      cancelled = true
    }
  }, [active])

  return state
}

function CreditsValue({
  credits
}: {
  credits: CreditsState
}): React.JSX.Element {
  const { t, i18n } = useTranslation('components')
  if (credits.phase === 'loading') return <>…</>
  if (credits.phase === 'error') return <>--</>
  if (credits.unlimited) return <>{t('accountMenu.unlimited')}</>
  // 上游没给余额数（旧口径响应 / 降级中途态）与「余额真的是 0」是两回事: 前者显示占位,
  // 后者才显示 0。把未知渲染成 0 等于告诉用户他被清零了。
  if (credits.balance === null) return <>--</>
  return (
    <>
      {new Intl.NumberFormat(i18n.resolvedLanguage, {
        maximumFractionDigits: 0
      }).format(Math.floor(credits.balance))}
    </>
  )
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
  size = 26
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
    <span
      aria-label={t('accountMenu.avatar', { name: label })}
      className={sizeClassName}
    >
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

export function AccountMenu({
  user,
  profile,
  cloudBase,
  className,
  onLogin,
  onLogout,
  onFeedback,
  onSettings,
  onGuide,
  onOpenProfile,
  onOpenCredits,
  logoutBusy,
  logoutError,
  embedded = false
}: {
  /** 未登录时为 null: 菜单本体仍可用 (PRD A8), 只是不出身份头与退出登录 (PRD A7)。 */
  user: AuthUser | null
  profile: AccountProfile | null
  /** 账号服务地址; 空 = 身份头/用量行不出现跳转 affordance (免登录模式无云端账号)。 */
  cloudBase: string
  /** 定位类, 由宿主给: 侧栏锚在 chip 上方, 活动栏锚在头像上方偏右。 */
  className: string
  /** 打开应用内登录层。登录不是门禁, 未登录时这是菜单底部那一行。 */
  onLogin: () => void
  onLogout: () => void
  onFeedback: () => void
  onSettings: () => void
  onGuide: () => void
  onOpenProfile: () => void
  /** 打开云端积分页; 传锚点则定位到页内区域（「获取更多」入口用）。 */
  onOpenCredits: (anchor?: CloudPageAnchor) => void
  logoutBusy: boolean
  logoutError: string
  embedded?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: accountText } = useTranslation('account')
  const name = user ? accountDisplayText(user, profile, accountText) : ''
  const masked = maskPhone(profile?.phone || '')
  const accountLabel = masked || name
  // 设计稿身份头: 主行展示用户名, 副行展示脱敏手机号; 无手机号时保留个人信息入口提示。
  const subtitle = masked || t('accountMenu.profile')
  const canJump = Boolean(cloudBase)
  const credits = useAccountCredits(Boolean(user && canJump))
  return (
    <section
      id="account-menu"
      className={`${embedded ? ACCOUNT_MENU_EMBEDDED_CLASS_NAME : ACCOUNT_MENU_PANEL_CLASS_NAME} ${className}`}
      data-testid="account-menu"
      aria-label={t('accountMenu.title')}
    >
      {user && (
        <Button
          type="button"
          size="content"
          variant="ghost"
          className={MENU_USER_CLASS_NAME}
          data-testid="account-menu-profile"
          title={name}
          disabled={!canJump}
          onClick={onOpenProfile}
        >
          <UserAvatar user={user} displayName={name} size={28} />
          <span className={MENU_COPY_CLASS_NAME}>
            <strong
              className={MENU_NAME_CLASS_NAME}
              data-testid="account-menu-name"
            >
              {accountLabel}
            </strong>
            <span
              className={MENU_PHONE_CLASS_NAME}
              data-testid="account-menu-phone"
              hidden
            >
              {subtitle}
            </span>
          </span>
        </Button>
      )}
      {!user && (
        <Button
          type="button"
          size="content"
          variant="ghost"
          className={MENU_ANONYMOUS_CLASS_NAME}
          data-testid="account-menu-anonymous-login"
          onClick={onLogin}
        >
          <span className={MENU_ANONYMOUS_ICON_CLASS_NAME} aria-hidden>
            <GraduationCap size={16} strokeWidth={1.75} />
          </span>
          <span className={MENU_ANONYMOUS_COPY_CLASS_NAME}>
            <strong className={MENU_ANONYMOUS_TITLE_CLASS_NAME}>
              {t('accountMenu.login')}
            </strong>
            <span className={MENU_ANONYMOUS_HINT_CLASS_NAME}>
              {t('accountMenu.loginHint')}
            </span>
          </span>
        </Button>
      )}
      <div className={MENU_GROUP_CLASS_NAME}>
        {user && canJump && (
          <>
            <Button
              type="button"
              size="content"
              variant="ghost"
              className={MENU_ROW_CLASS_NAME}
              data-testid="account-menu-credits"
              onClick={() => onOpenCredits()}
            >
              <Database size={MENU_ICON_SIZE} strokeWidth={1.75} />
              <span className={MENU_ROW_LABEL_CLASS_NAME}>
                {t('accountMenu.credits')}
              </span>
              <span
                className={MENU_ROW_VALUE_CLASS_NAME}
                data-testid="account-menu-credits-value"
              >
                <CreditsValue credits={credits} />
              </span>
            </Button>
            {/* 余额制下积分是有限资源, 用完就没法继续对话; 补发申请区在云端积分页里,
                所以这里给一条直达锚点的入口, 不在客户端复刻那个区域。 */}
            <Button
              type="button"
              size="content"
              variant="ghost"
              className={MENU_ROW_CLASS_NAME}
              data-testid="account-menu-credits-more"
              onClick={() => onOpenCredits(CLOUD_PAGE_ANCHORS.creditsMore)}
            >
              <Gift size={MENU_ICON_SIZE} strokeWidth={1.75} />
              <span className={MENU_ROW_LABEL_CLASS_NAME}>
                {t('accountMenu.creditsMore')}
              </span>
            </Button>
          </>
        )}
        <LanguagePopoverControl
          className={MENU_ROW_CLASS_NAME}
          iconSize={MENU_ICON_SIZE}
        />
        {/* 新手引导入口：由宿主打开统一引导中心。 */}
        <Button
          type="button"
          className={MENU_ROW_CLASS_NAME}
          data-testid="account-menu-guide"
          size="content"
          variant="ghost"
          onClick={onGuide}
        >
          <Compass size={MENU_ICON_SIZE} strokeWidth={1.75} />
          {t('accountMenu.guide')}
        </Button>
        <Button
          type="button"
          className={MENU_ROW_CLASS_NAME}
          data-testid="account-menu-feedback"
          size="content"
          variant="ghost"
          onClick={onFeedback}
        >
          <MessageCircleQuestionMark size={MENU_ICON_SIZE} strokeWidth={1.75} />
          {t('accountMenu.feedback')}
        </Button>
        <Button
          type="button"
          className={MENU_ROW_CLASS_NAME}
          data-testid="account-menu-settings"
          size="content"
          variant="ghost"
          onClick={onSettings}
        >
          <Settings size={MENU_ICON_SIZE} strokeWidth={1.75} />
          {t('accountMenu.settings')}
        </Button>
      </div>
      {logoutError && (
        <div role="alert" className={MENU_ERROR_CLASS_NAME}>
          {logoutError}
        </div>
      )}
      {user && (
        <div className={MENU_FOOT_CLASS_NAME}>
          <Button
            type="button"
            disabled={logoutBusy}
            className={MENU_LOGOUT_CLASS_NAME}
            data-testid="account-menu-logout"
            size="content"
            variant="ghost"
            onClick={onLogout}
          >
            <LogOut size={MENU_ICON_SIZE} strokeWidth={1.75} />
            {logoutBusy ? t('accountMenu.loggingOut') : t('accountMenu.logout')}
          </Button>
        </div>
      )}
    </section>
  )
}
