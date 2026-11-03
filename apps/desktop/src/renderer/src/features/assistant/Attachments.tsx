import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ComposerAttachments } from '../../components/primitive/Attachments'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui'
import type { ResourceLocationRef, ResourceNode } from '../../contracts/resources'
import { Icon } from '../../icons'
import { activeThread, useApp, type ComposerReference } from '../../store'
import { fetchResourceDirectoryTree, importAttachmentToResources } from './api'
import { ResourceSaveDialog } from './Save'
import { SentImages } from './Images'
import { imageReference } from './pictures'

type FileReference = Extract<ComposerReference, { type: 'file' }>

/** Only sent user messages mount this component; the composer has no save action. */
export function SentAttachments({ refs }: { refs: ComposerReference[] }): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const { state, act } = useApp()
  const thread = activeThread(state)
  const [source, setSource] = useState<FileReference | null>(null)
  const [location, setLocation] = useState<ResourceLocationRef>({ parent: '', name: '' })
  const [tree, setTree] = useState<ResourceNode[]>([])
  const [saving, setSaving] = useState(false)
  const [errorCode, setErrorCode] = useState('')
  const errorMessages: Record<string, string> = {
    assistant_project_unavailable: t('attachments.errors.assistant_project_unavailable'),
    session_attachment_not_found: t('attachments.errors.session_attachment_not_found'),
    session_attachment_changed: t('attachments.errors.session_attachment_changed'),
    session_attachment_forbidden: t('attachments.errors.session_attachment_forbidden'),
  }
  const errorText = !errorCode
    ? ''
    : Object.prototype.hasOwnProperty.call(errorMessages, errorCode)
      ? errorMessages[errorCode]
      : t('attachments.errors.saveFailed')
  const [targetProjectId, setTargetProjectId] = useState('')
  const project = state.projects.find((item) => item.path === thread.projectPath)
  const targetProject = state.projects.find((item) => item.id === targetProjectId)
  const title = source?.title || source?.id || ''
  const dot = title.lastIndexOf('.')
  const suffix = dot > 0 ? title.slice(dot) : ''

  const open = (ref: FileReference): void => {
    const destination = project ?? state.projects[0]
    if (!destination) return
    const name = ref.title || ref.id
    const separator = name.lastIndexOf('.')
    setSource(ref)
    setTargetProjectId(destination.id)
    setLocation({ parent: '', name: separator > 0 ? name.slice(0, separator) : name })
    setErrorCode('')
    setTree([])
    void fetchResourceDirectoryTree(destination.id).then(setTree)
  }

  const selectTargetProject = (projectId: string): void => {
    setTargetProjectId(projectId)
    setLocation((current) => ({ ...current, parent: '' }))
    setTree([])
    void fetchResourceDirectoryTree(projectId).then(setTree)
  }

  const save = async (): Promise<void> => {
    if (!source || !targetProject || !thread.sessionId || saving) return
    setSaving(true)
    setErrorCode('')
    const result = await importAttachmentToResources(
      thread.sessionId,
      targetProject.id,
      source.id,
      {
        ...location,
        name: location.name.trim() + suffix,
      }
    )
    setSaving(false)
    if (!result.ok || !result.node) {
      setErrorCode(result.error || 'save_failed')
      return
    }
    setSource(null)
    if (state.homeSelectedProjectId === targetProject.id) await act.reloadResourceTree()
    act.openResourceFile(result.node.path, targetProject.id, {
      kind: 'session-file',
      sessionId: thread.sessionId,
      path: source.id,
      projectScope: targetProject.id,
    })
    act.noticeResource('ok', { key: 'feedback.savedResource', name: result.node.name })
  }

  const actions = (ref: FileReference): React.ReactNode => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          unstyled
          aria-label={t('attachments.actions', { title: ref.title })}
          className="inline-flex h-[var(--vds-space-7)] items-center justify-center rounded-[var(--vds-radius-2)] bg-[var(--vds-bg-white-default)] px-[var(--vds-space-2)] text-[var(--vds-text-secondary)] transition-colors hover:bg-[var(--vds-surface-hover)] aria-[expanded=true]:bg-[var(--vds-surface-hover)]"
          icon={<Icon name="more-horizontal" size={12} />}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem
          disabled={!state.projects.length || !thread.sessionId}
          onSelect={() => open(ref)}
        >
          {t('attachments.save')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
  const images = refs.filter(imageReference)
  const files = thread.sessionId ? refs.filter((reference) => !imageReference(reference)) : refs
  return (
    <>
      {thread.sessionId && images.length > 0 && (
        <SentImages
          sessionId={thread.sessionId}
          refs={images}
          renderActions={(ref) => (
            <>
              <Button
                onClick={() =>
                  act.openFilePreview({
                    path: ref.path,
                    title: ref.title,
                    source: ref.previewSource,
                    sessionId: thread.sessionId!,
                    mediaType: ref.mediaType,
                  })
                }
              >
                {t('attachments.openImage')}
              </Button>
              {actions(ref)}
            </>
          )}
        />
      )}
      <ComposerAttachments refs={files} onOpen={act.openFilePreview} renderActions={actions} />
      <ResourceSaveDialog
        open={source !== null}
        onOpenChange={(value) => {
          if (!value && !saving) setSource(null)
        }}
        title={t('attachments.title')}
        description={t('attachments.description')}
        summary={t('attachments.description')}
        projectName={targetProject?.name ?? t('attachments.currentProject')}
        projectOptions={project ? undefined : state.projects}
        selectedProjectId={targetProjectId}
        onProjectChange={project ? undefined : selectTargetProject}
        tree={tree}
        location={location}
        onLocationChange={setLocation}
        fixedSuffix={suffix}
        error={errorText}
        saving={saving}
        onSubmit={() => void save()}
      />
    </>
  )
}
