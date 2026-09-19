export interface KeyboardInput {
  key: string
  meta: boolean
  control: boolean
  shift: boolean
}

const RELOAD_KEY = 'r'

/** Product windows own unsaved state, so Chromium reload accelerators are never safe. */
export function blocksRendererReload(input: KeyboardInput): boolean {
  return input.key.toLowerCase() === RELOAD_KEY && (input.meta || input.control)
}

/** A Vite URL can retain transformed modules from another worktree under the same localhost origin. */
export async function prepareRendererLoad(
  devUrl: string | undefined,
  clearCache: () => Promise<void>
): Promise<boolean> {
  if (!devUrl) return false
  await clearCache()
  return true
}
