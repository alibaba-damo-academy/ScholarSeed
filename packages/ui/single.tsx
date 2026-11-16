import type { CardState } from './contract'

const { React, Conversation, Button, Alert, AlertDescription, mount, useTranslation } = window.scholarseedUI
const views = {
  'plot.view': Conversation.Plot,
  'table.view': Conversation.DataTable,
  'formula.view': Conversation.Formula,
  'markdown.view': Conversation.Markdown,
}

function Single({ state }: { state: CardState }): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const View = views[state.slot as keyof typeof views] as unknown as React.ComponentType<Record<string, unknown>>
  const [selected, setSelected] = React.useState<string[]>((state.draft?.selected ?? state.data.selected ?? []) as string[])
  const current = React.useRef(selected)
  const queue = React.useRef(Promise.resolve())
  const submitting = React.useRef(false)
  const [busy, setBusy] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const selectable = state.slot === 'plot.view' || state.slot === 'table.view'
  const pending = state.status === 'pending'
  const select = (ids: string[]): void => {
    const next = [...new Set(ids)]
    current.current = next
    setSelected(next)
    queue.current = queue.current.then(async () => {
      await window.plugin.save({ selected: next })
      setFailed(false)
    }).catch(() => setFailed(true))
  }
  const submit = async (action: string): Promise<void> => {
    if (submitting.current || !pending) return
    submitting.current = true
    setBusy(true)
    try {
      const values = { selected: action === 'cancel' ? [] : current.current }
      await queue.current
      await window.plugin.save(values)
      setFailed(false)
      window.plugin.submit(action, values)
    } catch { setFailed(true) }
    finally { submitting.current = false; setBusy(false) }
  }
  if (!View) throw new Error('component_slot_unknown')
  return <section className="grid min-w-0 gap-[var(--vds-space-3)]">
    <View {...state.data} {...(selectable ? { selected, onSelectionChange: pending ? select : undefined } : {})} />
    {failed && <Alert tone="error"><AlertDescription>{t('composition.failed')}</AlertDescription></Alert>}
    {pending && <div className="flex justify-end gap-[var(--vds-space-2)]">
      <Button disabled={busy} variant="ghost" onClick={() => void submit('cancel')}>{t('composition.cancel')}</Button>
      <Button disabled={busy} onClick={() => void submit('continue')}>{t('composition.continue')}</Button>
    </div>}
  </section>
}

mount(state => <Single state={state} />)
