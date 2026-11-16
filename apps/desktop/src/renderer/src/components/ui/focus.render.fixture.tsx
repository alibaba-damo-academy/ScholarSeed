import { useRef, useState, type JSX, type RefObject } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import '../../styles.css'
import { Button } from './Button'
import { inFocusScope, useFocusScope } from './focus'

interface Scope {
  document: Document
  frame: HTMLIFrameElement
}

function Content({ restoreRef }: { restoreRef: RefObject<HTMLButtonElement | null> }): JSX.Element {
  const content = useRef<HTMLDivElement>(null)
  useFocusScope(content, true, true, true, restoreRef)
  return (
    <div ref={content} data-testid="scope" tabIndex={-1}>
      <Button>Scoped action</Button>
    </div>
  )
}

export default function Fixture(): JSX.Element {
  const [scope, setScope] = useState<Scope | null>(null)
  const [retired, setRetired] = useState(false)
  const [probe, setProbe] = useState<boolean[]>([])
  const restore = useRef<HTMLButtonElement>(null)
  const outside = useRef<HTMLButtonElement>(null)
  const open = (): void => {
    const frame = document.createElement('iframe')
    document.body.append(frame)
    setRetired(false)
    setScope({ frame, document: frame.contentDocument! })
  }
  const navigate = (): void => {
    if (!scope) return
    scope.frame.onload = () => setRetired(true)
    scope.frame.src = 'about:blank?retired'
  }
  const inspect = (): void => {
    const content = scope?.document.querySelector<HTMLElement>('[data-testid="scope"]')
    if (content)
      setProbe([
        inFocusScope(content, content.querySelector('button')),
        inFocusScope(content, outside.current),
        inFocusScope(content, null),
      ])
  }
  const view = scope?.document.defaultView
  return (
    <>
      <Button onClick={open}>Open scope</Button>
      <Button ref={outside} onClick={inspect}>
        Inspect scope
      </Button>
      <Button onClick={navigate}>Navigate owner</Button>
      <Button onClick={() => setScope(null)}>Unmount scope</Button>
      <output data-testid="owner-window">
        {scope ? (view ? (view.closed ? 'closed' : 'available') : 'null') : 'none'}
      </output>
      <output data-testid="retired">{String(retired)}</output>
      <output data-testid="probe">{JSON.stringify(probe)}</output>
      <output data-testid="mounted">{scope ? 'open' : 'closed'}</output>
      {scope &&
        createPortal(
          <>
            <Button ref={restore}>Restore target</Button>
            <Content restoreRef={restore} />
          </>,
          scope.document.body
        )}
    </>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
