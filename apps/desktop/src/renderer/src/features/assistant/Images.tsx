import React, { useEffect, useState, useRef } from 'react'
import { ArtifactGroup } from '../../components/business/Artifact'
import {
  Images as ImageGroup,
  VISIBLE_IMAGES,
  type ConversationImage,
} from '../../components/primitive/Images'
import { type SessionArtifact } from '../../model'
import {
  artifactImageAsset,
  loadImageAsset,
  sentImageAsset,
  type ImageAsset,
  type ImageReference,
} from './pictures'
import { useTranslation } from 'react-i18next'
import { MoreHorizontal } from 'lucide-react'
import {
  openSystemPath,
  openPathWith,
  appsForFile,
  revealSystemPath,
  resolveSessionReferenceLocation,
  type OpenWithApp,
} from '../../api'
import { ImageAttachments, ImagePreview } from '../../components/primitive'
import { type ComposerAttachments } from '../../components/primitive/Attachments'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  IconButton,
  ImageStrip,
  useToast,
} from '../../components/ui'
import { type ComposerReference } from '../../store'
import { isDocumentLoadFailure, loadDocument } from '../workbench/api'
import { AttachmentFiles } from './Local'
import { OpenWithApplications } from '../../components/business/Artifact'
import { eligibleImage, eligiblePdf } from './delivery'
import { GeneratedPdf } from './PdfPreview'
import { copyImageElement } from '../../components/primitive/clipboard'
import {
  ATTACHMENT_IMAGE_TYPES,
  attachmentImageSource,
  authorizeAttachmentOriginal,
  partitionAttachments,
  type ImageAttachment,
} from './utils'

