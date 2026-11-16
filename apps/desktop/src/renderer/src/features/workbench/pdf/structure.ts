import type { TranslationSentence } from './analysis'

export interface TranslationNode {
  id: string
  level: number
  sentences: TranslationSentence[]
  children: TranslationNode[]
}

const DEFAULT_HEADING_LEVEL = 1

export function translationOutline(sentences: TranslationSentence[]): TranslationNode[] {
  const paragraphs: TranslationNode[] = []
  const occurrences = new Map<string, number>()
  for (const sentence of sentences) {
    const previous = paragraphs.at(-1)
    const heading = sentence.heading === true
    const sameParagraph = sentence.paragraph_id
      ? previous?.id === sentence.paragraph_id
      : previous && !sentence.paragraph_start && !heading && previous.level === 0
    if (sameParagraph && previous) {
      previous.sentences.push(sentence)
      continue
    }
    const occurrence = occurrences.get(sentence.source_text) ?? 0
    occurrences.set(sentence.source_text, occurrence + 1)
    paragraphs.push({
      id: sentence.paragraph_id ?? sentence.source_id ?? `${sentence.source_text}:${occurrence}`,
      level: heading ? (sentence.heading_level ?? DEFAULT_HEADING_LEVEL) : 0,
      sentences: [sentence],
      children: [],
    })
  }
  const roots: TranslationNode[] = []
  const stack: TranslationNode[] = []
  for (const node of paragraphs) {
    if (node.level > 0) {
      while (stack.length && stack.at(-1)!.level >= node.level) stack.pop()
    }
    const parent = stack.at(-1)
    ;(parent ? parent.children : roots).push(node)
    if (node.level > 0) stack.push(node)
  }
  return roots
}
