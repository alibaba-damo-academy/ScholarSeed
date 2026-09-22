// DMG 挂载态探针：回答「这个镜像现在是否已经挂着、挂在哪」。
//
// hdiutil 的文本输出与报错文案都随系统语言本地化（中文系统上 attach 冲突报「资源忙」），
// 错误串和文本标签都不是稳定判据；plist 的 key 才是。这里只持有 hdiutil/plutil 的管道与
// 纯 plist 选择 —— 不依赖 electron、不碰产品路径 —— 让 updater.ts 能对自己暂存安装包的
// 陈旧挂载做恢复，而不把探针逻辑埋进安装编排里（updater 顶层 import electron，node --test
// 加载不了）。

import { spawn } from 'child_process'

export const MACOS_HDIUTIL = '/usr/bin/hdiutil'
const MACOS_PLUTIL = '/usr/bin/plutil'

/**
 * `hdiutil info -plist` 的 JSON 快照：plutil 从 stdin 吃 plist、stdout 吐 JSON，两个固定
 * 命令直连管道，不经过 shell。任一环非 0 退出或 JSON 解析失败都 reject —— 调用方把探针
 * 失败降级为「不清扫、照旧 attach」，探针是恢复手段而不是安装前置条件。
 */
export function readHdiutilInfoPlist(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const info = spawn(MACOS_HDIUTIL, ['info', '-plist'], { windowsHide: true })
    const plistChunks: Buffer[] = []
    info.stdout.on('data', (chunk: Buffer) => plistChunks.push(chunk))
    info.stderr.resume()
    info.on('error', reject)
    info.on('close', (status) => {
      if (status !== 0) {
        reject(new Error(`hdiutil info failed with status ${status}`))
        return
      }
      const plutil = spawn(MACOS_PLUTIL, ['-convert', 'json', '-o', '-', '-'], { windowsHide: true })
      const jsonChunks: Buffer[] = []
      plutil.stdout.on('data', (chunk: Buffer) => jsonChunks.push(chunk))
      plutil.stderr.resume()
      plutil.on('error', reject)
      plutil.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`plutil plist conversion failed with status ${code}`))
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(jsonChunks).toString('utf8')) as unknown)
        } catch (error) {
          reject(error)
        }
      })
      plutil.stdin.end(Buffer.concat(plistChunks))
    })
  })
}

/**
 * 当前已 attach 的镜像里，image-path 命中候选集合的那些挂载点。
 *
 * hdiutil 记录的 image-path 是 realpath 解析后的绝对路径（传相对路径或 /tmp 路径会回
 * /private/... 形式），调用方必须把同一路径的 realpath 形态一并放进候选集合，否则匹配静默
 * 落空。没有 mount-point 的 entity（裸 disk entry）不算挂载。
 */
export function mountPointsOfImage(info: unknown, imagePaths: readonly string[]): string[] {
  const wanted = new Set(imagePaths)
  const images = (info as { images?: unknown } | null)?.images
  if (!Array.isArray(images)) return []
  const points: string[] = []
  for (const image of images) {
    const record = image as { 'image-path'?: unknown; 'system-entities'?: unknown }
    if (typeof record['image-path'] !== 'string' || !wanted.has(record['image-path'])) continue
    const entities = record['system-entities']
    if (!Array.isArray(entities)) continue
    for (const entity of entities) {
      const point = (entity as { 'mount-point'?: unknown })['mount-point']
      if (typeof point === 'string' && point) points.push(point)
    }
  }
  return points
}
