import React from 'react'
import { useTranslation } from 'react-i18next'

import { setAccountBase } from '../../account'
import { getAuthStatus, type AuthStatus } from '../../api'
import { Icon } from '../../icons'
import { Button } from '../ui'
import { Landing } from './Landing'

// AccountLogin.tsx — 应用内登录层宿主（账户菜单 / 账号设置 / 失败屏主动打开）。
//
// 登录不是启动门禁 —— 应用外壳始终挂载可用。登录是可选增强：只要 serve 下发了账号服务
// 地址（account_base_url），这一层就渲染冷启动同一张 Landing（浏览器官网登录 + 深链回跳），
// 并带上 layer 变体的关闭出口；没有账号服务地址时才落「无需登录 / 无登录入口」通知。
// 打开本层本身就是显式登录意图，故给 Landing 传 autoStart：层挂载后直接开系统浏览器，
// 不再要求用户多点一次「登录/注册」。
//
// 地址在**打开时**现取 /api/auth/status: 冷启动那一次可能赶在 serve 前面取不到,
// 现取才不会把「地址未配置」这类一次性状态钉死在界面上。

// 层级要盖住工作台失败屏 (Progress 的 screen 面是 z-[300]): 未登录时那一屏正是打开
// 这一层的主要入口, 压在它下面就等于点了「登录」没反应。
const LAYER_CLASS_NAME = 'fixed inset-0 z-[400] flex flex-col bg-[var(--bg)]'
const CLOSE_CLASS_NAME = 'no-drag absolute right-[10px] top-[8px] z-[1]'
const NOTICE_SCREEN_CLASS_NAME = 'grid h-full place-items-center overflow-y-auto px-[var(--vds-space-5)]'
const NOTICE_CARD_CLASS_NAME =
  'w-[min(420px,100%)] rounded-[14px] border border-[var(--border)] bg-[var(--bg-2)] p-[24px] shadow-[var(--shadow)]'
const NOTICE_TITLE_CLASS_NAME =
  'm-[var(--vds-space-0)] mb-[6px] text-[15px] font-semibold text-[var(--text)]'
const NOTICE_BODY_CLASS_NAME = 'm-[var(--vds-space-0)] text-[12.5px] leading-[1.6] text-[var(--text-2)]'
const NOTICE_ACTION_CLASS_NAME = 'mt-[var(--vds-space-4)] w-full'

function Notice({
  title,
  body,
  actionLabel,
  onAction
}: {
  title: string
  body: string
  actionLabel?: string
  onAction?: () => void
}): React.JSX.Element {
  return (
    <div className={NOTICE_SCREEN_CLASS_NAME}>
      <div className={NOTICE_CARD_CLASS_NAME}>
        <h2 className={NOTICE_TITLE_CLASS_NAME}>{title}</h2>
        <p className={NOTICE_BODY_CLASS_NAME}>{body}</p>
        {actionLabel && onAction && (
          <Button className={NOTICE_ACTION_CLASS_NAME} data-testid="account-login-retry" onClick={onAction}>
            {actionLabel}
          </Button>
        )}
      </div>
    </div>
  )
}

export function AccountLogin({
  onAuthed,
  onClose,
  onSkipped
}: {
  /** 登录凭据已被 serve 验通（Landing 自己回问过 /api/auth/me）。 */
  onAuthed: () => void
  onClose: () => void
  /** 「暂不登录」：宿主关层，进普通工作台。 */
  onSkipped: () => void
}): React.JSX.Element {
  const { t } = useTranslation('account')
  const [status, setStatus] = React.useState<AuthStatus | null>(null)

  const load = React.useCallback((): void => {
    setStatus(null)
    void getAuthStatus().then((fetched) => {
      if (!fetched) return
      // 账号服务地址只由后端下发 (serve 侧单一环境变量), 前端不自带配置。
      if (fetched.account_base_url) setAccountBase(fetched.account_base_url)
      setStatus(fetched)
    })
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // 有账号服务地址时出口在 Landing（layer 变体）自己手里（交接在飞时不给 Esc），
      // 这里只给通知屏留 Esc。
      if (event.key === 'Escape' && status !== null && !status.account_base_url) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, status])

  const hasAccountService = Boolean(status?.account_base_url)

  return (
    <div
      aria-label={t('accountLogin.title')}
      aria-modal="true"
      className={LAYER_CLASS_NAME}
      data-testid="account-login"
      role="dialog"
    >
      {!hasAccountService && (
        <Button
          aria-label={t('accountLogin.closeLogin')}
          className={CLOSE_CLASS_NAME}
          data-testid="account-login-close"
          size="icon"
          title={t('accountLogin.close')}
          variant="ghostIcon"
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </Button>
      )}

      {status === null ? (
        <Notice
          actionLabel={t('accountLogin.retry')}
          body={t('accountLogin.waiting')}
          onAction={load}
          title={t('accountLogin.loading')}
        />
      ) : hasAccountService ? (
        <Landing autoStart onAuthed={onAuthed} onClose={onClose} onSkipped={onSkipped} />
      ) : (
        <Notice
          body={
            status.enabled
              ? t('accountLogin.unsupported', { mode: status.mode })
              : t('accountLogin.disabled')
          }
          title={status.enabled ? t('accountLogin.noEntry') : t('accountLogin.notRequired')}
        />
      )}
    </div>
  )
}
