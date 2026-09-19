/** 命中区间：`text.slice(start, end)` 即一处关键词命中的原文切片。 */
export interface HighlightRange {
  start: number
  end: number
}

/**
 * 计算 text 中 keyword 的全部命中区间（PRD「结果行展示」的高亮纯逻辑）。
 * 大小写不敏感、逐处不重叠；关键词（trim 后）或文本为空时返回 []。
 * 纯函数，与渲染解耦，可被 node:test 直接行为测试。
 */
export function highlightRanges(text: string, keyword: string): HighlightRange[] {
  const needle = keyword.trim()
  if (!needle || !text) return []
  const haystack = text.toLowerCase()
  const target = needle.toLowerCase()
  const ranges: HighlightRange[] = []
  let cursor = 0
  let found = haystack.indexOf(target, cursor)
  while (found >= 0) {
    ranges.push({ start: found, end: found + needle.length })
    // 游标必须越过本次命中，否则重叠命中会让循环原地打转。
    cursor = found + needle.length
    found = haystack.indexOf(target, cursor)
  }
  return ranges
}
