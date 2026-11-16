export type ArtifactBlockKind = 'images' | 'files'

export function groupArtifactBlocks<Entry>(
  entries: readonly Entry[],
  classify: (entry: Entry) => ArtifactBlockKind
): { kind: ArtifactBlockKind; entries: Entry[] }[] {
  const groups = new Map<ArtifactBlockKind, Entry[]>()
  for (const entry of entries) {
    const kind = classify(entry)
    const group = groups.get(kind)
    if (group) group.push(entry)
    else groups.set(kind, [entry])
  }
  return Array.from(groups, ([kind, items]) => ({ kind, entries: items }))
}
