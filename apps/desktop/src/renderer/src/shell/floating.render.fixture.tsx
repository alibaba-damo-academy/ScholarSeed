import {
  Fragment,
  StrictMode,
  useCallback,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../localization/engine'
import { resources } from '../../../localization/resources'
import type { UpdateSnapshot } from '../../../updates'
import { UpdatePanel } from '../components/business/UpdatePanel'
import {
  Button,
  Dialog,
  DialogContent,
  Input,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  PortalProvider,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ToastProvider,
  Toaster,
  useToast,
  ResizablePanel,
} from '../components/ui'
import { FloatingOverlay, FloatingPortal, useFloatingPortal } from './Floating'
import { Divider } from './Divider'
import '../styles.css'

const placements: unknown[] = []
const paints: string[] = []
let resizeSequence = 0
const resizeSessions = new Set<string>()
const resizeWindows = new Map<string, Window>()
const openWindow = window.open.bind(window)
window.open = (...args) => {
  const popup = openWindow(...args)
  if (popup && args[1]?.startsWith('scholarseed-resize-')) resizeWindows.set(args[1], popup)
  return popup
}
Object.assign(window, {
  portalPlacements: placements,
  portalPaints: paints,
  scholarseed: {
    conversationPortal: {
      reserve: async () => {
        const delay = Number(new URLSearchParams(location.search).get('delay') ?? 0)
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
        return { ok: true, sessionId: 'fixture-conversation' }
      },
      paint: async (session: string) => {
        paints.push(session)
        return { ok: true }
      },
      close: async () => ({ ok: true }),
      place: async (_session: string, bounds: unknown) => {
        placements.push(bounds)
        return { ok: true }
      },
      subscribeRevoked: () => () => undefined,
    },
  },
})
Object.assign(window.scholarseed, {
  resizePortal: {
    ...window.scholarseed.conversationPortal,
    maxInstances: 2,
    reserve: async () => {
      if (resizeSessions.size >= 2) return { ok: false }
      const sessionId = `fixture-resize-${++resizeSequence}`
      resizeSessions.add(sessionId)
      return { ok: true, sessionId }
    },
    close: async (sessionId: string) => {
      resizeSessions.delete(sessionId)
      resizeWindows.get(`scholarseed-resize-${sessionId}`)?.close()
      resizeWindows.delete(`scholarseed-resize-${sessionId}`)
      return { ok: true }
    },
  },
})
const overlapFixture = new URLSearchParams(location.search).has('overlap')
const localization = createLocalization(overlapFixture ? 'zh' : 'en', resources)
const readyUpdate: UpdateSnapshot = {
  phase: 'ready',
  currentVersion: '0.3.1',
  candidate: {
    id: 'fixture-update',
    version: '0.3.2',
    build_number: '202611111601',
    product_id: 'scholarseed',
    bundle_id: 'com.scholarseed.desktop',
    arch_type: 'darwin-arm64',
    team_id: 'A1B2C3D4E5',
    channel: 'release',
    file_size: 564_973_100,
    sha512: 'a'.repeat(128),
    release_notes: '自动构建 0.3.2 · 2026-11-11 16:01',
  },
}
if (overlapFixture)
  Object.assign(window.scholarseed, {
    getUpdateState: async () => readyUpdate,
    onUpdateState: () => () => undefined,
    refreshUpdate: async () => undefined,
  })

function OverlapControls(): JSX.Element {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => toast({ tone: 'success', title: '复制成功', duration: false })}>
        显示复制提示
      </Button>
      <div className="absolute bottom-24 left-[400px]">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button>查看更新</Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            side="right"
            className="!max-w-none !bg-transparent !p-0 !shadow-none"
          >
            <UpdatePanel onDismiss={() => setOpen(false)} />
          </PopoverContent>
        </Popover>
      </div>
      <Toaster placement="top-right" />
    </>
  )
}

function ResizeFixture(): JSX.Element {
  const [width, setWidth] = useState(
    new URLSearchParams(location.search).has('clamped') ? '1500px' : '500px'
  )
  const panel = (
    <ResizablePanel
      leftWidth={width}
      minLeftWidth={200}
      minRightWidth={200}
      onWidthChangeEnd={setWidth}
      renderHandle={(handle) =>
        new URLSearchParams(location.search).has('native-resize') ? (
          <Divider>{handle}</Divider>
        ) : (
          <div data-testid="resize-presentation" className="contents">
            {handle}
          </div>
        )
      }
      leftPanel={
        <div data-testid="resize-left">
          Conversation
          {overlapFixture && <OverlapControls />}
        </div>
      }
      rightPanel={<div>Webpage</div>}
    />
  )
  return new URLSearchParams(location.search).has('nested') ? (
    <ResizablePanel
      leftWidth="240px"
      minLeftWidth={200}
      minRightWidth={400}
      renderHandle={(handle) => <Divider>{handle}</Divider>}
      leftPanel={<div>Navigation</div>}
      rightPanel={panel}
    />
  ) : (
    panel
  )
}

