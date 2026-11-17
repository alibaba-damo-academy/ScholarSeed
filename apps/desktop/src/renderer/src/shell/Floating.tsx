import type { JSX } from 'react'
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  CONVERSATION_PORTAL,
  PORTAL_URL,
  RESIZE_PORTAL,
  type PortalBounds,
  type PortalSurface,
  type FloatingPortalBridge,
} from '../../../portal'
import { PortalProvider, usePortalDocument, useToast } from '../components/ui'
import { preparePortalDocument } from './portal'
import { portalFootprint } from './footprint'
import { layoutCoordinator } from '../layout'

const RESIZE_OCCLUDER_SELECTOR = '.vds-popover, .vds-toast'

function dividerOcclusions(divider: DOMRect, selector: string): DOMRect[] {
  return [...document.querySelectorAll<HTMLElement>(selector)].flatMap((overlay) => {
    if (!overlay.checkVisibility({ visibilityProperty: true })) return []
    const bounds = overlay.getBoundingClientRect()
    return bounds.width > 0 &&
      bounds.height > 0 &&
      bounds.left < divider.right &&
      bounds.right > divider.left &&
      bounds.top < divider.bottom &&
      bounds.bottom > divider.top
      ? [bounds]
      : []
  })
}

function dividerToastMask(divider: DOMRect): string {
  const overlaps = dividerOcclusions(divider, '.vds-toast').sort(
    (first, second) => first.top - second.top
  )
  if (overlaps.length === 0) return ''
  const stops: string[] = []
  let end = 0
  for (const bounds of overlaps) {
    const start = Math.max(0, bounds.top - divider.top)
    if (start > end) stops.push(`black ${end}px ${start}px`)
    const bottom = Math.min(divider.height, bounds.bottom - divider.top)
    if (bottom > end) {
      stops.push(`transparent ${Math.max(start, end)}px ${bottom}px`)
      end = bottom
    }
  }
  if (end < divider.height) stops.push(`black ${end}px 100%`)
  return stops.length === 1
    ? 'linear-gradient(transparent, transparent)'
    : `linear-gradient(to bottom, ${stops.join(', ')})`
}

interface FloatingDocument {
  document: Document
  frame: HTMLIFrameElement
  popup: Window
  sessionId: string
}
interface FloatingPresentation {
  native: boolean
  surface: FloatingDocument | null
  anchor: PortalBounds | null
  anchorElement: RefObject<HTMLDivElement | null>
}
interface FloatingOptions {
  capturePointer?: boolean
  bridge?: FloatingPortalBridge
  surface?: PortalSurface
  failureText?: string
  enabled: boolean
  host: RefObject<HTMLElement | null>
  regions: readonly RefObject<HTMLElement | null>[]
  onFailure(): void
}

