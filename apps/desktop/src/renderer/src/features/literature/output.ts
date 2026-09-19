import type { LiteratureSearchEvent } from '../../contracts/literature'

/**
 * AI 检索输出的用户可见投影。
 *
 * 检索 prompt（service/literature/persistence/search.py 的 SEARCH_PROMPT_TEMPLATE）约定：
 * 模型回复里包裹在 <<< 与 >>> 之间的部分才是给用户看的进度叙述，其余思考、脚本回显、
 * 工具调用痕迹都属于内部过程。这里把该约定收敛成一个纯函数，展示层只消费它的结果。
 */

/** 用户可见片段的起始定界符。 */
export const SEARCH_OUTPUT_OPEN = '<<<'
/** 用户可见片段的结束定界符。 */
export const SEARCH_OUTPUT_CLOSE = '>>>'
/** 多个可见片段之间的换行分隔。 */
const SEGMENT_SEPARATOR = '\n'

/** 唯一贡献可见输出的事件类型：增量内容。 */
export const SEARCH_OUTPUT_EVENT_TYPE = 'content.delta'
/** 推理通道的 role 标记：适配器用它把思考与用户可见消息区分开。 */
export const SEARCH_REASONING_ROLE = 'reasoning'

/**
 * 把一条检索事件折算成应累加进 output 的文本。
 *
 * 规则必须与服务端 service/literature/persistence/search.py 的累积口径一致：只有
 * content.delta 的 text / delta 进 output。content.completed 与 result.completed 会把
 * 同一段完整文本再发一次，一并累加就会在运行中出现两份相同进度，直到流结束用服务端
 * 权威副本整体替换才收敛成一份。工具事件也不注入标记：它们既不是模型给用户的叙述，
 * 又会让运行中的文本与结束后替换上来的持久化文本对不上。
 *
 * content.delta 同时承载推理与用户可见两条通道，适配器用 data.role 区分
 * (packages/adapters/codex/scholarseed_codex/events.py)。推理文本里会出现字面 <<< >>>，
 * 混进来就会在裁剪结果里多出一行垃圾，因此按 role 排除；缺省 role 视为用户可见，
 * 避免不打该标记的适配器把内容整段丢掉。
 */
export function searchEventText(event: LiteratureSearchEvent): string {
  if (event.type !== SEARCH_OUTPUT_EVENT_TYPE) return ''
  if (event.data.role === SEARCH_REASONING_ROLE) return ''
  const text = event.data.text
  if (typeof text === 'string') return text
  const delta = event.data.delta
  return typeof delta === 'string' ? delta : ''
}

/**
 * 抽出模型输出里全部被 <<< >>> 包裹的片段，按出现顺序拼成用户可见文本。
 *
 * 流式语义：每次都对已累积的完整输出重新扫描，因此定界符被拆到两个事件里也能正确识别；
 * 末尾未闭合的片段按已到达的部分先显示，保证 skill 长时间运行时进度是持续更新的。
 * 输出里没有任何 <<< 时返回空串，由调用方回落到「启动中 / 无输出」占位文案。
 */
export function visibleSearchOutput(raw: string): string {
  const segments: string[] = []
  let cursor = 0
  for (;;) {
    const open = raw.indexOf(SEARCH_OUTPUT_OPEN, cursor)
    if (open < 0) break
    const contentStart = open + SEARCH_OUTPUT_OPEN.length
    const close = raw.indexOf(SEARCH_OUTPUT_CLOSE, contentStart)
    if (close < 0) {
      segments.push(raw.slice(contentStart))
      break
    }
    segments.push(raw.slice(contentStart, close))
    cursor = close + SEARCH_OUTPUT_CLOSE.length
  }
  return segments
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(SEGMENT_SEPARATOR)
}
