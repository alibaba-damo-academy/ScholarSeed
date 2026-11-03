export const SCROLLBAR_IDLE_DELAY_MS = 800

export function conversationInlinePadding(viewport: {
  offsetWidth: number
  clientWidth: number
}): string {
  const reservedInlineGutter = (viewport.offsetWidth - viewport.clientWidth) / 2
  return `calc(var(--vds-space-4) - ${reservedInlineGutter}px)`
}

export function createScrollbarVisibility(
  update: (visible: boolean) => void,
  schedule: (callback: () => void, delay: number) => number,
  unschedule: (timer: number) => void
) {
  let timer: number | null = null
  const hide = (): void => {
    if (timer !== null) unschedule(timer)
    timer = null
    update(false)
  }
  return {
    scroll(): void {
      if (timer !== null) unschedule(timer)
      update(true)
      timer = schedule(hide, SCROLLBAR_IDLE_DELAY_MS)
    },
    hide,
  }
}

export function createFollowScroll(
  update: () => void,
  schedule: (callback: FrameRequestCallback) => number,
  unschedule: (frame: number) => void
) {
  let following = true
  let frame: number | null = null
  const cancel = (): void => {
    if (frame !== null) unschedule(frame)
    frame = null
  }
  return {
    request(): void {
      if (!following || frame !== null) return
      frame = schedule(() => {
        frame = null
        if (following) update()
      })
    },
    pause(): void {
      following = false
      cancel()
    },
    resume(): void {
      following = true
    },
    cancel,
  }
}