export function useFloatingPortal({
  capturePointer = false,
  bridge = window.scholarseed?.conversationPortal,
  surface: definition = CONVERSATION_PORTAL,
  failureText,
  enabled,
  host,
  regions,
  onFailure,
}: FloatingOptions): FloatingPresentation {
  const { t } = useTranslation('ui')
  const { toast } = useToast()
  const feedback = useRef({ t, toast, onFailure })
  feedback.current = { t, toast, onFailure }
  const regionRefs = useRef(regions)
  regionRefs.current = regions
  const [surface, setSurface] = useState<FloatingDocument | null>(null)
  const [anchor, setAnchor] = useState<PortalBounds | null>(null)
  const anchorElement = useRef<HTMLDivElement>(null)
  const generation = useRef(0)
  const requested = useRef(false)
  if (enabled) requested.current = true
  const retained = requested.current
  const fail = (): void => {
    feedback.current.toast({
      tone: 'error',
      title: failureText ?? feedback.current.t('nativeConversationUnavailable'),
      dedupeKey: definition.name,
    })
    feedback.current.onFailure()
  }
  const failure = useRef(fail)
  failure.current = fail
  useLayoutEffect(() => {
    if (!retained || !bridge) return
    const epoch = ++generation.current
    let active = true
    let sessionId: string | null = null
    let cleanup: (() => void) | undefined
    const remove = bridge.subscribeRevoked((id) => {
      if (active && id === sessionId) failure.current()
    })
    void (async () => {
      await Promise.resolve()
      if (!active) return
      const reserved = await bridge.reserve()
      if (!reserved.ok) throw new Error('conversation_reservation_failed')
      sessionId = reserved.sessionId
      if (!active) {
        await bridge.close(sessionId)
        return
      }
      const popup = window.open(PORTAL_URL, definition.name + sessionId)
      if (!popup) throw new Error('conversation_window_failed')
      popup.opener = null
      const target = popup.document
      target.body.style.margin = '0'
      target.body.style.background = 'transparent'
      target.body.inert = true
      const policy = target.createElement('meta')
      policy.httpEquiv = 'Content-Security-Policy'
      policy.content = "script-src 'none'; object-src 'none'; base-uri 'none'"
      target.head.append(policy)
      const frame = target.createElement('iframe')
      frame.setAttribute('data-native-conversation-frame', '')
      frame.title = document.title
      frame.style.cssText = `position:fixed;border:0;left:0;top:0;width:${window.innerWidth}px;height:${window.innerHeight}px`
      const loaded = new Promise<void>((resolve) => {
        frame.onload = () => resolve()
      })
      frame.srcdoc = '<!doctype html><html><head></head><body></body></html>'
      target.body.append(frame)
      await loaded
      if (!active) {
        await bridge.close(sessionId)
        return
      }
      cleanup = await preparePortalDocument(frame.contentWindow!)
      if (!active) {
        cleanup()
        await bridge.close(sessionId)
        return
      }
      setSurface({ document: frame.contentDocument!, frame, popup, sessionId })
    })().catch((error: unknown) => {
      console.error('[native-portal]', definition.name, error)
      if (active) failure.current()
    })
    return () => {
      active = false
      remove()
      cleanup?.()
      queueMicrotask(() => {
        if (generation.current === epoch)
          flushSync(() => {
            setSurface(null)
            setAnchor(null)
          })
        if (sessionId) void bridge.close(sessionId).catch(() => failure.current())
      })
    }
  }, [retained, bridge, definition])

  useLayoutEffect(() => {
    if (!surface || !bridge || !host.current) return
    let active = true
    let desired = ''
    let running = false
    let painted = false
    let latest: PortalBounds | null = null
    const observed = new Set<Element>()
    const resize = new ResizeObserver(() => schedule())
    const synchronize = async (): Promise<void> => {
      if (running) return
      running = true
      try {
        let submitted: string
        do {
          submitted = desired
          const bounds = latest
          if (!active) return
          const reply = await bridge.place(surface.sessionId, bounds)
          if (!reply.ok) throw new Error('conversation_placement_failed')
          if (!painted) {
            surface.document.body.classList.remove('opacity-0')
            await new Promise<void>((resolve) =>
              window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()))
            )
            if (!active) return
            const paint = await bridge.paint(surface.sessionId)
            if (!paint.ok) throw new Error('conversation_paint_failed')
            painted = true
            surface.popup.document.body.inert = false
          }
          surface.document.body.inert = bounds === null
        } while (active && submitted !== desired)
      } catch {
        if (active) failure.current()
      } finally {
        running = false
      }
    }
    const prepare = (): void => {
      if (!active || surface.popup.closed || !host.current) return
      const rect = host.current.getBoundingClientRect()
      const nextAnchor = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      if (anchorElement.current) {
        const geometry = { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
        for (const key of ['left', 'top', 'width', 'height'] as const) {
          const value = `${geometry[key]}px`
          if (anchorElement.current.style[key] !== value) anchorElement.current.style[key] = value
        }
      } else
        setAnchor((current) =>
          current &&
          Object.keys(nextAnchor).every(
            (key) => current[key as keyof PortalBounds] === nextAnchor[key as keyof PortalBounds]
          )
            ? current
            : nextAnchor
        )
      surface.frame.style.width = `${window.innerWidth}px`
      surface.frame.style.height = `${window.innerHeight}px`
    }
    const measure = (): (() => void) | void => {
      if (!active || surface.popup.closed || !host.current) return
      const elements = regionRefs.current.flatMap((ref) => (ref.current ? [ref.current] : []))
      for (const element of [...elements, ...surface.document.body.children]) {
        if (!observed.has(element)) {
          observed.add(element)
          resize.observe(element)
        }
      }
      const blocked = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].some(
        (element) => element.checkVisibility({ visibilityProperty: true })
      )
      const dragging =
        capturePointer && elements.some((element) => element.dataset.resizing === 'true')
      const divider = definition === RESIZE_PORTAL ? host.current.getBoundingClientRect() : null
      const toastMask = dragging && divider ? dividerToastMask(divider) : ''
      if (!enabled || blocked) latest = null
      else if (dragging)
        latest = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }
      else if (divider && dividerOcclusions(divider, RESIZE_OCCLUDER_SELECTOR).length) latest = null
      else
        latest = portalFootprint(surface.document, elements, (element) => {
          if (!observed.has(element)) {
            observed.add(element)
            resize.observe(element)
          }
        })
      if (
        elements.some((element) =>
          element
            .getAnimations()
            .some(
              (animation) =>
                animation.playState === 'running' &&
                animation.effect?.getTiming().iterations !== Infinity
            )
        )
      )
        schedule()
      return () => {
        if (divider) {
          for (const element of elements) {
            if (element.style.maskImage !== toastMask) element.style.maskImage = toastMask
          }
        }
        if (latest) {
          surface.frame.style.left = `${-latest.x}px`
          surface.frame.style.top = `${-latest.y}px`
        }
        const signature = JSON.stringify(latest)
        if (signature !== desired) {
          desired = signature
          void synchronize()
        }
      }
    }
    const participant = layoutCoordinator.register({ prepare, measure })
    const schedule = (): void => {
      if (active) participant.invalidate()
    }
    const mutations = new MutationObserver(schedule)
    mutations.observe(surface.document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    })
    const modals = new MutationObserver(schedule)
    modals.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-modal', 'hidden', 'class', 'style'],
    })
    resize.observe(host.current)
    window.addEventListener('resize', schedule)
    surface.document.addEventListener('scroll', schedule, true)
    surface.document.addEventListener('focusin', schedule)
    surface.document.addEventListener('focusout', schedule)
    schedule()
    return () => {
      active = false
      surface.popup.document.body.inert = true
      void bridge.place(surface.sessionId, null).catch(() => failure.current())
      participant.dispose()
      mutations.disconnect()
      modals.disconnect()
      resize.disconnect()
      window.removeEventListener('resize', schedule)
      surface.document.removeEventListener('scroll', schedule, true)
      surface.document.removeEventListener('focusin', schedule)
      surface.document.removeEventListener('focusout', schedule)
    }
  }, [enabled, surface, bridge, host, capturePointer, definition])
  return { native: enabled && Boolean(bridge), surface, anchor, anchorElement }
}

