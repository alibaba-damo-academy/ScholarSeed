import { useEffect } from 'react'
import { rendererHasCrashed } from '../../diagnostics'

const CONFIRM_RETRY_MS = 1_000
const CONFIRM_MAX_ATTEMPTS = 60

/** Wait for the restored workbench to paint, rather than accepting a loaded HTML shell. */
export function useUpdateHealth(ready: boolean): void {
  useEffect(() => {
    if (!ready || !window.scholarseed.confirmUpdateWorkbenchReady) return
    let cancelled = false
    let attempts = 0
    let frame = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    const confirm = async (): Promise<void> => {
      if (cancelled || rendererHasCrashed() || attempts >= CONFIRM_MAX_ATTEMPTS) return
      attempts += 1
      try {
        const accepted = await window.scholarseed.confirmUpdateWorkbenchReady?.()
        if (accepted || cancelled) return
      } catch {
        if (cancelled) return
      }
      retry = setTimeout(() => void confirm(), CONFIRM_RETRY_MS)
    }
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => void confirm())
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      clearTimeout(retry)
    }
  }, [ready])
}
