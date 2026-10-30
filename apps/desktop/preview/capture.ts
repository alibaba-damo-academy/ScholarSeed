import { expect, type Page } from '@playwright/test'

export async function capturePreview(page: Page, path: string): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect.poll(async () => {
    const documents = page.frames().filter(frame => frame === page.mainFrame() || frame.parentFrame() === page.mainFrame())
    const animations = await Promise.all(documents.map(frame => frame.evaluate(() => document.getAnimations().filter(animation =>
      (animation.playState === 'running' || animation.pending) && Number.isFinite(animation.effect?.getComputedTiming().endTime)
    ).length)))
    return animations.reduce((total, count) => total + count, 0)
  }).toBe(0)
  await page.screenshot({ path, fullPage: true })
}
