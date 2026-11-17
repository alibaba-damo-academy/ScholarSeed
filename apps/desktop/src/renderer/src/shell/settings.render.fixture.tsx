import { useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import {
  Button,
  Dialog,
  DialogContent,
  DialogPortal,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ToastProvider,
} from '../components/ui'
import { NativeSettingsPortal, NativeSettingsProvider } from './Settings'

function Fixture(): JSX.Element {
  const [settings, setSettings] = useState(false)
  const [directory, setDirectory] = useState(false)
  return (
    <>
      <Input aria-label="Main draft" />
      <Button onClick={() => setSettings(true)}>Open native settings</Button>
      <Button onClick={() => setDirectory(true)}>Open directory</Button>
      <Dialog open={directory} onOpenChange={setDirectory}>
        <DialogPortal>
          <DialogContent aria-label="Main directory">
            <Input aria-label="Directory member" />
          </DialogContent>
        </DialogPortal>
      </Dialog>
      <NativeSettingsPortal open={settings} onFailure={() => setSettings(false)}>
        <Dialog open={settings} onOpenChange={setSettings}>
          <DialogContent aria-label="Native settings">
            <Input aria-label="Settings draft" />
            <Popover>
              <PopoverTrigger asChild>
                <Button>Open settings popover</Button>
              </PopoverTrigger>
              <PopoverContent>
                <Input aria-label="Settings popover draft" />
              </PopoverContent>
            </Popover>
          </DialogContent>
        </Dialog>
      </NativeSettingsPortal>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <NativeSettingsProvider>
      <Fixture />
    </NativeSettingsProvider>
  </ToastProvider>
)
