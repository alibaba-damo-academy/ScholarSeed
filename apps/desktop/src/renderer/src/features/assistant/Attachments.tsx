import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { LocalReference } from '../../components/primitive/Attachments'
import type { ResourceLocationRef, ResourceNode } from '../../contracts/resources'
import { activeThread, useApp, type ComposerReference } from '../../store'
import { fetchResourceDirectoryTree, importAttachmentToResources } from './api'
import { ResourceSaveDialog } from './Save'
import { AttachmentImages } from './Images'
import { partitionAttachments } from './utils'
import { AttachmentFiles } from './Local'

/** Only sent user messages mount this component; the composer has no save action. */
export function SentAttachments({
  refs,
  imagesOnly = false,
  sourceLabel,
}: {
  refs: ComposerReference[]
  imagesOnly?: boolean
  sourceLabel?: (ref: LocalReference) => string | undefined
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const { state, act } = useApp()
  const thread = activeThread(state)
  const { files } = partitionAttachments(refs)
  const [source, setSource] = useState<LocalReference | null>(null)
  const [location, setLocation] = useState<ResourceLocationRef>({ parent: '', name: '' })
  const [tree, setTree] = useState<ResourceNode[]>([])
  const [saving, setSaving] = useState(false)
  const [errorCode, setErrorCode] = useState('')
  const errorMessages: Record<string, string> = {
    assistant_project_unavailable: t('attachments.errors.assistant_project_unavailable'),
    session_attachment_not_found: t('attachments.errors.session_attachment_not_found'),
    session_attachment_changed: t('attachments.errors.session_attachment_changed'),
    session_attachment_forbidden: t('attachments.errors.session_attachment_forbidden'),
    name_exists: t('attachments.errors.nameExists'),
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
  const suffix = source?.type === 'file' && dot > 0 ? title.slice(dot) : ''

  const open = (ref: LocalReference): void => {
    const destination = project ?? state.projects[0]
    if (!destination) return
    const name = ref.title || ref.id
    const separator = name.lastIndexOf('.')
    setSource(ref)
    setTargetProjectId(destination.id)
    setLocation({
      parent: '',
      name: ref.type === 'file' && separator > 0 ? name.slice(0, separator) : name,
    })
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
    if (source.type === 'file')
      act.openResourceFile(result.node.path, targetProject.id, {
        kind: 'session-file',
        sessionId: thread.sessionId,
        path: source.path,
        projectScope: targetProject.id,
      })
    act.noticeResource('ok', { key: 'feedback.savedResource', name: result.node.name })
  }

  return (
    <>
      {imagesOnly ? (
        <AttachmentImages
          refs={refs}
          sessionId={thread.sessionId ?? undefined}
          sent
          sourceLabel={sourceLabel}
          onImport={open}
          onOpen={act.openFilePreview}
        />
      ) : (
        <AttachmentFiles
          importable={(ref) => ref.type !== 'file' || ref.previewSource?.kind !== 'project'}
          sourceLabel={sourceLabel}
          refs={files.map((row) => row.ref)}
          layout="contents"
          presentation="card"
          sessionId={thread.sessionId ?? undefined}
          onOpen={act.openFilePreview}
          onImport={open}
          canImport={state.projects.length > 0}
        />
      )}
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
