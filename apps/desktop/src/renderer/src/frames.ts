// frames.ts — 渲染帧时序助手。
//
// 截图前等若干帧，让收起的菜单/遮罩真正卸载、布局稳定后再抓，避免把发起截图的那层
// UI 自己拍进去。被「问题反馈」自动截图与内部反馈录制器共用，故抽到单一来源。

/** 截图前等待的帧数：等账户菜单/遮罩卸载、布局稳定。具名常量，不留裸数字。 */
export const CAPTURE_SETTLE_FRAMES = 2

/** 等待 count 个 requestAnimationFrame 后 resolve；count<=0 时立即 resolve。 */
export function waitForFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const next = (remaining: number): void => {
      if (remaining <= 0) resolve()
      else requestAnimationFrame(() => next(remaining - 1))
    }
    next(count)
  })
}
