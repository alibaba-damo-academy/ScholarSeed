/**
 * BibTeX 导出落盘。
 *
 * 导出成功的判据是「用户选完保存位置且文件真的写下去了」, 不是「浏览器接下了一个下载」。
 * 所以这里只走主进程的另存副本通道 (main/save.ts: saveFileCopy), 它会先弹原生保存对话框,
 * 等用户选定路径、写盘完成后才返回; 取消对话框回 canceled, 写失败回 error。渲染层据此
 * 决定是提示成功、静默收场还是报错, 不会在用户还没选文件时就宣告导出成功。
 */

/** 主进程另存副本的入参与回执, 与 preload 暴露的 saveFileCopy 同形。 */
export interface SaveCopyBridge {
  saveFileCopy(payload: { suggestedName: string; bytes: Uint8Array }): Promise<{
    ok: boolean
    canceled?: boolean
    path?: string
    error?: string
  }>
}

/** 落盘结果: 已保存 / 用户取消 / 失败。取消不是错误, 调用方必须区别对待。 */
export type BibtexSave =
  | { kind: 'saved'; path?: string }
  | { kind: 'canceled' }
  | { kind: 'failed'; error?: string }

/** 导出文件的建议名; 真正落到哪里由用户在保存对话框里决定。 */
export const BIBTEX_SUGGESTED_NAME = 'literature.bib'

const BRIDGE_UNAVAILABLE = 'desktop save bridge unavailable'

/**
 * 把 BibTeX 文本交给原生保存对话框落盘。
 *
 * bridge 可注入以便测试; 默认取桌面/浏览器两种形态都会装好的 window.scholarseed。
 */
export async function saveBibtex(
  bibtex: string,
  bridge: SaveCopyBridge | undefined = window.scholarseed
): Promise<BibtexSave> {
  if (!bridge) return { kind: 'failed', error: BRIDGE_UNAVAILABLE }
  try {
    const result = await bridge.saveFileCopy({
      suggestedName: BIBTEX_SUGGESTED_NAME,
      bytes: new TextEncoder().encode(`${bibtex}\n`)
    })
    if (result.ok) return { kind: 'saved', path: result.path }
    return result.canceled ? { kind: 'canceled' } : { kind: 'failed', error: result.error }
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}
