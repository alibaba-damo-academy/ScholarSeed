// attachments.ts — 问题反馈附图的纯决策逻辑：截图字节→File、名额计算、合并顺序。
//
// 零依赖、可被 node --test 直测；Feedback.tsx 只做薄渲染，不在组件里埋这些算法
// （桌面端测试 runner 只收 .ts、不渲染 React，纯逻辑必须抽到 .ts 才有确定性覆盖）。

/** 自动截图的 MIME 与文件名前缀，与录制器 feedback-source-<ts>.png 命名习惯对齐。 */
const SCREENSHOT_MEDIA_TYPE = 'image/png'
const SCREENSHOT_NAME_PREFIX = 'feedback-screenshot-'

/**
 * 把截图桥返回的字节拷成一张带时间戳文件名的 PNG File。
 *
 * 拷贝一份脱离桥返回的 buffer（桥的字节可能被复用）；`now` 由调用方传入以保持确定性可测。
 */
export function toScreenshotFile(bytes: Uint8Array, now: number): File {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new File([copy.buffer], `${SCREENSHOT_NAME_PREFIX}${now}.png`, { type: SCREENSHOT_MEDIA_TYPE })
}

/** 还能再手动附几张：总名额减去手动数、再减去自动截图占用的一张。 */
export function feedbackImageRoom(manualCount: number, hasAutoScreenshot: boolean, maxImages: number): number {
  return maxImages - manualCount - (hasAutoScreenshot ? 1 : 0)
}

/** 提交时的图片顺序：自动截图（若有）排首位，其后是手动附图。 */
export function mergeFeedbackImages(autoScreenshot: File | null, manual: readonly File[]): File[] {
  return autoScreenshot ? [autoScreenshot, ...manual] : [...manual]
}
