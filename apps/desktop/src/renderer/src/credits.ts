import React from 'react'
import { useTranslation } from 'react-i18next'

import {
  INITIAL_CREDITS_STATE,
  accountCredits,
  creditsWarningBucket,
  setAccountBase,
  type CreditsWarningBucket
} from './account'
import { getAuthMe, getAuthStatus } from './api.ts'
import { useToast } from './components/ui'
import { useApp } from './store'

/**
 * 积分状态宿主：登录态下挂载即取一次余额，进入会话、窗口重新聚焦和每轮结束时重取；
 * 低余额只在桶跃迁时弹一次 toast；耗尽改由 Composer 常驻卡承载，避免与本轮失败卡重复。
 * 未登录 / 网关降级（ok:false 或余额缺数）/ 豁免账号一律不弹 —— 把取数失败渲染成
 * 「余额 0」会让用户以为自己被清零了。
 */
export function useCreditsLowWarning(
  backendReady: boolean,
  running: boolean,
  activeSession: string | null
): void {
  const { set } = useApp()
  const { toast } = useToast()
  const { t } = useTranslation('components')
  const [loggedIn, setLoggedIn] = React.useState(false)
  const [checkSeq, setCheckSeq] = React.useState(0)
  const warned = React.useRef<CreditsWarningBucket>(null)
  const wasRunning = React.useRef(running)

  React.useEffect(() => {
    if (!backendReady) {
      setLoggedIn(false)
      set({ credits: INITIAL_CREDITS_STATE })
      return undefined
    }
    let cancelled = false
    const refresh = (): void => {
      void Promise.all([getAuthStatus(), getAuthMe()]).then(([status, me]) => {
        if (cancelled) return
        setAccountBase(status?.account_base_url ?? '')
        setLoggedIn(Boolean(me?.auth))
      })
    }
    const cleared = (): void => {
      if (!cancelled) {
        setLoggedIn(false)
        set({ credits: INITIAL_CREDITS_STATE })
      }
    }
    refresh()
    window.addEventListener('scholarseed:auth-restored', refresh)
    window.addEventListener('scholarseed:auth-required', cleared)
    return () => {
      cancelled = true
      window.removeEventListener('scholarseed:auth-restored', refresh)
      window.removeEventListener('scholarseed:auth-required', cleared)
    }
  }, [backendReady, set])

  React.useEffect(() => {
    if (wasRunning.current && !running) setCheckSeq((seq) => seq + 1)
    wasRunning.current = running
  }, [running])

  React.useEffect(() => {
    const refresh = (): void => setCheckSeq((seq) => seq + 1)
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  React.useEffect(() => {
    if (!loggedIn) {
      warned.current = null
      set({ credits: INITIAL_CREDITS_STATE })
      return undefined
    }
    let cancelled = false
    set((current) => current.credits.summary === null
      ? { credits: { ...current.credits, phase: 'loading' } }
      : {})
    void accountCredits().then((result) => {
      if (cancelled) return
      if (!result.ok) {
        set((current) => ({
          credits: { ...current.credits, phase: 'error' }
        }))
        return
      }
      set({ credits: { phase: 'ready', summary: result.data } })
      if (
        result.data.unlimited ||
        !result.data.enforcing ||
        result.data.balance_credits === null
      ) {
        warned.current = null
        return
      }
      const bucket = creditsWarningBucket(result.data.balance_credits)
      if (bucket === warned.current) return
      warned.current = bucket
      if (bucket !== 'low') return
      toast({
        title: t('accountMenu.creditsLow', {
          balance: Math.floor(result.data.balance_credits)
        }),
        tone: 'warning'
      })
    })
    return () => {
      cancelled = true
    }
  }, [loggedIn, checkSeq, activeSession, set, toast, t])
}
