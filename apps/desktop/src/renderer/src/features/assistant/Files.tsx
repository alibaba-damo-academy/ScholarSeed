import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  ContextMenuItem,
  ContextMenuSeparator,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  useToast,
} from '../../components/ui'
import { useApp } from '../../store'
import { mutateProjectNode } from '../project/api'
import { resourceNameParts } from '../resources/lifecycle'
import { resourceNameError } from '../resources/state'
import { documentWorkspaces } from '../workbench/workspace'
import { SessionFileLink } from './Links'

export function OutputFileLink({
  project,
  projectPath,
  absolutePath,
  ...link
}: React.ComponentProps<typeof SessionFileLink> & {
  project: string
  projectPath?: string
  absolutePath: string
}): React.JSX.Element {
  const { state, act } = useApp()
  const { t } = useTranslation('resources')
  const { t: layoutText } = useTranslation('layout')
  const { toast } = useToast()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const currentProject = useRef(state.homeSelectedProjectId)
  currentProject.current = state.homeSelectedProjectId
  const filename = link.path.split('/').at(-1) ?? link.path
  const parts = resourceNameParts(filename, 'file')
  const enabled = Boolean(projectPath) && state.homeSelectedProjectId === project
  const invalid = resourceNameError(name.trim())
  const rename = async (): Promise<void> => {
    if (!enabled || !projectPath || invalid || pending.current) return
    if (name.trim() + parts.suffix === filename) {
      setRenaming(false)
      return
    }
    if (documentWorkspaces.forProject(project).hasDirtyProjectPath(project, projectPath)) {
      toast({ title: t('feedback.renameDirty'), tone: 'error' })
      return
    }
    pending.current = true
    setBusy(true)
    try {
      const result = await mutateProjectNode(project, 'rename', {
        path: projectPath,
        name: name.trim() + parts.suffix,
      })
      if (currentProject.current !== project) return
      if (!result.ok || !result.node) {
        toast({ title: layoutText('explorerFailed'), description: result.error, tone: 'error' })
        return
      }
      const synced = await act.relocateProjectExplorerNode(
        projectPath,
        result.node.path,
        result.node.name
      )
      if (!synced) toast({ title: layoutText('explorerContextSyncFailed'), tone: 'error' })
      setRenaming(false)
    } catch (error) {
      toast({ title: layoutText('explorerFailed'), description: String(error), tone: 'error' })
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <>
      <SessionFileLink
        {...link}
        actions={
          <>
            <ContextMenuItem
              data-testid="output-file-reference"
              disabled={!enabled}
              onSelect={() => {
                if (projectPath)
                  act.addAiContextRef({
                    kind: 'file',
                    sourceId: projectPath,
                    projectId: project,
                    label: filename,
                  })
              }}
            >
              {t('menu.addToConversation')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="output-file-import"
              disabled={!enabled}
              onSelect={() => void act.importResourceFiles('copy', [absolutePath])}
            >
              {layoutText('explorerImportToLibrary')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              data-testid="output-file-rename"
              disabled={!enabled}
              onSelect={() => {
                setName(parts.basename)
                setRenaming(true)
              }}
            >
              {t('menu.rename')}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="output-file-delete"
              destructive
              disabled={!enabled}
              onSelect={() => {
                if (projectPath)
                  act.confirmResourceDelete({ path: projectPath, name: filename, kind: 'file' })
              }}
            >
              {t('menu.delete')}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        }
      />
      <Dialog
        open={renaming && enabled}
        onOpenChange={(open) => {
          if (!busy) setRenaming(open)
        }}
      >
        <DialogContent data-testid="output-file-rename-dialog">
          <DialogHeader>
            <DialogTitle>{t('menu.rename')}</DialogTitle>
            <DialogDescription>{filename}</DialogDescription>
          </DialogHeader>
          <Input
            label={layoutText('explorerName')}
            value={name}
            disabled={busy}
            helperText={parts.suffix}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Enter') void rename()
            }}
          />
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setRenaming(false)}>
              {layoutText('explorerCancel')}
            </Button>
            <Button
              data-testid="output-file-rename-confirm"
              loading={busy}
              disabled={Boolean(invalid)}
              onClick={() => void rename()}
            >
              {layoutText('explorerConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
