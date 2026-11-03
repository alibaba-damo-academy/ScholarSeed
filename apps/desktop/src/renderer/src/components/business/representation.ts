import type { DeliveryCard, SessionArtifact } from '../../model'

export function artifactText(artifact: SessionArtifact): string {
  return [
    ...new Set(
      [
        artifact.title,
        artifact.name,
        artifact.absolute_path || artifact.path,
        artifact.media_type,
        artifact.status,
      ].filter(Boolean)
    ),
  ].join('\n')
}

export function deliveryText(delivery: DeliveryCard): string {
  return [
    delivery.label,
    delivery.status,
    ...delivery.members.map((member) =>
      [member.title, member.workspacePath].filter(Boolean).join('\n')
    ),
  ]
    .filter(Boolean)
    .join('\n\n')
}
