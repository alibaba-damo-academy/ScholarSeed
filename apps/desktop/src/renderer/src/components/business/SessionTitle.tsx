import { sessionDisplayTitle } from '../../session'
import { feedback } from '../../contracts/feedback'
import React from 'react'
import { useTranslation } from 'react-i18next'

import { renameSession } from '../../api'
import type { SessionNode } from '../../model'
import { SESSION_TITLE_MAX_LENGTH } from '../../model'
import { useApp } from '../../store'
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormControl,
  FormField,
  FormLabel,
  Input,
} from '../ui'

export function SessionRenameDialog(): React.JSX.Element {
  const { t } = useTranslation('components')
  const { state, set, act } = useApp()
  const target = state.sessionRename!
  const [value, setValue] = React.useState(target.originalTitle)
  const [saving, setSaving] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const close = (): void => {
    if (!saving) set({ sessionRename: null })
  }
  const save = async (): Promise<void> => {
    const title = value.trim()
    if (saving || !title) return
    if (title === target.originalTitle) {
      close()
      return
    }
    setSaving(true)
    setFailed(false)
    try {
      const result = await renameSession(target.sessionId, title)
      if (!result.ok) {
        setFailed(true)
        return
      }
      act.renameSessionTitle(target.sessionId, result.title ?? title, result.title_fallback)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent data-testid="session-rename-dialog">
        <DialogHeader>
          <DialogTitle>{t('sessionMenu.rename')}</DialogTitle>
        </DialogHeader>
        <FormField id="session-rename-name">
          <FormLabel>{t('sessionTitle.name')}</FormLabel>
          <FormControl>
            <Input
              autoFocus
              maxLength={SESSION_TITLE_MAX_LENGTH}
              value={value}
              disabled={saving}
              data-testid="session-rename-input"
              onChange={(event) => setValue(event.currentTarget.value)}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void save()
                }
              }}
            />
          </FormControl>
        </FormField>
        {failed && <Alert tone="error" description={t('sessionTitle.failed')} />}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={close}>
            {t('sessionTitle.cancel')}
          </Button>
          <Button disabled={saving || !value.trim()} onClick={() => void save()}>
            {t('sessionTitle.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SessionTitleEditor({ node }: { node: SessionNode }): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: assistantText } = useTranslation('assistant')
  const { set, act } = useApp()
  const [value, setValue] = React.useState(node.title)
  const [saving, setSaving] = React.useState(false)
  const cancelled = React.useRef(false)

  const finish = async (): Promise<void> => {
    if (saving || cancelled.current) return
    const title = value.trim()
    if (!title) {
      set({ sessionRename: null })
      return
    }
    if (title === node.title) {
      set({ sessionRename: null })
      return
    }
    setSaving(true)
    const result = await renameSession(node.id, title)
    if (result.ok) {
      act.renameSessionTitle(node.id, result.title ?? title, result.title_fallback)
      return
    }
    set({ sessionRename: null, foregroundError: feedback('components', 'sessionTitle.failed') })
  }

  return (
    <Input
      unstyled
      autoFocus
      className="h-[24px] min-w-0 flex-1 box-border rounded-[5px] border border-[var(--accent)] bg-[var(--bg)] px-[6px] py-[2px] text-[13.5px] text-[var(--text)] outline-none focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--accent)_18%,transparent)]"
      data-testid={`sidebar-session-title-input-${node.id}`}
      aria-label={t('sessionTitle.rename', { title: sessionDisplayTitle(node, assistantText) })}
      maxLength={SESSION_TITLE_MAX_LENGTH}
      value={value}
      disabled={saving}
      onChange={(event) => setValue(event.currentTarget.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => {
        void finish()
      }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.currentTarget.blur()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          cancelled.current = true
          set({ sessionRename: null })
        }
      }}
    />
  )
}