function useImageResources(assets: ImageAsset[]): ConversationImage[] {
  const signature = JSON.stringify(assets)
  const [resources, setResources] = useState<Record<string, { url?: string; failed?: boolean }>>({})
  const reload = useRef<(asset: ImageAsset) => void>(undefined)
  useEffect(() => {
    let disposed = false
    const urls = new Map<string, string>()
    const loading = new Set<string>()
    const pending = JSON.parse(signature) as ImageAsset[]
    const load = (asset: ImageAsset): void => {
      if (disposed || loading.has(asset.id)) return
      loading.add(asset.id)
      const previousUrl = urls.get(asset.id)
      if (previousUrl) URL.revokeObjectURL(previousUrl)
      urls.delete(asset.id)
      setResources((current) => ({ ...current, [asset.id]: {} }))
      void loadImageAsset(asset)
        .then((result) => {
          if (disposed) return
          const url = result.blob ? URL.createObjectURL(result.blob) : undefined
          if (url) urls.set(asset.id, url)
          setResources((current) => ({ ...current, [asset.id]: { url, failed: !result.blob } }))
        })
        .catch(() => {
          if (!disposed) setResources((current) => ({ ...current, [asset.id]: { failed: true } }))
        })
        .finally(() => loading.delete(asset.id))
    }
    setResources({})
    for (const asset of pending) load(asset)
    reload.current = load
    return () => {
      disposed = true
      reload.current = undefined
      for (const url of urls.values()) URL.revokeObjectURL(url)
    }
  }, [signature])
  const items: ConversationImage[] = assets.map((asset) => ({
    id: asset.id,
    title: asset.title,
    ...resources[asset.id],
    onReload: asset.source.kind === 'session-artifact' ? () => reload.current?.(asset) : undefined,
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

export function GeneratedImageGallery({
  sessionId,
  artifacts,
  renderActions,
  onOpenPdf,
}: {
  sessionId: string
  artifacts: SessionArtifact[]
  renderActions: (
    artifact: SessionArtifact,
    preview?: boolean,
    onClose?: () => void
  ) => React.ReactNode
  onOpenPdf: (artifact: SessionArtifact) => void
}): React.JSX.Element {
  const images = useImageResources(
    artifacts.filter(eligibleImage).map((artifact) => artifactImageAsset(sessionId, artifact))
  )
  return (
    <ArtifactGroup
      images={artifacts.map((artifact) => {
        const asset = artifactImageAsset(sessionId, artifact)
        return eligiblePdf(artifact)
          ? {
              id: asset.id,
              title: asset.title,
              onOpen: () => onOpenPdf(artifact),
              preview: (
                <GeneratedPdf
                  sessionId={sessionId}
                  artifact={artifact}
                  large={artifacts.length === 1}
                  onOpen={() => onOpenPdf(artifact)}
                />
              ),
            }
          : (images.find((image) => image.id === asset.id) ?? { id: asset.id, title: asset.title })
      })}
      renderImageActions={(asset, preview, onClose) => {
        const artifact = artifacts.find(
          (candidate) => artifactImageAsset(sessionId, candidate).id === asset.id
        )
        return artifact ? renderActions(artifact, preview, onClose) : null
      }}
    />
  )
}

export function GeneratedImage({
  sessionId,
  artifact,
}: {
  sessionId: string
  artifact: SessionArtifact
}): React.JSX.Element | null {
  if (!eligibleImage(artifact)) return null
  return <ResourceImages assets={[artifactImageAsset(sessionId, artifact)]} />
}

type LoadedImage = { url: string; bytes: Uint8Array; failed: boolean }

export function DraftAttachments({
  refs,
  onRemove,
  onOpen,
  sessionId,
  sourceLabel,
}: React.ComponentProps<typeof ComposerAttachments> & { sessionId?: string }): React.JSX.Element {
  const { files, images } = partitionAttachments(refs)
  const identity = JSON.stringify({
    sessionId,
    refs: files.map(({ ref }) => ref),
    unavailable: files.flatMap(({ ref }) =>
      ref.type !== 'skill' && ref.localSource && !ref.path && !ref.localSource.file ? [ref.id] : []
    ),
  })
  const [validation, setValidation] = useState<{ identity: string; ids: string[] }>({
    identity: '',
    ids: [],
  })
  useEffect(() => {
    let active = true
    const draft = JSON.parse(identity) as {
      sessionId?: string
      refs: ComposerReference[]
      unavailable: string[]
    }
    if (!draft.sessionId) {
      setValidation({ identity, ids: draft.unavailable })
      return
    }
    void Promise.all(
      draft.refs.map(async (ref) => {
        if (draft.unavailable.includes(ref.id)) return ref.id
        if (
          ref.type === 'skill' ||
          ref.registrationRequired ||
          (ref.type === 'file' && ref.previewSource && ref.previewSource.kind !== 'session-file')
        )
          return null
        const result = await resolveSessionReferenceLocation(
          draft.sessionId!,
          ref.referenceId || ref.id
        )
        return result.ok && result.path === ref.path && result.kind === ref.type ? null : ref.id
      })
    ).then((ids) => {
      if (active) setValidation({ identity, ids: ids.filter((id): id is string => id !== null) })
    })
    return () => {
      active = false
    }
  }, [identity])
  return (
    <>
      {images.length > 0 && (
        <div className="w-max shrink-0">
          <AttachmentImages refs={refs} onRemove={onRemove} onOpen={onOpen} sessionId={sessionId} />
        </div>
      )}
      {files.length > 0 && (
        <div className="w-max shrink-0">
          <AttachmentFiles
            sourceLabel={sourceLabel}
            refs={files.map((row) => row.ref)}
            layout="row"
            presentation="card"
            sessionId={sessionId}
            unavailableIds={validation.identity === identity ? validation.ids : []}
            onRemove={onRemove ? (index) => onRemove(files[index].index) : undefined}
            onOpen={onOpen}
          />
        </div>
      )}
    </>
  )
}

export function AttachmentImages({
  refs,
  sessionId,
  sent = false,
  sourceLabel,
  onRemove,
  onImport,
  onOpen,
  renderThumbnails,
}: {
  refs: ComposerReference[]
  sessionId?: string
  sent?: boolean
  sourceLabel?: (ref: ImageAttachment) => string | undefined
  onRemove?: (index: number) => void
  onImport?: (ref: ImageAttachment) => void
  onOpen?: React.ComponentProps<typeof ComposerAttachments>['onOpen']
  renderThumbnails?: (thumbnails: ReadonlyMap<string, React.ReactNode>) => React.ReactNode
}): React.JSX.Element | null {
  const { t } = useTranslation('assistant')
  const { toast } = useToast()
  const { images } = partitionAttachments(refs)
  const identity = JSON.stringify(images.map(({ ref, index }) => ({ ref, index })))
  const [loaded, setLoaded] = useState<Record<string, LoadedImage>>({})
  const [selected, setSelected] = useState<number | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [apps, setApps] = useState<OpenWithApp[]>([])
  const [appsLoading, setAppsLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const selectedPath = useRef<string | undefined>(undefined)
  const current = selected === null ? undefined : images[selected]?.ref
  selectedPath.current = current?.path

  useEffect(() => {
    let active = true
    const urls: string[] = []
    setLoaded({})
    setSelected(null)
    setMenuOpen(false)
    for (const { ref } of images) {
      const unavailable = (): void => {
        if (active)
          setLoaded((previous) => ({
            ...previous,
            [ref.id]: { url: '', bytes: new Uint8Array(), failed: true },
          }))
      }
      const preview = ref.localSource?.imagePreview
      const local = preview !== undefined ? preview : ref.localSource?.file
      const source = local
        ? local.arrayBuffer().then((bytes) => new Uint8Array(bytes))
        : preview === null || (ref.localSource && !ref.path)
          ? Promise.resolve(null)
          : loadDocument(attachmentImageSource(ref, sessionId)).then((result) =>
              isDocumentLoadFailure(result) ? null : result.bytes
            )
      void source
        .then((bytes) => {
          if (!active) return
          if (bytes === null) {
            unavailable()
            return
          }
          const extension = (ref.title || ref.path).split('.').at(-1)?.toLowerCase() ?? ''
          const url = URL.createObjectURL(
            new Blob([new Uint8Array(bytes)], {
              type: local?.type || ATTACHMENT_IMAGE_TYPES[extension],
            })
          )
          urls.push(url)
          setLoaded((previous) => ({
            ...previous,
            [ref.id]: { url, bytes, failed: false },
          }))
        })
        .catch(unavailable)
    }
    return () => {
      active = false
      urls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [identity, sessionId])

  if (!images.length) return renderThumbnails ? <>{renderThumbnails(new Map())}</> : null
  const failed = (): void => {
    if (current)
      setLoaded((previous) => ({
        ...previous,
        [current.id]: { ...previous[current.id], failed: true },
      }))
  }
  const run = async (
    action: () => Promise<{ ok: boolean; canceled?: boolean }>,
    successMessage: string = t('images.actionSucceeded')
  ): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await action()
      if (!result.ok && !result.canceled) throw new Error('image_action_failed')
      if (result.ok) toast({ title: successMessage, tone: 'success' })
    } catch {
      toast({ title: t('images.actionFailed'), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }
  const copy = async (element: HTMLImageElement): Promise<{ ok: boolean }> => {
    await copyImageElement(element)
    return { ok: true }
  }
  const originalPath = async (ref: ImageAttachment): Promise<string> => {
    const source = attachmentImageSource(ref, sessionId)
    if (source.kind === 'session-file' && source.path === ref.path) {
      const authorized = await authorizeAttachmentOriginal(
        ref,
        sessionId,
        async (target) => !isDocumentLoadFailure(await loadDocument(target)),
        async (path) => Boolean(await window.scholarseed?.addAuthorizedRoot('session', path))
      )
      if (!authorized) throw new Error('image_original_unavailable')
    }
    return ref.path
  }
  const thumbnails = images.map(({ ref }) => ({
    id: ref.id,
    name: ref.title,
    src: loaded[ref.id]?.url,
    error: loaded[ref.id]?.failed,
    sourceLabel: sent
      ? (sourceLabel?.(ref) ??
        (ref.previewSource?.kind === 'project'
          ? t('queue.kinds.resource')
          : ref.previewSource?.kind === 'literature'
            ? t('queue.kinds.literature')
            : undefined))
      : undefined,
  }))
  const thumbnailFailed = (index: number): void => {
    const ref = images[index].ref
    setLoaded((previous) => ({
      ...previous,
      [ref.id]: { ...previous[ref.id], failed: true },
    }))
  }
  const loadApps = (ref: ImageAttachment): void => {
    setApps([])
    setAppsLoading(true)
    void originalPath(ref)
      .then(appsForFile)
      .then((applications) => {
        if (selectedPath.current === ref.path) setApps(applications)
      })
      .catch(() => undefined)
      .finally(() => {
        if (selectedPath.current === ref.path) setAppsLoading(false)
      })
  }
  return (
    <>
      {renderThumbnails ? (
        renderThumbnails(
          new Map(
            images.map(({ ref, index }, imageIndex) => [
              ref.id,
              <ImageAttachments
                key={ref.id}
                images={[thumbnails[imageIndex]]}
                onOpen={() => setSelected(imageIndex)}
                onRemove={onRemove ? () => onRemove(index) : undefined}
                onImageError={() => thumbnailFailed(imageIndex)}
              />,
            ])
          )
        )
      ) : sent ? (
        <ImageStrip
          images={thumbnails}
          onOpen={setSelected}
          onImageError={thumbnailFailed}
          showNames={thumbnails.length <= VISIBLE_IMAGES}
        />
      ) : (
        <ImageAttachments
          images={thumbnails}
          onOpen={setSelected}
          onRemove={onRemove ? (index) => onRemove(images[index].index) : undefined}
          onImageError={thumbnailFailed}
        />
      )}
      <ImagePreview
        images={thumbnails}
        open={selected !== null}
        index={selected ?? 0}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null)
            setMenuOpen(false)
          }
        }}
        onIndexChange={(index) => {
          setSelected(index)
          setMenuOpen(false)
        }}
        onCopy={(element) => void run(() => copy(element), t('images.copySucceeded'))}
        copying={busy}
        onImageError={failed}
        testId="attachment-image-viewer"
        errorActions={
          <Button
            onClick={() => void run(async () => openSystemPath(await originalPath(current!)))}
          >
            {t('images.openSystem')}
          </Button>
        }
        actions={
          <DropdownMenu
            open={menuOpen}
            onOpenChange={(open) => {
              setMenuOpen(open)
              if (open && current) loadApps(current)
            }}
          >
            <DropdownMenuTrigger asChild>
              <IconButton label={t('images.more')} icon={<MoreHorizontal />} disabled={busy} />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="!z-[var(--vds-z-modal-nested-flyout)]">
              <DropdownMenuItem
                disabled={!current || !loaded[current.id] || loaded[current.id].failed}
                onSelect={() => {
                  const image = current && loaded[current.id]
                  if (!current || !image || image.failed) return
                  void run(async () => {
                    const saved = await window.scholarseed?.saveFileCopy(
                      current.localSource?.imagePreview && current.path
                        ? {
                            sourcePath: await originalPath(current),
                            suggestedName: current.title,
                          }
                        : { bytes: image.bytes, suggestedName: current.title }
                    )
                    return saved ?? { ok: false }
                  })
                }}
              >
                {t('artifactEntry.saveAs')}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!onOpen}
                onSelect={() => {
                  if (!current || !onOpen) return
                  setSelected(null)
                  onOpen({
                    path: current.path,
                    absolutePath: current.path,
                    title: current.title,
                    size: current.size,
                    mediaType: current.mediaType,
                    sessionId,
                    source: current.previewSource,
                  })
                }}
              >
                {t('images.openWorkbench')}
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger openOnHover>{t('images.openWith')}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent
                  side="left"
                  className="!z-[var(--vds-z-modal-nested-flyout)]"
                >
                  <OpenWithApplications
                    apps={apps}
                    appsLoading={appsLoading}
                    kind="dropdown"
                    onOpenWith={(app) =>
                      void run(async () => openPathWith(await originalPath(current!), app.path))
                    }
                  />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {onImport && (
                <DropdownMenuItem
                  onSelect={() => {
                    setSelected(null)
                    onImport(current!)
                  }}
                >
                  {t('images.import')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() =>
                  void run(async () => revealSystemPath(await originalPath(current!)))
                }
              >
                {t('images.reveal')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
    </>
  )
}
