import type { CardState } from '../contract'

const { React, Button, Checkbox, mount } = window.scholarseedUI
const PENDING = 'pending'
const CONFIRM = 'confirm'
const DEFAULT_LANGUAGE = 'en'
const labels = {
  zh: { title: '选择方法对比维度', confirm: '确认对比维度', confirmed: '已确认对比维度', failed: '操作未完成，请重试。' },
  en: { title: 'Choose method comparison dimensions', confirm: 'Confirm dimensions', confirmed: 'Comparison dimensions confirmed', failed: 'The operation failed. Please retry.' },
}

function Comparison({ state }: { state: CardState }): React.JSX.Element {
  const text = labels[state.language.startsWith('zh') ? 'zh' : DEFAULT_LANGUAGE]
  const choices = (state.data.choices ?? []) as { id: string; label: string; description?: string }[]
  const selected = (state.draft?.selected ?? state.data.selected ?? []) as string[]
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const disabled = busy || state.status !== PENDING
  async function choose(identifier: string): Promise<void> {
    setBusy(true)
    setError('')
    try { await window.plugin.save({ selected: selected.includes(identifier) ? selected.filter(value => value !== identifier) : [...selected, identifier] }) }
    catch { setError(text.failed) }
    finally { setBusy(false) }
  }
  return <section className="grid gap-[var(--vds-space-3)]" aria-label={text.title}>
    <h3>{text.title}</h3>
    {choices.map(choice => <Checkbox key={choice.id} checked={selected.includes(choice.id)} disabled={disabled} onCheckedChange={() => { void choose(choice.id) }}>
      <span>{choice.label}{choice.description && <span className="block text-[var(--vds-text-secondary)]">{choice.description}</span>}</span>
    </Checkbox>)}
    {error && <p role="alert">{error}</p>}
    <div className="flex justify-end"><Button disabled={disabled || selected.length === 0} loading={busy} onClick={() => window.plugin.submit(CONFIRM, { selected })}>{state.status === PENDING ? text.confirm : text.confirmed}</Button></div>
  </section>
}

mount(state => <Comparison state={state} />)
