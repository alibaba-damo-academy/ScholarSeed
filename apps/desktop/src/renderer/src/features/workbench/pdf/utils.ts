type IntersectionSample = Pick<IntersectionObserverEntry, 'time' | 'isIntersecting'>

export function latestIntersection(entries: readonly IntersectionSample[]): IntersectionSample | undefined {
  return entries.reduce<IntersectionSample | undefined>(
    (latest, entry) => !latest || entry.time >= latest.time ? entry : latest,
    undefined
  )
}