function Fixture(): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [enabled, setEnabled] = useState(false)
  const [modal, setModal] = useState(false)
  const [count, setCount] = useState(0)
  const [text, setText] = useState('draft')
  const portal = useFloatingPortal({
    enabled,
    host,
    regions: [panel],
    onFailure: () => {
      throw new Error('native fixture failed')
    },
  })
  return (
    <div ref={host} className="relative h-screen w-screen">
      <Button onClick={() => setEnabled(!enabled)}>Toggle native</Button>
      <Button onClick={() => setModal(true)}>Open product modal</Button>
      <output data-testid="shared-count">{count}</output>
      <FloatingPortal presentation={portal}>
        <div
          ref={panel}
          data-testid="floating-fixture-panel"
          className="absolute bottom-4 right-4 flex w-96 gap-2 rounded border bg-[var(--vds-bg-white-default)] p-3"
        >
          <Input
            aria-label="Draft"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Button onClick={() => setCount((value) => value + 1)}>Increment</Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button>Options</Button>
            </PopoverTrigger>
            <PopoverContent>
              <Input aria-label="Nested option" />
            </PopoverContent>
          </Popover>
        </div>
      </FloatingPortal>
      <Dialog open={modal} onOpenChange={setModal}>
        <DialogContent aria-label="Product modal">
          <Button onClick={() => setModal(false)}>Close modal</Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
function Draft(): JSX.Element {
  const [text, setText] = useState('draft')
  return (
    <Input
      aria-label="Local draft"
      value={text}
      onChange={(event) => setText(event.target.value)}
    />
  )
}

function OverlayFixture(): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const [native, setNative] = useState(true)
  const [overlays, setOverlays] = useState(0)
  const register = useCallback(() => {
    setOverlays((count) => count + 1)
    return () => setOverlays((count) => count - 1)
  }, [])
  const presentation = useFloatingPortal({
    enabled: native && overlays > 0,
    host,
    regions: [],
    onFailure: () => {
      throw new Error('native overlay fixture failed')
    },
  })
  const renderOverlay = (children: ReactNode): ReactNode => (
    <FloatingOverlay native={native} presentation={presentation} register={register}>
      {children}
    </FloatingOverlay>
  )
  return (
    <div ref={host} className="relative h-screen w-screen">
      <Button onClick={() => setNative(!native)}>Toggle browser</Button>
      <PortalProvider renderOverlay={renderOverlay}>
        <Draft />
        <div data-testid="conversation-scroll" className="h-48 w-80 overflow-auto">
          <HoverCard>
            <HoverCardTrigger asChild>
              <Button>Citation</Button>
            </HoverCardTrigger>
            <HoverCardContent hosted>
              <Button>Open source</Button>
            </HoverCardContent>
          </HoverCard>
          <Popover>
            <PopoverTrigger asChild>
              <Button>Sources</Button>
            </PopoverTrigger>
            <PopoverContent hosted>
              <Input aria-label="Source filter" />
            </PopoverContent>
          </Popover>
          <Popover>
            <PopoverTrigger asChild>
              <Button>Unrelated options</Button>
            </PopoverTrigger>
            <PopoverContent>
              <Input aria-label="Ordinary option" />
            </PopoverContent>
          </Popover>
          <div className="h-screen" />
        </div>
      </PortalProvider>
    </div>
  )
}

const Lifecycle = new URLSearchParams(location.search).has('nested') ? StrictMode : Fragment
createRoot(document.getElementById('root')!).render(
  <Lifecycle>
    <I18nextProvider i18n={localization}>
      <ToastProvider>
        {new URLSearchParams(location.search).has('resize') ? (
          <ResizeFixture />
        ) : new URLSearchParams(location.search).has('overlay') ? (
          <OverlayFixture />
        ) : (
          <Fixture />
        )}
      </ToastProvider>
    </I18nextProvider>
  </Lifecycle>
)
