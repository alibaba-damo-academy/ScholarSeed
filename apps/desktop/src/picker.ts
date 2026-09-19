/** Electron 主进程向 renderer 暴露的导入选择范围。 */
export const IMPORT_PICKER_TARGET = {
  RESOURCE: 'resource',
  FILE: 'file',
  DIRECTORY: 'directory'
} as const

export type ImportPickerTarget =
  (typeof IMPORT_PICKER_TARGET)[keyof typeof IMPORT_PICKER_TARGET]

const IMPORT_PICKER_TARGETS = new Set<unknown>(Object.values(IMPORT_PICKER_TARGET))

export function isImportPickerTarget(value: unknown): value is ImportPickerTarget {
  return IMPORT_PICKER_TARGETS.has(value)
}

const UNIFIED_IMPORT_PICKER_PLATFORM = 'darwin'

/** macOS 原生面板支持一次选择文件或文件夹；Windows/Linux 必须分开选择。 */
export function supportsImportPickerTarget(
  platform: string | undefined,
  target: ImportPickerTarget
): boolean {
  return target !== IMPORT_PICKER_TARGET.RESOURCE
    || platform === UNIFIED_IMPORT_PICKER_PLATFORM
}
