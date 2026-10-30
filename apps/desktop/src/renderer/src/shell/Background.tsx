import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { isTrayNavigation } from '../../../tray'
import { listProjects, listSessions, readNavigationSession, readAttentionNavigation } from '../api'
import {
  BackgroundNavigation,
  loadTraySnapshot,
  navigateTray,
  navigateAttention,
} from '../app/background'
import { sessionDisplayTitle } from '../session'
import { useApp } from '../store'

export function BackgroundMenu(): null {
  const { state, set, act } = useApp()
  const { t } = useTranslation('native')
  const { t: assistantText } = useTranslation('assistant')
  const latest = useRef({ state, set, act, t, assistantText })
  latest.current = { state, set, act, t, assistantText }

  useEffect(() => {
    if (
      state.workbenchReady &&
      state.homeSelectedProjectId &&
      state.homeSelectedProjectId !== state.recentProjectId
    )
      set({ recentProjectId: state.homeSelectedProjectId })
  }, [state.workbenchReady, state.homeSelectedProjectId, state.recentProjectId, set])

  useEffect(() => {
    const bridge = window.scholarseed
    let active = true
    let refresh = 0
    const navigation = new BackgroundNavigation()
    const beginNavigation = (): (() => boolean) => {
      const current = navigation.begin()
      return () =>
        active &&
        current() &&
        latest.current.state.workbenchReady &&
        !latest.current.state.loginOpen
    }
    const unsubscribeRequest = bridge.onTrayRequest?.((requestId) => {
      const generation = ++refresh
      const snapshot = latest.current
      const ready = snapshot.state.workbenchReady && !snapshot.state.loginOpen
      void (async () => {
        const data = ready
          ? await loadTraySnapshot(
              snapshot.state.homeSelectedProjectId ?? snapshot.state.recentProjectId,
              {
                projects: listProjects,
                sessions: (options) => listSessions(options, { synchronizeRoots: false }),
              },
              (session) => sessionDisplayTitle(session, latest.current.assistantText)
            )
          : null
        if (active && generation === refresh)
          await bridge.replyTray!({
            requestId,
            snapshot:
              latest.current.state.workbenchReady && !latest.current.state.loginOpen ? data : null,
          })
      })().catch(() => {
        if (active && generation === refresh)
          void bridge.replyTray!({ requestId, snapshot: null }).catch(() => {
            console.warn('[tray] snapshot delivery failed')
          })
      })
    })
    const unsubscribeNavigation = bridge.onTrayNavigate?.((target) => {
      if (!isTrayNavigation(target)) return
      const current = beginNavigation()
      const failed = (): void => {
        if (current())
          latest.current.set({ foregroundError: latest.current.t('tray.navigationFailed') })
      }
      void navigateTray(
        target,
        { projects: listProjects, session: readNavigationSession },
        latest.current.act,
        (projects) => latest.current.set({ projects }),
        current
      )
        .then((opened) => {
          if (!opened) failed()
        })
        .catch(failed)
    })
    const unsubscribeAttention =
      state.workbenchReady && !state.loginOpen
        ? bridge.onNotificationClick((id) => {
            const current = beginNavigation()
            void navigateAttention(
              id,
              { projects: listProjects, attention: readAttentionNavigation },
              latest.current.act,
              () => latest.current.state,
              (projects) => latest.current.set({ projects }),
              current
            ).catch((error) => {
              if (current()) console.warn('[attention] navigation unavailable', error)
            })
          })
        : undefined
    return () => {
      active = false
      navigation.invalidate()
      unsubscribeRequest?.()
      unsubscribeNavigation?.()
      unsubscribeAttention?.()
    }
  }, [state.serviceInstanceId, state.workbenchReady, state.loginOpen])
  return null
}
