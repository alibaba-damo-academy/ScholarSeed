import { ATTENTION_PATH, type AttentionItem, type AttentionSnapshot } from '../attention.ts'
import { markdownSummary } from '../markdown/summary.ts'

export const NOTIFICATION_TEXT_LIMIT = 500
const ELLIPSIS = '…'
const REDACTION = '[redacted]'
const SENSITIVE_TEXT =
  /(?:bearer\s+[\w.\-]+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+)/gi
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function attentionPath(snapshot: AttentionSnapshot | null): string {
  if (!snapshot) return ATTENTION_PATH
  const query = new URLSearchParams({
    epoch: snapshot.epoch,
    after_revision: String(snapshot.revision),
  })
  return `${ATTENTION_PATH}?${query}`
}

export function withoutMarkdown(snapshot: AttentionSnapshot): AttentionSnapshot {
  return {
    ...snapshot,
    items: snapshot.items.map(({ markdown: _markdown, ...item }) => item),
  }
}

export function reminderSummary(item: AttentionItem): string {
  if (item.kind !== 'completed') return item.body
  if (typeof item.markdown !== 'string') throw new Error('Reminder answer unavailable')
  return markdownSummary(item.markdown).replace(SENSITIVE_TEXT, REDACTION)
}

export function notificationText(text: string, limit = NOTIFICATION_TEXT_LIMIT): string {
  if (text.length <= limit) return text
  let result = ''
  for (const { segment } of segments.segment(text)) {
    if (result.length + segment.length > limit - ELLIPSIS.length) break
    result += segment
  }
  return result + ELLIPSIS
}
