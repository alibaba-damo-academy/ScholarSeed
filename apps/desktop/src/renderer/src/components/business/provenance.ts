import type { PdfAiContent, ReadingEvidence } from '../../contracts/literature.ts'

const markerGroup = /\[\[[FS]\d+\]\](?:\s*\[\[[FS]\d+\]\])*/g

export function readingCitations(
  item: PdfAiContent,
  numbers: Map<string, number>,
  showSources = true
) {
  if (!showSources)
    return { text: item.text.replace(/\[\[[FS]\d+\]\]/g, '').trimEnd(), citations: [] }
  const unique = (sources: ReadingEvidence[]) =>
    sources.filter(
      (source, index) =>
        sources.findIndex((other) => JSON.stringify(other) === JSON.stringify(source)) === index
    )
  const groups =
    item.citations ??
    unique(item.evidence ?? []).map((source, index) => ({
      marker: String(index),
      evidence: [source],
    }))
  const citations: { source: ReadingEvidence; number: number; marker: string; href: string }[] = []
  const links = (selected: typeof groups) => {
    const matches = selected.flatMap((group) =>
      unique(group.evidence).map((source) => {
        const key = JSON.stringify([
          source.page,
          source.fragment_id,
          source.region_id,
          source.quote,
          source.quads,
        ])
        // Like conversation answer sources, allocate only when referenced in text.
        const number = numbers.get(key) ?? numbers.size + 1
        numbers.set(key, number)
        const citation = {
          source,
          number,
          marker: group.marker,
          href: `scholarseed-cite:reading-${number}`,
        }
        if (!citations.some((value) => value.marker === group.marker && value.number === number))
          citations.push(citation)
        return citation
      })
    )
    return matches
      .filter(
        (value, index) => matches.findIndex((other) => other.number === value.number) === index
      )
      .sort((a, b) => a.number - b.number)
      .map(({ number, href }) => `[${number}](${href})`)
      .join(' ')
  }
  let text = item.text.trimEnd()
  if (item.citations) {
    // Compatibility for saved results: move the entire group, never its evidence.
    text = text.replace(
      /([。！？.!?；;][”’」』]?)\s*(\[\[[FS]\d+\]\](?:\s*\[\[[FS]\d+\]\])*)/g,
      '$2$1'
    )
    text = text.replace(markerGroup, (markers) => {
      const selected = [...markers.matchAll(/\[\[([FS]\d+)\]\]/g)].flatMap(([, marker]) =>
        groups.filter((group) => group.marker === marker)
      )
      const rendered = links(selected)
      return rendered ? ` ${rendered}` : ''
    })
  } else {
    const rendered = links(groups)
    if (rendered) text = text.replace(/([。！？.!?；;][”’」』]?)?$/, ` ${rendered}$1`)
  }
  return { text, citations }
}
