import React, { useEffect, useState } from 'react'
import { ImageView } from '../../components/primitive/Image'
import { imageMediaType } from './image'
import { useDocumentWorkspace, useWorkspaceController } from './workspace'

export function ImageDocument({
  sessionId,
  tabId,
}: {
  sessionId: string
  tabId: string
}): React.JSX.Element {
  const workspace = useDocumentWorkspace()
  const controller = useWorkspaceController()
  const session = workspace.sessions[sessionId]
  const tab = workspace.tabs[tabId]
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!session || session.loadState !== 'ready') {
      setUrl('')
      return
    }
    const objectUrl = URL.createObjectURL(
      new Blob([new Uint8Array(session.bytes)], {
        type: imageMediaType(session.source.path, session.mediaType),
      })
    )
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [session?.bytes, session?.mediaType, session?.loadState, session?.source.path])
  return (
    <ImageView
      url={url}
      title={session?.title ?? ''}
      failed={!session || session.loadState === 'error'}
      viewState={tab?.viewState}
      onViewChange={(next) => controller.setTabViewState(tabId, { ...next })}
    />
  )
}
