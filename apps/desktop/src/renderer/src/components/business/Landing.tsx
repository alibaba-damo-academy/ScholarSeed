import React from 'react'
import { useTranslation } from 'react-i18next'

import { loginFailureText, type LoginFailure } from './login'
import { confirmAdoptedSession } from '../../account'
import bannerImage1 from '../../assets/banner1.webp'
import bannerImage2 from '../../assets/banner2.webp'
import bannerImage3 from '../../assets/banner3.webp'
import bannerImage4 from '../../assets/banner4.webp'
import loginLogoEn from '../../assets/login-logo-en.webp'
import loginLogoZh from '../../assets/login-logo-zh.webp'
import { Icon } from '../../icons'
import { useApp } from '../../store'
import { LanguagePopoverControl } from './Preferences'
import {
  Button,
  Carousel,
  CarouselContent,
  CarouselIndicators,
  CarouselItem,
  Spinner
} from '../ui'

// Landing.tsx — 冷启动{t('landing.aria')}：左品牌大图 + 右面板（品牌 / 标语 / 两个动作）。
//
// 只在冷启动被 AppRoot 认领、且后端认证模式为 account 且未登录时渲染；会话中登出
// 不弹这一层（登录不是门禁，历史决策保留）。
//
// 「登录 / 注册」不开应用内登录层：开系统浏览器去官网登录，完成后经 scholarseed:// 深链
// 回跳，主进程拿一次性 code 换双 token 并采纳（main/handoff.ts）。本组件只订阅相位
// 快照、跑采纳后置确认链（confirmAdoptedSession，与应用内登录共用）。
//
// 显式登录入口（账户菜单 / 账号设置 / 失败屏）经 autoStart 打开本层：挂载后首次快照
// 即自动发起浏览器登录，不再要求用户多点一次「登录 / 注册」；冷启动变体不传 autoStart，
// 保留「登录 / {t('landing.skip')}」二选一。
//
// 「{t('landing.skip')}，使用API Key」把认证模式偏好切到 local（serve 以 --auth-mode off 重启），
// 切换完成后由宿主直达自带模型 key（BYOK）配置页。

const LANDING_CLASS_NAME =
  'fixed inset-0 z-[450] overflow-hidden rounded-[20px] [background:var(--auth-window-bg)]'
const WINDOW_BAR_CLASS_NAME =
  'absolute inset-x-0 top-0 z-[2] flex h-[48px] items-center justify-end px-[20px]'
const LANGUAGE_CLASS_NAME =
  'no-drag h-[36px] px-[12px] text-[var(--vds-text-primary)]'
const CONTENT_CLASS_NAME =
  'absolute left-1/2 top-1/2 flex h-[400px] w-[774px] -translate-x-1/2 -translate-y-1/2 items-center gap-[80px]'
const HERO_CLASS_NAME = 'w-[320px] shrink-0'
const PANEL_CLASS_NAME =
  'flex h-[400px] w-[374px] shrink-0 items-center justify-center text-[var(--auth-text)]'
const PANEL_INNER_CLASS_NAME =
  'flex h-full w-full flex-col items-stretch justify-center gap-[40px] rounded-[20px] border border-solid border-[var(--auth-login-card-border)] bg-white/60 px-[40px]'
const TITLE_GROUP_CLASS_NAME = 'flex flex-col items-center gap-[8px]'
const BRAND_CLASS_NAME = 'flex shrink-0 items-center justify-center gap-[4px]'
const BRAND_IMAGE_CLASS_NAME = 'h-[20px] w-auto object-contain'
const TITLE_CLASS_NAME =
  'm-[var(--vds-space-0)] shrink-0 text-center text-[28px] font-semibold leading-[42px] tracking-[0.02em] !text-[var(--vds-text-secondary)] whitespace-nowrap [font-family:var(--vds-font-serif)]'
const WAITING_TITLE_CLASS_NAME =
  'm-[var(--vds-space-0)] max-w-full shrink-0 whitespace-normal text-center text-[28px] font-semibold leading-[36px] tracking-[0.02em] !text-[var(--vds-text-secondary)] [font-family:var(--vds-font-serif)]'
const BODY_CLASS_NAME =
  'm-[var(--vds-space-0)] mt-[var(--vds-space-2)] text-center text-[14px] leading-[20px] text-[var(--auth-muted)]'
const ACTIONS_CLASS_NAME = 'flex flex-col items-stretch gap-[16px]'
const ACTION_CLASS_NAME = 'w-full'
const ERROR_CLASS_NAME =
  'mb-[var(--vds-space-3)] mt-[var(--vds-space-2)] text-center text-[12.5px] leading-[1.6] text-[var(--c-tension)]'
