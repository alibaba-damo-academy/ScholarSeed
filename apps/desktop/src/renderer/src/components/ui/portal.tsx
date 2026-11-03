import { createContext, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx } from './utils'

const PortalContext = createContext<HTMLElement | null>(null)

export function Portal({ children }: { children?: ReactNode }): JSX.Element {
  const container = useContext(PortalContext)
  return typeof document === 'undefined' ? (
    <>{children}</>
  ) : (
    createPortal(children, container ?? document.body)
  )
}

export function PortalScope({
  children,
  className,
}: {
  children?: ReactNode
  className?: string
}): JSX.Element {
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
