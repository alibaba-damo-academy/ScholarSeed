// fuzzy.ts — 子序列模糊匹配 (proposal 13 @ 面板检索, 用户裁定: 按顺序的字符匹配,
// 不要求连续)。打分规则: 每命中 +1; 与上一命中连续 +2; 词首命中 (串首/分隔符后) +3;
// 跨距按距离小幅扣分 (偏好紧凑匹配)。查询字符必须全部按序命中才算匹配 (返回 null 否则)。

const WORD_BOUNDARY = /[\s\-_:./()\[\]]/

export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (!q) return 0
  let qi = 0
  let score = 0
  let last = -1
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue
    score += 1
    if (last === ti - 1) score += 2
    if (ti === 0 || WORD_BOUNDARY.test(t[ti - 1])) score += 3
    if (last >= 0) score -= Math.min(ti - last - 1, 10) * 0.1
    last = ti
    qi++
  }
  return qi === q.length ? score : null
}

/** 对 items 做子序列模糊过滤并按分数降序; keys 提供每项参与匹配的字符串 (取最高分)。 */
export function fuzzyFilter<T>(items: T[], query: string, keys: (item: T) => (string | undefined | null)[]): T[] {
  const q = (query || '').trim()
  if (!q) return items
  const scored: { item: T; s: number }[] = []
  for (const item of items) {
    let best: number | null = null
    for (const k of keys(item)) {
      if (!k) continue
      const s = fuzzyScore(q, k)
      if (s !== null && (best === null || s > best)) best = s
    }
    if (best !== null) scored.push({ item, s: best })
  }
  scored.sort((a, b) => b.s - a.s)
  return scored.map((x) => x.item)
}