const WAITING_CLASS_NAME =
  'flex items-center justify-center gap-[8px] text-[13px] text-[var(--auth-muted)]'
const HERO_ART_CLASS_NAME =
  'flex h-[260px] w-[283px] items-center justify-center'
const HERO_IMAGE_CLASS_NAME = 'h-full w-full object-contain'
const HERO_COPY_CLASS_NAME =
  'm-0 whitespace-pre-line text-center font-[PingFang_SC] text-[14px] font-normal leading-[22px] tracking-normal text-[#4C4C4C]'
const HERO_ITEM_CLASS_NAME = 'flex min-h-0 border-0 bg-transparent'
const HERO_ITEM_INNER_CLASS_NAME =
  'flex w-full flex-col items-center gap-[20px]'
const HERO_INDICATORS_CLASS_NAME = 'mt-[20px]'

const HERO_SLIDES = [
  { copyKey: 'landing.heroCopy1', image: bannerImage1 },
  { copyKey: 'landing.heroCopy2', image: bannerImage2 },
  { copyKey: 'landing.heroCopy3', image: bannerImage3 },
  { copyKey: 'landing.heroCopy4', image: bannerImage4 }
] as const

type LandingPhase = 'idle' | 'waiting' | 'exchanging' | 'adopted' | 'failed'

