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
    cancel
  }
}
