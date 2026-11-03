import React, { createContext, useContext, useEffect, useState } from 'react'
import {
  Images as ImageGroup,
  ImageThumbnail,
  type ConversationImage,
} from '../../components/primitive/Images'
import type { SessionArtifact } from '../../model'
import {
  artifactImageAsset,
  imageReference,
  loadImageAsset,
  sentImageAsset,
  type ImageAsset,
  type ImageReference,
} from './pictures'

function useImageResources(assets: ImageAsset[]): ConversationImage[] {
  const signature = JSON.stringify(assets)
  const [resources, setResources] = useState<Record<string, { url?: string; failed?: boolean }>>({})
  useEffect(() => {
    let disposed = false
    const urls = new Set<string>()
    const pending = JSON.parse(signature) as ImageAsset[]
    setResources({})
    for (const asset of pending) {
      void loadImageAsset(asset)
        .then((result) => {
          if (disposed) return
          const url = result.blob ? URL.createObjectURL(result.blob) : undefined
          if (url) urls.add(url)
          setResources((current) => ({ ...current, [asset.id]: { url, failed: !result.blob } }))
        })
        .catch(() => {
          if (!disposed) setResources((current) => ({ ...current, [asset.id]: { failed: true } }))
        })
    }
    return () => {
      disposed = true
      for (const url of urls) URL.revokeObjectURL(url)
    }
  }, [signature])
  const items: ConversationImage[] = assets.map((asset) => ({
    id: asset.id,
    title: asset.title,
    ...resources[asset.id],
  }))
  return items
}

function ResourceImages({
  assets,
  renderActions,
}: {
  assets: ImageAsset[]
  renderActions?: (asset: ImageAsset) => React.ReactNode
}): React.JSX.Element {
  const items = useImageResources(assets)
  return (
    <ImageGroup
      items={items}
      renderActions={(item) => {
        const asset = assets.find((candidate) => candidate.id === item.id)
        return asset ? renderActions?.(asset) : null
      }}
    />
  )
}

export function SentImages({
  sessionId,
  refs,
  renderActions,
}: {
  sessionId: string
  refs: ImageReference[]
  renderActions: (reference: ImageReference) => React.ReactNode
}): React.JSX.Element {
  return (
    <ResourceImages
      assets={refs.map((reference) => sentImageAsset(sessionId, reference))}
      renderActions={(asset) => {
        const reference = refs.find(
          (candidate) => sentImageAsset(sessionId, candidate).id === asset.id
        )
        return reference ? renderActions(reference) : null
      }}
    />
  )
}

function eligibleImage(artifact: SessionArtifact): boolean {
  return !(
    artifact.status === 'failed' ||
    artifact.status === 'deleted' ||
    artifact.change === 'delete' ||
    !imageReference({
      type: 'file',
      id: artifact.artifact_id,
      path: artifact.path,
      title: artifact.name,
      mediaType: artifact.media_type,
    })
  )
}

const ImageBatch = createContext<{
  sessionId: string
  items: ConversationImage[]
  select: (id: string) => void
} | null>(null)

export function GeneratedImages({
  sessionId,
  artifacts,
  children,
  renderActions,
}: {
  sessionId: string
  artifacts: SessionArtifact[]
  children: React.ReactNode
  renderActions: (artifact: SessionArtifact) => React.ReactNode
}): React.JSX.Element {
  const supported = artifacts.filter(eligibleImage)
  const items = useImageResources(
    supported.map((artifact) => artifactImageAsset(sessionId, artifact))
  )
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <ImageBatch.Provider value={{ sessionId, items, select: setSelected }}>
      {children}
      <ImageGroup
        items={items}
        thumbnails={false}
        selection={{ id: selected, onChange: setSelected }}
        renderActions={(item) => {
          const artifact = supported.find(
            (candidate) => artifactImageAsset(sessionId, candidate).id === item.id
          )
          return artifact ? renderActions(artifact) : null
        }}
      />
    </ImageBatch.Provider>
  )
}

export function GeneratedImage({
  sessionId,
  artifact,
}: {
  sessionId: string
  artifact: SessionArtifact
}): React.JSX.Element | null {
  const batch = useContext(ImageBatch)
  if (!eligibleImage(artifact)) return null
  const identity = artifactImageAsset(sessionId, artifact).id
  const item =
    batch?.sessionId === sessionId
      ? batch.items.find((candidate) => candidate.id === identity)
      : undefined
  if (item && batch)
    return <ImageThumbnail key={item.url} item={item} onOpen={() => batch.select(identity)} />
  return <ResourceImages assets={[artifactImageAsset(sessionId, artifact)]} />
}
