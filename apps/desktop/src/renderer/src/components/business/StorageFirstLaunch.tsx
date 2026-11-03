import React from 'react'
import { useTranslation } from 'react-i18next'

import type { StorageConfig } from '../../../../storage'
import { useApp } from '../../store'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  useToast,
} from '../ui'

const STORAGE_READ_FAILURE_TOAST = 'storage-first-launch-read-failed'

// proposal 112 §6.C/D-mac：mac 无安装向导，home 的「安装期等价」入口是首启一次性「高级」。
// 门控四条件由主进程 isFirstLaunchEligible() 给出（打包 ∧ 无 env ∧ 无指针 ∧ 默认 home 空）；
// 本对话框只消费一次（跳过或完成都写 storageFirstLaunchSeen），设置页永远只读。
export function StorageFirstLaunchDialog(): React.JSX.Element | null {
  const { t } = useTranslation('components')
  const { state, set } = useApp()
  const [storage, setStorage] = React.useState<StorageConfig | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState<'restart' | 'failed' | null>(null)
  const [readError, setReadError] = React.useState(false)
  const [retry, setRetry] = React.useState(0)
  const { toast, dismiss: dismissToast } = useToast()

  React.useEffect(() => {
    if (state.storageFirstLaunchSeen) return
    let cancelled = false
    setReadError(false)
    void window.scholarseed
      .storageConfig()
      .then((value) => {
        if (!cancelled) setStorage(value)
      })
      .catch(() => {
        if (!cancelled) setReadError(true)
      })
    return () => {
      cancelled = true
    }
  }, [state.storageFirstLaunchSeen, retry])

  React.useEffect(() => {
    if (!readError || state.storageFirstLaunchSeen) return
    const id = toast({
      id: STORAGE_READ_FAILURE_TOAST,
      tone: 'error',
      duration: false,
      title: (
        <span data-testid="storage-first-launch-read-error">
          {t('accountPanel.storage.dataHomeUnavailable')}
        </span>
      ),
      action: (
        <Button
          data-testid="storage-first-launch-read-retry"
          variant="outline"
          onClick={() => setRetry((value) => value + 1)}
        >
          {t('accountPanel.storage.retryRead')}
        </Button>
      ),
    })
    return () => dismissToast(id)
  }, [readError, state.storageFirstLaunchSeen, toast, dismissToast, t])

  if (state.storageFirstLaunchSeen) return null
  if (!storage || !storage.canChangeDataHome || !storage.firstLaunchEligible) return null

  const dismiss = (): void => {
    set({ storageFirstLaunchSeen: true })
  }

  const advanced = async (): Promise<void> => {
    const picked = await window.scholarseed.pickDir()
    if (!picked) return
    setBusy(true)
    setNotice(null)
    const result = await window.scholarseed.commitDataHome(picked)
    setBusy(false)
    setNotice(result.ok ? 'restart' : 'failed')
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) dismiss()
      }}
    >
      <DialogPortal>
        <DialogContent
          hideCloseButton
          data-testid="storage-first-launch-dialog"
          className="no-drag [font-family:var(--vds-font-main)]"
          overlayClassName="no-drag"
        >
          <DialogHeader>
            <DialogTitle>{t('accountPanel.storage.firstLaunchTitle')}</DialogTitle>
            <DialogDescription>
              {t('accountPanel.storage.firstLaunchDescription')}
            </DialogDescription>
          </DialogHeader>
          {notice === 'restart' ? (
            <DialogDescription role="status" data-testid="storage-first-launch-restart">
              {t('accountPanel.storage.firstLaunchRestart')}
            </DialogDescription>
          ) : null}
          {notice === 'failed' ? (
            <DialogDescription role="alert" data-testid="storage-first-launch-failed">
              {t('accountPanel.storage.firstLaunchFailed')}
            </DialogDescription>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              size="standard"
              disabled={busy}
              data-testid="storage-first-launch-default"
              onClick={dismiss}
            >
              {notice === 'restart'
                ? t('accountPanel.storage.firstLaunchClose')
                : t('accountPanel.storage.firstLaunchDefault')}
            </Button>
            {notice === 'restart' ? null : (
              <Button
                type="button"
                variant="primary"
                size="standard"
                disabled={busy}
                data-testid="storage-first-launch-advanced"
                onClick={() => void advanced()}
              >
                {t('accountPanel.storage.firstLaunchAdvanced')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
