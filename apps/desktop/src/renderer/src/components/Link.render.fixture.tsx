import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Link2 } from 'lucide-react'
import { Button, Link } from './ui'
import '../styles.css'

function Probe(): React.JSX.Element {
  const anchor = useRef<HTMLAnchorElement>(null)
  const [clicked, setClicked] = useState('')
  return (
    <>
      <div data-testid="link-container" style={{ width: 200 }}>
        <Link
          ref={anchor}
          data-testid="normal"
          href="#destination"
          icon={<Link2 />}
          onClick={(event) => {
            event.preventDefault()
            setClicked(event.currentTarget.href)
          }}
        >
          Normal link
        </Link>
        <Link
          data-testid="new-tab"
          href="https://example.com/?a=%20#original"
          target="_blank"
          rel="nofollow opener"
        >
          New tab
        </Link>
        <Link
          data-testid="disabled"
          href="#disabled"
          disabled
          onClick={() => setClicked('disabled')}
        >
          Disabled link
        </Link>
        <Link data-testid="long" href="#destination">
          {'https://example.com/' + 'long'.repeat(50)}
        </Link>
        <Button data-testid="focus" onClick={() => anchor.current?.focus()}>
          Focus link
        </Button>
        <div id="destination">Destination</div>
      </div>
      <output data-testid="clicked">{clicked}</output>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<Probe />)
