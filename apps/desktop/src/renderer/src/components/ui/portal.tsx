import type * as React from 'react'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx } from './utils'

const PortalContext = createContext<HTMLElement | null>(null)
const PortalDocumentContext = createContext<Document | null>(null)
const PortalOverlayContext = createContext<((children: ReactNode) => ReactNode) | undefined>(
  undefined
)

export function PortalProvider({
  document,
  children,
  renderOverlay,
}: {
  document?: Document
  children: ReactNode
  renderOverlay?: (children: ReactNode) => ReactNode
}): React.JSX.Element {
  const parentDocument = usePortalDocument()
  const parentOverlay = usePortalOverlay()
  return (
    <PortalDocumentContext.Provider value={document ?? parentDocument}>
      <PortalOverlayContext.Provider value={renderOverlay ?? parentOverlay}>
        {children}
      </PortalOverlayContext.Provider>
    </PortalDocumentContext.Provider>
  )
}

export function usePortalOverlay(): ((children: ReactNode) => ReactNode) | undefined {
  return useContext(PortalOverlayContext)
}

export function usePortalDocument(): Document {
  return useContext(PortalDocumentContext) ?? globalThis.document
}

export function Portal({ children }: { children?: ReactNode }): React.JSX.Element {
  const document = usePortalDocument()
  const container = useContext(PortalContext)
  return typeof document === 'undefined' ? (
    <>{children}</>
  ) : (
    createPortal(children, container?.ownerDocument === document ? container : document.body)
  )
}

export function PortalScope({
  children,
  className,
}: {
  children?: ReactNode
  className?: string
}): React.JSX.Element {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  if (!className) return <>{children}</>
  return (
    <>
      <Portal>
        <div
          ref={setContainer}
          className={cx(
            'fixed inset-0 isolate pointer-events-none [&>*]:pointer-events-auto',
            className
          )}
        />
      </Portal>
      {container && <PortalContext.Provider value={container}>{children}</PortalContext.Provider>}
    </>
  )
}
