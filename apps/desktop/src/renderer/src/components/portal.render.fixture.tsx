import type { JSX } from 'react'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import '../styles.css'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogPortal,
  AlertDialogTrigger,
  Button,
  CopyButton,
  Dialog,
  DialogContent,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  PortalProvider,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui'

function Fixture(): JSX.Element {
  const [target, setTarget] = useState<Document | null>(null)
  const [count, setCount] = useState(0)
  return (
    <>
      <output data-testid="shared-count">{count}</output>
      <Button>Outside unchanged</Button>
      <iframe
        title="Native document"
        srcDoc="<!doctype html><html><body></body></html>"
        className="h-screen w-full border-0"
        onLoad={(event) => {
          const document = event.currentTarget.contentDocument!
          for (const style of window.document.head.querySelectorAll('style,link[rel="stylesheet"]'))
            document.head.append(style.cloneNode(true))
          setTarget(document)
        }}
      />
      {target && (
        <PortalProvider document={target}>
          {createPortal(
            <Dialog open>
              <DialogContent aria-label="Shared settings">
                <Input aria-label="Settings draft" />
                <Button onClick={() => setCount((value) => value + 1)}>Increment</Button>
                <CopyButton
                  value="settings-copy"
                  idleLabel="Copy from settings"
                  copiedLabel="Copied from settings"
                />
                <Popover>
                  <PopoverTrigger asChild>
                    <Button>Open popover</Button>
                  </PopoverTrigger>
                  <PopoverContent>
                    <Input aria-label="Popover draft" />
                  </PopoverContent>
                </Popover>
                <Select defaultValue="first">
                  <SelectTrigger aria-label="Choose value">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="first">First value</SelectItem>
                    <SelectItem value="second">Second value</SelectItem>
                  </SelectContent>
                </Select>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button>Nested confirmation</Button>
                  </AlertDialogTrigger>
                  <AlertDialogPortal>
                    <AlertDialogContent aria-label="Confirm changes">
                      <AlertDialogCancel>Cancel changes</AlertDialogCancel>
                    </AlertDialogContent>
                  </AlertDialogPortal>
                </AlertDialog>
              </DialogContent>
            </Dialog>,
            target.body
          )}
        </PortalProvider>
      )}
    </>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
