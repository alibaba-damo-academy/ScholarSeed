import type { ConvItem, TurnOutcome } from '../../model'

const TURN_NAVIGATION_MINIMUM_TURNS = 5
const TURN_NAVIGATION_MINIMUM_GUTTER_PX = 70

export function turnNavigationVisible(turnCount: number, leftGutter: number): boolean {
  return (
    turnCount >= TURN_NAVIGATION_MINIMUM_TURNS && leftGutter >= TURN_NAVIGATION_MINIMUM_GUTTER_PX
  )
}

export function currentConversationTurn(
  anchors: readonly { key: string; top: number }[],
  readingEdge: number
): string | undefined {
  let current = anchors[0]?.key
  for (const anchor of anchors) {
    if (Math.floor(anchor.top) > Math.floor(readingEdge)) break
    current = anchor.key
  }
  return current
}

export function visibleConversationTurns(
  anchors: readonly { key: string; top: number }[],
  viewportTop: number,
  viewportBottom: number,
  contentBottom: number
): string[] {
  return anchors.flatMap((anchor, index) => {
    const bottom = anchors[index + 1]?.top ?? contentBottom
    return anchor.top < viewportBottom && bottom > viewportTop ? [anchor.key] : []
  })
}

export function turnMarkerProximity(
  index: number,
  hovered: number | null
): 'rest' | 'outer' | 'far' | 'near' | 'focused' {
  if (hovered === null) return 'rest'
  const distance = Math.abs(index - hovered)
  if (distance === 0) return 'focused'
  if (distance === 1) return 'near'
  if (distance === 2) return 'far'
  if (distance === 3) return 'outer'
  return 'rest'
}

export interface ConversationTurn {
  key: string
  turnId?: string
  itemId?: string
  question: string
  answer: string
  state: TurnOutcome | 'waiting'
}

export function conversationTurns(
  items: readonly ConvItem[],
  outcomes: Readonly<Record<string, TurnOutcome>> = {},
  waiting: ReadonlySet<string | undefined> = new Set()
): ConversationTurn[] {
  const turns: ConversationTurn[] = []
  const owned = new Map<string, ConversationTurn>()
  let legacy: ConversationTurn | undefined
  for (const item of items) {
    if (item.kind === 'user') {
      legacy = undefined
      const key = item.itemId ?? item.turnId
      if (!key || (item.turnId && owned.has(item.turnId))) continue
      const turn: ConversationTurn = {
        key,
        turnId: item.turnId,
        itemId: item.itemId,
        question:
          item.text.trim() ||
          (item.refs ?? [])
            .filter(
              (reference) =>
                reference.type === 'file' ||
                reference.type === 'directory' ||
                (reference.type === 'assistant_context' &&
                  reference.kind === 'file' &&
                  !reference.anchor &&
                  reference.sourceId)
            )
            .map((reference) => reference.title)
            .join(', '),
        answer: '',
        state:
          item.turnId && waiting.has(item.turnId)
            ? 'waiting'
            : (item.turnId && outcomes[item.turnId]) || 'unknown',
      }
      turns.push(turn)
      if (item.turnId) owned.set(item.turnId, turn)
      else legacy = turn
    } else if (item.kind === 'agent') {
      const turn = item.turnId ? owned.get(item.turnId) : legacy
      if (turn && item.text.trim())
        turn.answer = [turn.answer, item.text.trim()].filter(Boolean).join(' ')
    }
  }
  return turns
}
