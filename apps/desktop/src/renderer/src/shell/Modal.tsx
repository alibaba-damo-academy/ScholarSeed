import type { JSX } from 'react'
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal, flushSync } from 'react-dom'
import { PORTAL_URL, type PortalBridge } from '../../../portal'
import { PortalProvider } from '../components/ui'
import { preparePortalDocument } from './portal'

interface Surface {
  document: Document
  window: Window
  sessionId: string
}
interface ModalPortalContext {
  native: boolean
  surface: Surface | null
  open(onFailure: () => void): () => void
  paint(sessionId: string): Promise<void>
}
const ModalContext = createContext<ModalPortalContext | null>(null)

export function NativeModalProvider({
  children,
  bridge,
  name,
  onFailure,
}: {
  children: ReactNode
  bridge: PortalBridge | undefined
  name: string
  onFailure(): void
}): JSX.Element {
  const feedback = useRef(onFailure)
  feedback.current = onFailure
  const [surface, setSurface] = useState<Surface | null>(null)
  const epoch = useRef(0)
  const open = useCallback(
    (onFailure: () => void): (() => void) => {
      if (!bridge) return () => undefined
      const generation = ++epoch.current
      const previousFocus = document.activeElement as HTMLElement | null
      let sessionId: string | null = null
      let cleanup: (() => void) | undefined
      let active = true
      let closing: Promise<void> | undefined
      const close = (): Promise<void> => {
        if (!sessionId) return Promise.resolve()
        closing ??= bridge.close(sessionId).then((reply) => {
          if (!reply.ok) throw new Error('modal_close_failed')
        })
        return closing
      }
      const fail = (): void => {
        if (!active || generation !== epoch.current) return
        onFailure()
        feedback.current()
      }
      const remove = bridge.subscribeRevoked((id) => {
        if (id === sessionId) fail()
      })
      void (async () => {
        const reserved = await bridge.reserve()
        if (!reserved.ok) throw new Error('modal_reservation_failed')
        sessionId = reserved.sessionId
        if (!active || generation !== epoch.current) {
          await close()
          return
        }
        const popup = window.open(PORTAL_URL, name + sessionId)
        if (!popup) throw new Error('modal_window_failed')
        cleanup = await preparePortalDocument(popup)
        if (!active || generation !== epoch.current) {
          cleanup()
          await close()
          return
        }
        setSurface({ document: popup.document, window: popup, sessionId })
      })().catch(fail)
      return () => {
        active = false
        remove()
        cleanup?.()
        queueMicrotask(() => {
          if (generation === epoch.current) flushSync(() => setSurface(null))
          if (sessionId)
            void close()
              .then(() => {
                if (generation === epoch.current && previousFocus?.isConnected)
                  previousFocus.focus({ preventScroll: true })
              })
              .catch(() => feedback.current())
        })
      }
    },
    [bridge, name]
  )
  const paint = useCallback(
    async (sessionId: string): Promise<void> => {
      const reply = await bridge?.paint(sessionId)
      if (!reply?.ok) {
        feedback.current()
        throw new Error('modal_paint_failed')
      }
    },
    [bridge]
  )
  const context = useMemo(
    () => ({ native: Boolean(bridge), surface, open, paint }),
    [bridge, surface, open, paint]
  )
  return <ModalContext.Provider value={context}>{children}</ModalContext.Provider>
}

export function NativeModalPortal({
  open,
  onFailure,
  children,
}: {
  open: boolean
  onFailure(): void
  children: ReactNode
}): JSX.Element | null {
  const host = useContext(ModalContext)
  const native = host?.native ?? false
  const reserve = host?.open
  const paint = host?.paint
  const failure = useRef(onFailure)
  failure.current = onFailure
  useLayoutEffect(() => {
    if (open && native) return reserve?.(() => failure.current())
  }, [open, native, reserve])
  const surface = host?.surface
  useLayoutEffect(() => {
    if (!open || !surface || !paint) return
    let active = true
    const frames: number[] = []
    const next = (callback: () => void): void => {
      frames.push(
        surface.window.requestAnimationFrame(() => {
          if (active) callback()
        })
      )
    }
    next(() =>
      next(() => {
        surface.document.body.classList.remove('opacity-0')
        next(() =>
          next(() => {
            void paint(surface.sessionId)
              .then(() => {
                if (!active || surface.window.closed) return
                surface.document.body.inert = false
                const dialog = surface.document.querySelector<HTMLElement>(
                  '[role="dialog"], [role="status"]'
                )
                const first = dialog?.querySelector<HTMLElement>(
                  'button:not(:disabled), input:not(:disabled), [tabindex="0"]'
                )
                ;(first ?? dialog)?.focus({ preventScroll: true })
              })
              .catch(() => {
                if (active) failure.current()
              })
          })
        )
      })
    )
    return () => {
      active = false
      if (!surface.window.closed) {
        for (const frame of frames) surface.window.cancelAnimationFrame(frame)
      }
    }
  }, [open, surface, paint])
  if (!open || (native && !surface)) return null
  return surface ? (
    createPortal(
      <PortalProvider document={surface.document}>{children}</PortalProvider>,
      surface.document.body
    )
  ) : (
    <>{children}</>
  )
}
