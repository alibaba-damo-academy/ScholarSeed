import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WINDOW_CLOSE_ACTION, WINDOW_CLOSE_PLATFORM, type WindowCloseAction, type WindowCloseRequest } from '../../../window'
import {
  Button, Checkbox, Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogPortal, DialogTitle
} from '../components/ui'

export function WindowCloseDialog(): React.JSX.Element | null {
  const { t } = useTranslation('native')
  const titleId = useId()
  const descriptionId = useId()
  const [request, setRequest] = useState<WindowCloseRequest>(null)
  const [remember, setRemember] = useState(false)
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const responding = useRef(false)

  useEffect(() => {
    const bridge = window.scholarseed
    if (bridge.platform !== WINDOW_CLOSE_PLATFORM || !bridge.onWindowCloseRequest) return
    let active = true
    let received = false
    const update = (next: WindowCloseRequest): void => {
      setRequest(next)
      setRemember(false)
      setFailed(false)
    }
    const unsubscribe = bridge.onWindowCloseRequest((next) => {
      received = true
      update(next)
    })
    void bridge.getWindowCloseRequest?.().then((next) => {
      if (active && !received) update(next)
    }).catch(() => {
      if (active) setFailed(true)
    })
    return () => { active = false; unsubscribe() }
  }, [])

  const respond = async (action: WindowCloseAction): Promise<void> => {
    if (request === null || responding.current || !window.scholarseed.respondWindowClose) return
    responding.current = true
    setPending(true)
    setFailed(false)
    try {
      const accepted = await window.scholarseed.respondWindowClose({ requestId: request, action, remember })
      if (accepted) setRequest((current) => current === request ? null : current)
      else setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      responding.current = false
      setPending(false)
    }
  }

  if (request === null) return null
  return (
    <Dialog open onOpenChange={(open) => { if (!open) void respond(WINDOW_CLOSE_ACTION.cancel) }}>
      <DialogPortal>
        <DialogContent
          hideCloseButton
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          data-testid="window-close-dialog"
          className="no-drag !z-[var(--vds-z-window-close)] [font-family:var(--vds-font-main)] max-h-[calc(100dvh-var(--vds-space-6)*2)] overflow-y-auto"
          overlayClassName="no-drag !z-[var(--vds-z-window-close-overlay)]"
        >
          <DialogHeader>
            <DialogTitle id={titleId}>{t('tray.closeTitle')}</DialogTitle>
            <DialogDescription id={descriptionId}>{t('tray.closeDetail')}</DialogDescription>
          </DialogHeader>
          <Checkbox checked={remember} onCheckedChange={setRemember} disabled={pending} label={t('tray.doNotAskAgain')} />
          {failed && <DialogDescription role="alert">{t('tray.closeFailed')}</DialogDescription>}
          <DialogFooter>
            <Button variant="secondary" size="standard" disabled={pending} onClick={() => void respond(WINDOW_CLOSE_ACTION.cancel)}>{t('tray.cancel')}</Button>
            <Button variant="danger" size="standard" disabled={pending} onClick={() => void respond(WINDOW_CLOSE_ACTION.quit)}>{t('tray.quit')}</Button>
            <Button variant="primary" size="standard" autoFocus disabled={pending} onClick={() => void respond(WINDOW_CLOSE_ACTION.minimize)}>{t('tray.minimize')}</Button>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