export function Landing({
  onAuthed,
  onSkipped,
  onClose,
  autoStart = false
}: {
  /** 深链交接的凭据已被 serve 验通：宿主关首页并广播身份刷新。 */
  onAuthed: () => void
  /** 「{t('landing.skip')}」：宿主关首页，进普通工作台。 */
  onSkipped: () => void
  /** 会话内登录层变体的出口（误开可关）；冷启动变体不传 = 强制二选一。 */
  onClose?: () => void
  /** 显式登录入口打开本层：首次快照即自动开系统浏览器，省掉「{t('landing.login')}」一次点击。 */
  autoStart?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: tUi } = useTranslation('ui')
  const { t: accountText } = useTranslation('account')
  const { state } = useApp()
  const [phase, setPhase] = React.useState<LandingPhase>('idle')
  const [error, setError] = React.useState<LoginFailure | null>(null)
  const [starting, setStarting] = React.useState(false)
  const autoStartConsumed = React.useRef(false)
  const loginLogo = state.lang === 'en' ? loginLogoEn : loginLogoZh

  const finishAdopted = React.useCallback((): void => {
    void (async () => {
      const confirmed = await confirmAdoptedSession()
      if (!confirmed) {
        setPhase('failed')
        setError({ code: 'verify_failed' })
        return
      }
      await window.scholarseed.desktopAuthAdoptedAck()
      onAuthed()
    })()
  }, [onAuthed])

  const startLogin = React.useCallback(async (): Promise<void> => {
    setStarting(true)
    setError(null)
    const result = await window.scholarseed.desktopLoginStart(state.lang)
    setStarting(false)
    if (!result.ok) {
      setPhase('failed')
      setError(
        result.applicationFailure ?? {
          code: 'login_failed',
          diagnostic: result.error
        }
      )
    }
  }, [state.lang])

  const applySnapshot = React.useCallback(
    (snapshot: { phase: LandingPhase; error?: string }): void => {
      setPhase(snapshot.phase)
      setError(snapshot.error ? { code: snapshot.error } : null)
      if (snapshot.phase === 'adopted') finishAdopted()
      // 自动发起只按首次快照决策：waiting/exchanging/adopted 说明这次登录已在飞或已
      // 完成，再 start 会多开一个浏览器页并把在飞 state 顶掉。
      if (autoStart && !autoStartConsumed.current) {
        autoStartConsumed.current = true
        if (snapshot.phase === 'idle' || snapshot.phase === 'failed')
          void startLogin()
      }
    },
    [autoStart, finishAdopted, startLogin]
  )

  React.useEffect(() => {
    let alive = true
    const off = window.scholarseed.onDesktopAuth((snapshot) => {
      if (alive) applySnapshot(snapshot)
    })
    void window.scholarseed.desktopAuthState().then((snapshot) => {
      if (alive) applySnapshot(snapshot)
    })
    return () => {
      alive = false
      off()
    }
  }, [applySnapshot])

  const cancelLogin = (): void => {
    void window.scholarseed.desktopLoginCancel()
  }

  React.useEffect(() => {
    if (!onClose) return
    const onKey = (event: KeyboardEvent): void => {
      // 交接在飞时不给 Esc 关：浏览器那边正在回跳，关掉只会让用户以为登录失败了。
      if (event.key === 'Escape' && phase !== 'exchanging') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, phase])

  return (
    <div
      aria-label={t('landing.aria')}
      aria-modal="true"
      className={LANDING_CLASS_NAME}
      data-testid="landing-dialog"
      role="dialog"
    >
      <div className={WINDOW_BAR_CLASS_NAME}>
        <LanguagePopoverControl
          className={LANGUAGE_CLASS_NAME}
          showChevron
          showIcon={false}
          showLabel={false}
          variant="compact"
        />
      </div>
      <div className={CONTENT_CLASS_NAME}>
        <div className={HERO_CLASS_NAME}>
          <Carousel autoPlay className="w-full">
            <CarouselContent>
              {HERO_SLIDES.map((slide) => (
                <CarouselItem
                  className={HERO_ITEM_CLASS_NAME}
                  key={slide.copyKey}
                >
                  <div className={HERO_ITEM_INNER_CLASS_NAME}>
                    <div aria-hidden="true" className={HERO_ART_CLASS_NAME}>
                      <img
                        alt=""
                        className={HERO_IMAGE_CLASS_NAME}
                        src={slide.image}
                      />
                    </div>
                    <p className={HERO_COPY_CLASS_NAME}>{t(slide.copyKey)}</p>
                  </div>
                </CarouselItem>
              ))}
            </CarouselContent>
            <CarouselIndicators className={HERO_INDICATORS_CLASS_NAME} />
          </Carousel>
        </div>
        <div className={PANEL_CLASS_NAME}>
          <div className={PANEL_INNER_CLASS_NAME}>
            {phase === 'waiting' ? (
              <>
                <div className={TITLE_GROUP_CLASS_NAME}>
                  <div className={BRAND_CLASS_NAME}>
                    <img
                      alt={t('landing.logoAlt')}
                      className={BRAND_IMAGE_CLASS_NAME}
                      src={loginLogo}
                    />
                  </div>
                  <h1 className={WAITING_TITLE_CLASS_NAME}>
                    {t('landing.waitingTitle')}
                  </h1>
                </div>
                <p className={BODY_CLASS_NAME}>{t('landing.waitingBody')}</p>
                <div className={ACTIONS_CLASS_NAME}>
                  <Button
                    className={ACTION_CLASS_NAME}
                    onClick={() => void startLogin()}
                    size="standard"
                  >
                    {t('landing.reopen')}
                  </Button>
                  <Button
                    className={ACTION_CLASS_NAME}
                    onClick={cancelLogin}
                    size="standard"
                    variant="outline"
                  >
                    {tUi('cancel')}
                  </Button>
                </div>
              </>
            ) : phase === 'exchanging' || phase === 'adopted' ? (
              <>
                <div className={TITLE_GROUP_CLASS_NAME}>
                  <div className={BRAND_CLASS_NAME}>
                    <img
                      alt={t('landing.logoAlt')}
                      className={BRAND_IMAGE_CLASS_NAME}
                      src={loginLogo}
                    />
                  </div>
                  <h1 className={WAITING_TITLE_CLASS_NAME}>
                    {t('landing.loggingIn')}
                  </h1>
                </div>
                <div className={WAITING_CLASS_NAME}>
                  <Spinner size="sm" />
                  {t('landing.handoff')}
                </div>
              </>
            ) : (
              <>
                <div className={TITLE_GROUP_CLASS_NAME}>
                  <div className={BRAND_CLASS_NAME}>
                    <img
                      alt={t('landing.logoAlt')}
                      className={BRAND_IMAGE_CLASS_NAME}
                      src={loginLogo}
                    />
                  </div>
                  <h1 className={TITLE_CLASS_NAME}>{t('landing.title')}</h1>
                </div>
                {error && (
                  <p className={ERROR_CLASS_NAME}>
                    {loginFailureText(error, accountText)}
                  </p>
                )}
                <div className={ACTIONS_CLASS_NAME}>
                  <Button
                    className={ACTION_CLASS_NAME}
                    data-testid="landing-login"
                    loading={starting}
                    onClick={() => void startLogin()}
                    size="standard"
                    variant="primary"
                  >
                    {t('landing.login')}
                  </Button>
                  <Button
                    className={ACTION_CLASS_NAME}
                    data-testid="landing-skip"
                    onClick={onSkipped}
                    size="standard"
                    variant="outline"
                  >
                    {t('landing.skipApiKey')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
