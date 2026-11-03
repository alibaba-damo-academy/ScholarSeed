import { libraryFileType } from '../../components/business/utils.ts'
import { artifactIsDeliverable, type SessionArtifact } from '../../model.ts'

export interface OutputGroup {
  session: { session_id: string; title: string; workdir?: string }
  artifacts: SessionArtifact[]
}

export function outputCategory(artifact: SessionArtifact): 'final' | 'intermediate' {
  return artifact.role === 'final' ? 'final' : 'intermediate'
}

export function visibleOutputs(
  groups: OutputGroup[],
  options: {
    query?: string
    fileType?: string
    stage?: string
    sessionId?: string
    sort?: 'name' | 'updated'
    ascending?: boolean
    language?: string
  }
): OutputGroup[] {
  const query = options.query?.trim().toLocaleLowerCase() ?? ''
  const direction = options.ascending ? 1 : -1
  return groups
    .filter((group) => !options.sessionId || group.session.session_id === options.sessionId)
    .map((group) => ({
      ...group,
      artifacts: group.artifacts
        .filter(
          (artifact) =>
            artifactIsDeliverable(artifact) &&
            (!options.fileType || libraryFileType(artifact.name) === options.fileType) &&
            (!options.stage || outputCategory(artifact) === options.stage) &&
            `${artifact.name} ${artifact.title ?? ''} ${group.session.title}`
              .toLocaleLowerCase()
              .includes(query)
        )
        .sort(
          (left, right) =>
            direction *
            (options.sort === 'name'
              ? left.name.localeCompare(right.name, options.language, { numeric: true })
              : (left.updated_at ?? 0) - (right.updated_at ?? 0))
        ),
    }))
    .filter((group) => group.artifacts.length)
    .sort(
      (left, right) =>
        direction *
        (options.sort === 'name'
          ? left.session.title.localeCompare(right.session.title, options.language, {
              numeric: true,
            })
          : Math.max(...left.artifacts.map((artifact) => artifact.updated_at ?? 0)) -
            Math.max(...right.artifacts.map((artifact) => artifact.updated_at ?? 0)))
    )
}
