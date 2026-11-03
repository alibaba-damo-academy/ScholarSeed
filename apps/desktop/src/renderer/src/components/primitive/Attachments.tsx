import React from 'react'
import { useDocumentWorkspace } from '../../features/workbench/workspace'
import { AttachmentList } from './AttachmentList'

export function ComposerAttachments(
  props: Omit<React.ComponentProps<typeof AttachmentList>, 'openPaths'>
): React.JSX.Element {
  const documents = useDocumentWorkspace()
  const openPaths = Object.values(documents.sessions).map((session) => session.source.path)
  return <AttachmentList {...props} openPaths={openPaths} />
}
