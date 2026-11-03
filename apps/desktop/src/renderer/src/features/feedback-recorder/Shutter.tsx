import React from 'react'
import { Camera } from 'lucide-react'
import { useTranslation } from 'react-i18next'

const SHUTTER_DURATION_MS = 1000

export function useScreenshotShutter(): {
  active: boolean
  busy: boolean
  run: (capture: () => Promise<void>) => Promise<void>
} {
  const [active, setActive] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const running = React.useRef(false)
  const mounted = React.useRef(false)
  const cancelDelay = React.useRef<(() => void) | null>(null)
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      cancelDelay.current?.()
    }
  }, [])
  const run = React.useCallback(async (capture: () => Promise<void>): Promise<void> => {
    if (running.current || !mounted.current) return
    running.current = true
    setBusy(true)
    setActive(true)
    try {
      const completed = await new Promise<boolean>((resolve) => {
        const timer = window.setTimeout(() => {
          cancelDelay.current = null
          resolve(true)
        }, SHUTTER_DURATION_MS)
        cancelDelay.current = () => {
          window.clearTimeout(timer)
          cancelDelay.current = null
          resolve(false)
        }
      })
      if (!completed || !mounted.current) return
      setActive(false)
      // Capture starts after the visual feedback; the recorder host is hidden by the native capture path.
      await capture()
    } finally {
      running.current = false
      if (mounted.current) {
        setActive(false)
        setBusy(false)
      }
    }
  }, [])
  return { active, busy, run }
}

export function ScreenshotShutter(): React.JSX.Element {
  const { t } = useTranslation('components')
  return (
    <div
      data-feedback-recorder-root="shutter"
      data-testid="feedback-recorder-shutter"
      role="status"
      aria-label={t('feedbackRecorder.capturingScreenshot')}
      className="pointer-events-auto fixed inset-0 z-[var(--vds-z-feedback-recorder-nested-dialog)] cursor-wait"
    >
      <div
        aria-hidden
        className="absolute inset-0 bg-[var(--vds-static-white)] motion-safe:animate-[vds-feedback-shutter-flash_var(--vds-feedback-shutter-duration)_ease-out_both] motion-reduce:hidden"
      />
      <div
        aria-hidden
        className="absolute inset-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] border-2 border-[var(--vds-static-white)] motion-safe:animate-[vds-feedback-shutter-frame_var(--vds-feedback-shutter-duration)_ease-out_both]"
      >
        <div className="absolute left-1/2 top-1/2 grid size-[calc(var(--vds-space-10)*2)] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-[var(--vds-radius-circle)] bg-[var(--vds-bg-mask)] text-[var(--vds-static-white)]">
          <Camera size={32} />
        </div>
      </div>
    </div>
  )
}
