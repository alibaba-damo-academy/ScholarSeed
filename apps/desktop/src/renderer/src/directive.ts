const DIRECTIVE_PREFIX = '::scholarseed-'
const FENCE = /^\s*(```|~~~)/
const EVIDENCE_REFERENCE_COMMENT = /<!--\s*\/?\s*scholarseed-ref\b[^>]*-->/gi
const PARTIAL_EVIDENCE_REFERENCE_COMMENT = /<!--\s*\/?\s*scholarseed-ref\b.*$/i

function visibleEvidenceText(line: string): string {
  return line
    .replace(EVIDENCE_REFERENCE_COMMENT, '')
    .replace(PARTIAL_EVIDENCE_REFERENCE_COMMENT, '')
}

/** Hide ScholarSeed control lines while preserving identical text inside code fences. */
export function visibleScholarSeedText(source: string): string {
  const visible: string[] = []
  let fence: string | null = null
  for (const line of source.split('\n')) {
    const marker = line.match(FENCE)?.[1]
    if (marker) {
      fence = fence === marker ? null : fence ?? marker
      visible.push(line)
      continue
    }
    if (fence === null && line.trimStart().startsWith(DIRECTIVE_PREFIX)) continue
    visible.push(fence === null ? visibleEvidenceText(line) : line)
  }
  return visible.join('\n').trimEnd()
}

/** Per-speaker raw stream buffer; partial directives never enter conversation text. */
export class DirectiveStreamHarness {
  private readonly buffers = new Map<string, string>()

  append(key: string, delta: string, snapshot = false): string {
    const source = snapshot ? delta : (this.buffers.get(key) ?? '') + delta
    this.buffers.set(key, source)
    return visibleScholarSeedText(source)
  }

  clear(key: string): void {
    this.buffers.delete(key)
  }

  clearPrefix(prefix: string): void {
    for (const key of this.buffers.keys()) {
      if (key === prefix || key.startsWith(`${prefix}::`)) this.buffers.delete(key)
    }
  }
}
