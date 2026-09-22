/**
 * 文件事件订阅（开发 1 拥有）。
 *
 * 后端把资料库/文献库与已授权关联根的变化归并成 `FileEvent` 流；这里只负责
 * 「拿到事件 → 通知调用方刷新」，不自己解释事件语义。
 *
 * 断线续传按 `epoch` + `seq`：EventSource 自带的重连会复用过期 URL，因此
 * 与会话事件流同一套做法——显式关掉再带最新游标重开。`epoch` 变了（后端重启）
 * 时后端第一条就是 `rescan`，调用方整棵树重取即可，不必自己判断。
 */

import type { FileEvent } from '../../contracts/content'

/** 重连退避：与会话事件流同一量级，避免后端重启时的连接风暴。 */
const RECONNECT_INITIAL_DELAY_MS = 500
const RECONNECT_MAX_DELAY_MS = 8000

const base = (): string => window.scholarseed?.getApiBase() ?? ''

export interface FileEventCursor {
  epoch: string
  last_seq: number
}

/** 取当前游标。续传前拿一次，避免把服务端已有的历史当成新变更。 */
export async function loadEventCursor(projectId: string): Promise<FileEventCursor | null> {
  try {
    const query = projectId ? `?project=${encodeURIComponent(projectId)}` : ''
    const response = await fetch(`${base()}/api/content/cursor${query}`, { credentials: 'include' })
    if (!response.ok) return null
    return (await response.json()) as FileEventCursor
  } catch {
    return null
  }
}

/**
 * 订阅某个项目的文件事件。返回取消订阅函数。
 *
 * `onEvent` 收到 `rescan` 时应当整棵树重取；其余类型可按 `path` 局部刷新。
 */
export function subscribeFileEvents(
  projectId: string,
  onEvent: (event: FileEvent) => void
): () => void {
  let closed = false
  let epoch = ''
  let lastSeq = 0
  let stream: EventSource | null = null
  let retryTimer: number | null = null
  let attempt = 0

  const open = (): void => {
    if (closed) return
    const query = new URLSearchParams({ project: projectId, epoch, from_seq: String(lastSeq) })
    const connection = new EventSource(`${base()}/api/content/events?${query.toString()}`, {
      // SSE 不能带 Authorization 头，只能靠 cookie；跨源开发期必须显式开凭据。
      withCredentials: true
    })
    stream = connection
    connection.onopen = () => {
      if (connection === stream) attempt = 0
    }
    connection.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as FileEvent
        if (event.epoch) epoch = event.epoch
        if (event.seq > lastSeq) lastSeq = event.seq
        onEvent(event)
      } catch {
        /* 坏帧丢弃，不打断整条流 */
      }
    }
    connection.onerror = () => {
      if (connection !== stream) return
      connection.close()
      stream = null
      if (closed || retryTimer !== null) return
      attempt += 1
      const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_INITIAL_DELAY_MS * 2 ** (attempt - 1))
      retryTimer = window.setTimeout(() => {
        retryTimer = null
        open()
      }, delay)
    }
  }

  void loadEventCursor(projectId).then((cursor) => {
    if (cursor) {
      epoch = cursor.epoch
      lastSeq = cursor.last_seq
    }
    open()
  })

  return () => {
    closed = true
    if (retryTimer !== null) window.clearTimeout(retryTimer)
    stream?.close()
    stream = null
  }
}
