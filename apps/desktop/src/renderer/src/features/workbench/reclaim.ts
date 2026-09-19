/**
 * 文档资源回收注册表。
 *
 * viewer 会在文档会话之间缓存宿主资源（Monaco 的 model 与视图状态就是这样跨标签
 * 保活的），所以回收不能放在组件 unmount 里，只能由「当前还剩哪些会话与标签」驱动。
 *
 * 但 Dock 不该为此静态依赖某个具体 viewer 的实现模块 —— 那条边会把该 viewer 的整个
 * 依赖树钉进首屏 chunk，哪怕用户从没打开过这类文件。改成：viewer 模块被加载时把自己的
 * 回收器登记进来，Dock 只调用这个通用入口。没被加载的 viewer 自然没有资源需要回收。
 */

export type DocumentResourceReclaimer = (
  activeSessionIds: ReadonlySet<string>,
  activeTabIds: ReadonlySet<string>
) => void

const reclaimers = new Set<DocumentResourceReclaimer>()

/** 登记一个回收器，返回注销函数。 */
export function registerDocumentResourceReclaimer(
  reclaimer: DocumentResourceReclaimer
): () => void {
  reclaimers.add(reclaimer)
  return () => reclaimers.delete(reclaimer)
}

/** 按当前存活的会话与标签回收所有已加载 viewer 的缓存资源。 */
export function reclaimDocumentResources(
  activeSessionIds: ReadonlySet<string>,
  activeTabIds: ReadonlySet<string>
): void {
  for (const reclaim of reclaimers) reclaim(activeSessionIds, activeTabIds)
}