export function FloatingPortal({
  presentation,
  children,
  renderOverlay,
}: {
  presentation: FloatingPresentation
  children: ReactNode
  renderOverlay?: (children: ReactNode) => ReactNode
}): JSX.Element | null {
  if (!presentation.native)
    return <PortalProvider renderOverlay={renderOverlay}>{children}</PortalProvider>
  const { surface, anchor } = presentation
  if (!surface || !anchor) return null
  return createPortal(
    <PortalProvider document={surface.document} renderOverlay={renderOverlay}>
      <div
        ref={presentation.anchorElement}
        data-native-conversation-anchor
        className="pointer-events-none absolute [&>*]:pointer-events-auto"
        style={{ left: anchor.x, top: anchor.y, width: anchor.width, height: anchor.height }}
      >
        {children}
      </div>
    </PortalProvider>,
    surface.document.body
  )
}

export function FloatingOverlay({
  native,
  presentation,
  register,
  children,
}: {
  native: boolean
  presentation: FloatingPresentation
  register(): () => void
  children: ReactNode
}): JSX.Element | null {
  const document = usePortalDocument()
  const enabled =
    native && Boolean(window.scholarseed?.conversationPortal) && document === globalThis.document
  useLayoutEffect(() => (enabled ? register() : undefined), [enabled, register])
  if (!enabled) return <>{children}</>
  if (!presentation.surface) return null
  return createPortal(
    <PortalProvider document={presentation.surface.document}>{children}</PortalProvider>,
    presentation.surface.document.body
  )
}
