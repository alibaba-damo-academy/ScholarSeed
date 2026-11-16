import React from 'react'
import { useTranslation } from 'react-i18next'
import * as Conversation from '../conversation'
import {
  Button,
  Input,
  Textarea,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Alert,
  AlertDescription,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '../controls'
import { ToggleGroup, ToggleGroupItem } from '../../../apps/desktop/src/renderer/src/components/ui'
import { contracts, GROUPS } from './catalog.mjs'
import { generate, validate } from './schema.mjs'
import { examples } from './examples.mjs'
import { registeredExamples, collectionExamples } from './samples/registered.mjs'
import { groupedPreviewExamples, previewExamples } from './native.mjs'
import { entries, internal } from './inventory'
import { rules, relationships } from './rules.mjs'
import { RegisteredPreview, Boundary } from './bindings'

const STORAGE_KEY = 'scholarseed.ui.live-preview.v1'
const DEFAULT_SEED = 42
const DEFAULT_SAMPLE = 'BarChart'
const INITIAL_THEME = 'light'
export const previewEntries = entries
const registered = registeredExamples(entries)
const routed = previewExamples(entries, examples, contracts)
const presets = Object.fromEntries(entries.map(entry => [entry.name,
  [...(registered[entry.name] ?? []), ...(routed[entry.name] ?? [])],
]))
const groupedPresets = Object.fromEntries(entries
  .filter(entry => contracts[entry.name]?.previewGroup)
  .map(entry => [entry.name, groupedPreviewExamples(entries, presets, entry.name, contracts[entry.name].previewGroup)]))
const EMBEDDED_STORAGE_KEY = 'scholarseed.ui.materials-preview.v1'
const SURFACES = Object.freeze({ conversation: 'conversation', sidebar: 'sidebar', canvas: 'canvas' })
const exportCount = [...entries, ...internal].reduce(
  (total, entry) => total + 1 + entry.aliases.length,
  0
)
const format = (value) => JSON.stringify(value, null, 2)
const errorsFor = (schema, data) => {
  const structure = validate(schema, data)
  return structure.length ? structure : relationships(data)
}

function restore(storageKey) {
  try {
    return {
      ...JSON.parse(sessionStorage.getItem(storageKey) ?? '{}'),
      notice: '',
    }
  } catch (error) {
    return { records: {}, notice: `草稿未能恢复：${error.message}` }
  }
}

function fresh(name, contract, defaults = registered, example) {
  const preset = example ? [...(defaults[name] ?? []), ...(presets[name] ?? [])].find(item => item.id === example) : undefined
  const data = structuredClone(preset?.data ?? defaults[name]?.[0]?.data ?? contract.initial ?? generate(contract.schema, `${name}:${DEFAULT_SEED}`, rules, 'normal'))
  return {
    data,
    text: format(data),
  }
}

export function Preview({ sample, example, onOpenWebSource, collection } = {}) {
  const { t, i18n } = useTranslation('official')
  const displayName = item => i18n.exists(`labels.${item.name}`, { ns: 'official' })
    ? t(`labels.${item.name}`) : item.label ?? item.name
  const availableEntries = collection?.entries ?? entries
  const RenderPreview = collection?.render ?? RegisteredPreview
  const defaults = React.useMemo(() => collection ? collectionExamples(availableEntries, collection.examples) : registered, [collection, availableEntries])
  const embedded = sample !== undefined
  const storageKey = `${collection?.storageKey ?? (embedded ? EMBEDDED_STORAGE_KEY : STORAGE_KEY)}${example ? `.${sample}.${example}` : ''}`
  const [saved] = React.useState(() => restore(storageKey))
  const [localSelection, setSelected] = React.useState(
    () => (!embedded && location.hash.slice(1)) || saved.selected || DEFAULT_SAMPLE
  )
  const [presetSelection, setPresetSelection] = React.useState(saved.presetSelection ?? null)
  const requestedSample = sample ?? localSelection
  const requested = presetSelection?.owner === requestedSample ? presetSelection.sample : requestedSample
  const [records, setRecords] = React.useState(saved.records ?? {})
  const [query, setQuery] = React.useState('')
  const [theme, setTheme] = React.useState(saved.theme ?? INITIAL_THEME)
  const [compact, setCompact] = React.useState(false)
  const [feedback, setFeedback] = React.useState('')
  const [notice, setNotice] = React.useState(saved.notice)
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [surface, setSurface] = React.useState(SURFACES.conversation)
  const surfaceTrigger = React.useRef(null)
  const detail = React.useRef(null)
  const main = React.useRef(null)
  const entry = availableEntries.find((item) => item.name === requested || item.aliases.includes(requested))
  const selected = entry?.name ?? requested
  const labelKey = `labels.${selected}`
  const label = i18n.exists(labelKey, { ns: 'official' }) ? t(labelKey) : entry?.label ?? selected
  const sidebarShown = Boolean(entry?.sidebar) && surface === SURFACES.sidebar
  const canvasShown = Boolean(collection?.canvas) && surface === SURFACES.canvas
  const openSidebar = React.useCallback(() => setSurface(SURFACES.sidebar), [])
  const closeSidebar = () => {
    setSurface(SURFACES.conversation)
    surfaceTrigger.current?.focus()
  }
  const record = React.useMemo(
    () =>
      entry && !entry.missing
        ? (records[selected] ??
          entry.aliases.map((alias) => records[alias]).find(Boolean) ??
          fresh(selected, entry, defaults, example))
        : null,
    [entry, records, selected, defaults, example]
  )
  const { error, parsed } = React.useMemo(() => {
    if (!record) return { error: '', parsed: undefined }
    try {
      const parsed = JSON.parse(record.text)
      return { parsed, error: errorsFor(entry.schema, parsed).join('\n') }
    } catch (failure) {
      return { parsed: undefined, error: failure.message }
    }
  }, [record?.text, entry?.schema])
  const applied = error ? record?.data : parsed
  const stale = applied && entry && errorsFor(entry.schema, applied).length > 0
  const data = stale ? fresh(selected, entry, defaults, example).data : applied
  const availableExamples = React.useMemo(
    () => {
      const candidates = (collection ? defaults[selected] : example ? presets[selected] : groupedPresets[requestedSample] ?? presets[selected]) ?? []
      return example ? candidates.filter(item => item.id === example) : candidates
    },
    [selected, defaults, collection, example, requestedSample]
  )
  const grouped = !collection && !example && Boolean(groupedPresets[requestedSample])
  const exampleLabel = example => {
    const label = example.scale ? t(`scale.${example.unit}`, {
      scale: t(`scale.${example.scale}`), count: example.count, series: example.series,
    }) : example.labelKey ? t(example.labelKey) : example.label
    const target = availableEntries.find(entry => entry.name === example.sample)
    return target ? `${displayName(target)} · ${label}` : label
  }
  React.useEffect(() => {
    if (embedded) return
    document.documentElement.dataset.theme = theme
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme, embedded])
  React.useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ selected, theme, records, presetSelection }))
    } catch (failure) {
      setNotice(`当前草稿无法持久保存，但仍可在本页编辑：${failure.message}`)
    }
  }, [selected, theme, records, storageKey, presetSelection])
  React.useEffect(() => {
    if (embedded) return
    const update = () => setSelected(location.hash.slice(1) || DEFAULT_SAMPLE)
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [embedded])
  React.useEffect(() => {
    main.current?.scrollTo({ top: 0 })
    setFeedback('')
    setSurface(SURFACES.conversation)
  }, [selected])
  React.useEffect(() => {
    if (sidebarShown) detail.current?.focus()
  }, [sidebarShown])
  const choose = (value) => {
    setSelected(value)
    if (!embedded) location.hash = value
  }
  const modify = (changes) =>
    setRecords((current) => ({
      ...current,
      [selected]: { ...record, ...changes },
    }))
  const edit = (value) => {
    let updated = { text: value }
    try {
      const candidate = JSON.parse(value)
      if (errorsFor(entry.schema, candidate).length === 0) updated.data = candidate
    } catch (failure) {
      updated.error = failure.message
    }
    modify(updated)
  }
  const chooseExample = preset => {
    if (!preset.sample) {
      edit(format(preset.data))
      return
    }
    setPresetSelection({ owner: requestedSample, sample: preset.sample })
    setRecords(current => ({
      ...current,
      [preset.sample]: { data: structuredClone(preset.data), text: format(preset.data) },
    }))
  }
  const visible = availableEntries.filter((item) =>
    [item.name, item.label, ...item.aliases.flatMap((alias) => [alias, contracts[alias]?.label])]
      .filter(Boolean)
      .concat(displayName(item))
      .join(' ')
      .toLowerCase()
      .includes(query.trim().toLowerCase())
  )
  const groups = [
    ...new Set([...Object.values(GROUPS), ...visible.map((item) => item.group ?? '缺少数据契约')]),
  ].filter((group) => visible.some((item) => (item.group ?? '缺少数据契约') === group))
  const renderEditor = (id) =>
    record && (
      <div className="flex min-h-0 flex-1 flex-col gap-[var(--vds-space-3)] overflow-y-auto">
        <label htmlFor={id} className="font-[var(--vds-fw-semibold)]">
          {t('json')}
        </label>
        <p
          role="status"
          data-testid="preview-data-state"
          className="m-0 text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
        >
          {error ? t('invalid') : t('applied')}
        </p>
        {error && (
          <Alert tone="error" data-testid="preview-data-error">
            <AlertDescription>
              <span className="m-0 block max-h-[var(--vds-preview-content-max-height)] overflow-auto whitespace-pre-wrap break-words">
                {error}
              </span>
            </AlertDescription>
          </Alert>
        )}
        {stale && (
          <Alert tone="warning">
            <AlertDescription>{t('stale')}</AlertDescription>
          </Alert>
        )}
        <Textarea
          id={id}
          aria-label={t('json')}
          value={record.text}
          onChange={(event) => edit(event.target.value)}
          spellCheck={false}
          className="min-h-[var(--vds-message-center-list-height)] flex-1 resize-none [font-family:var(--vds-font-code)]"
        />
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button size="sm" variant="ghost">
              {t('schema')}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <Conversation.Markdown text={`\`\`\`json\n${format(entry.schema)}\n\`\`\``} />
          </CollapsibleContent>
        </Collapsible>
      </div>
    )
  return (
    <div
      className={`flex min-w-0 flex-col overflow-x-clip bg-[var(--vds-bg-page)] ${embedded ? 'h-full min-h-0' : 'h-dvh'}`}
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-[var(--vds-space-3)] border-b border-[var(--vds-border-default)] px-[var(--vds-space-6)] py-[var(--vds-space-4)]">
        {!embedded && (
          <div>
            <h1 className="m-0 text-[length:var(--vds-font-title)] font-[var(--vds-fw-semibold)]">
              官方 UI 实时预览
            </h1>
            <p className="m-0 text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
              源码直连；自动发现 {exportCount} 个对话导出，{internal.length} 个仅内部使用，合并为{' '}
              {entries.length} 个入口；所有业务动作仅模拟
            </p>
          </div>
        )}
        <div className="flex flex-wrap gap-[var(--vds-space-2)]">
          {!embedded && (
            <Button
              size="sm"
              variant="secondary"
              aria-pressed={theme === 'dark'}
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {t('theme')}
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            aria-pressed={compact}
            onClick={() => setCompact(!compact)}
          >
            {t('compact')}
          </Button>
          <Button
            className={embedded ? undefined : 'lg:hidden'}
            size="sm"
            variant="secondary"
            onClick={() => setEditorOpen(true)}
            disabled={!record}
          >
            {t('edit')}
          </Button>
        </div>
      </header>
      {notice && (
        <Alert role="status" tone="warning">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {feedback && (
        <Alert role="status" data-testid="preview-feedback" className="shrink-0 !rounded-none">
          <AlertDescription className="flex items-center justify-between gap-[var(--vds-space-2)]">
            <span
              tabIndex={0}
              aria-label={t('feedback')}
              className="max-h-[var(--vds-space-12)] min-w-0 overflow-auto break-words"
            >
              {feedback}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setFeedback('')}>
              {t('closeFeedback')}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <div className="flex min-h-0 min-w-0 flex-1">
        {!embedded && (
          <nav
            aria-label="自动发现的对话卡片"
            className="hidden w-[var(--vds-project-nav-width)] shrink-0 content-start gap-[var(--vds-space-3)] overflow-y-auto border-r border-[var(--vds-border-default)] p-[var(--vds-space-4)] md:grid"
          >
            <Input
              aria-label="查找对话卡片"
              placeholder="名称或用途"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {groups.map((group) => (
              <section
                key={group}
                data-category={group}
                className="grid min-w-0 gap-[var(--vds-space-1)]"
              >
                <h2 className="my-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-medium)] text-[var(--vds-text-secondary)]">
                  {group}
                </h2>
                {visible
                  .filter((item) => (item.group ?? '缺少数据契约') === group)
                  .map((item) => (
                    <Button
                      key={item.name}
                      data-export={item.name}
                      data-aliases={JSON.stringify(item.aliases)}
                      aria-label={t('previewComponent', { name: displayName(item) })}
                      aria-current={selected === item.name ? 'page' : undefined}
                      variant={selected === item.name ? 'secondary' : 'ghost'}
                      className="min-w-0 justify-start text-left"
                      onClick={() => choose(item.name)}
                    >
                      <span className="min-w-0 truncate">
                        {displayName(item)}
                        {item.missing ? '（缺契约）' : ''}
                      </span>
                    </Button>
                  ))}
              </section>
            ))}
            {!visible.length && <p role="status">没有匹配的官方导出。</p>}
          </nav>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-[var(--vds-space-3)] border-b border-[var(--vds-border-default)] p-[var(--vds-space-4)]">
            {!embedded && (
              <div className="md:hidden">
                <Select value={selected} onValueChange={choose}>
                  <SelectTrigger aria-label="选择对话卡片">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.map((group) => (
                      <div role="group" aria-label={group} key={group}>
                        <p className="m-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
                          {group}
                        </p>
                        {visible
                          .filter((item) => (item.group ?? '缺少数据契约') === group)
                          .map((item) => (
                            <SelectItem value={item.name} key={item.name}>
                              {displayName(item)}
                            </SelectItem>
                          ))}
                      </div>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-semibold)]">
              {label}
            </h2>
            {(entry?.sidebar || collection?.canvas) && (
              <ToggleGroup
                mode="single"
                allowEmpty={false}
                value={surface}
                onValueChange={setSurface}
                aria-label={t('surface.title')}
                size="sm"
                variant="outline"
              >
                <ToggleGroupItem value={SURFACES.conversation}>
                  {t('surface.conversation')}
                </ToggleGroupItem>
                {collection?.canvas ? (
                  <ToggleGroupItem value={SURFACES.canvas}>{t('upstream.canvas')}</ToggleGroupItem>
                ) : (
                  <ToggleGroupItem ref={surfaceTrigger} value={SURFACES.sidebar}>
                    {t('surface.sidebar')}
                  </ToggleGroupItem>
                )}
              </ToggleGroup>
            )}
            {record && (
              <>
                {availableExamples.length ? (
                  <div
                    role="group"
                    aria-label={t('examples')}
                    className="flex min-w-0 flex-1 flex-wrap gap-[var(--vds-space-2)]"
                  >
                    {grouped ? (
                      <Select
                        value={availableExamples.find(preset => preset.sample === selected && record.text === format(preset.data))?.id ?? ''}
                        onValueChange={value => {
                          const preset = availableExamples.find(preset => preset.id === value)
                          if (preset) chooseExample(preset)
                        }}
                      >
                        <SelectTrigger aria-label={t('examples')} className="w-full">
                          <SelectValue placeholder={t('examples')} />
                        </SelectTrigger>
                        <SelectContent>
                          {availableExamples.map(preset => (
                            <SelectItem key={preset.id} value={preset.id} data-preview-id={preset.id} data-preview-sample={preset.sample}>
                              {exampleLabel(preset)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : availableExamples.map((example) => {
                      const active = record.text === format(example.data)
                      return (
                        <Button
                          key={example.id}
                          size="sm"
                          variant={active ? 'secondary' : 'ghost'}
                          aria-pressed={active}
                          onClick={() => chooseExample(example)}
                        >
                          {exampleLabel(example)}
                        </Button>
                      )
                    })}
                  </div>
                ) : (
                  <span role="status">{t('noExamples')}</span>
                )}
                <Button size="sm" variant="ghost" onClick={() => modify(fresh(selected, entry, defaults, example))}>
                  {t('resetDefault')}
                </Button>
              </>
            )}
          </div>
          <div className="flex min-h-0 min-w-0 flex-1">
            <main
              ref={main}
              aria-label={t('effect')}
              className="min-w-0 flex-1 overflow-y-auto p-[var(--vds-space-6)]"
            >
              <article
                data-testid="preview-answer"
                data-sample={selected}
                className={
                  sidebarShown || canvasShown
                    ? 'grid min-w-0 gap-[var(--vds-conversation-block-gap)]'
                    : compact
                      ? 'mx-auto grid min-w-0 max-w-[var(--vds-floating-conversation-width)] gap-[var(--vds-conversation-block-gap)]'
                      : 'mx-auto grid min-w-0 max-w-[var(--vds-conversation-content-width)] gap-[var(--vds-conversation-block-gap)]'
                }
              >
                {!entry || entry.missing ? (
                  <Alert tone="warning" data-testid="preview-missing-contract">
                    <AlertDescription>{t('missing', { name: selected })}</AlertDescription>
                  </Alert>
                ) : (
                  <>
                    {!sidebarShown && (
                      <Conversation.Markdown
                        text={t(collection ? 'upstream.intro' : 'intro', {
                          name: label,
                        })}
                      />
                    )}
                    <div
                      ref={detail}
                      tabIndex={sidebarShown ? -1 : undefined}
                      role={sidebarShown ? 'region' : undefined}
                      aria-label={sidebarShown ? t('surface.workspace') : undefined}
                      data-testid={sidebarShown ? 'preview-host-detail' : undefined}
                      className={
                        sidebarShown
                          ? 'grid min-w-0 gap-[var(--vds-space-3)] rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)] p-[var(--vds-space-4)]'
                          : 'min-w-0 max-w-full'
                      }
                    >
                      {sidebarShown && (
                        <div className="flex min-w-0 items-start justify-between gap-[var(--vds-space-3)]">
                          <div className="min-w-0">
                            <h3 className="m-0 text-[length:var(--vds-font-subhead)]">
                              {t('surface.workspace')}
                            </h3>
                            <p className="m-0 text-[length:var(--vds-font-caption)] text-[var(--vds-text-secondary)]">
                              {t('surface.notice')}
                            </p>
                          </div>
                          <Button size="sm" variant="ghost" onClick={closeSidebar}>
                            {t('surface.close')}
                          </Button>
                        </div>
                      )}
                      <Boundary key={selected + surface + format(data)}>
                        <div data-testid="preview-component" className="min-w-0 max-w-full">
                          <RenderPreview
                            name={selected}
                            contract={entry}
                            data={data}
                            draft={record?.draft}
                            onDraft={draft => modify({ ...record, draft })}
                            onAction={setFeedback}
                            surface={canvasShown ? SURFACES.canvas : sidebarShown ? SURFACES.sidebar : SURFACES.conversation}
                            onOpenSidebar={openSidebar}
                            onOpenWebSource={onOpenWebSource}
                          />
                        </div>
                      </Boundary>
                    </div>
                    <p className="m-0 text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
                      {selected}
                      {entry.aliases.length > 0
                        ? t('aliases', { names: entry.aliases.join('、') })
                        : ''}
                    </p>
                  </>
                )}
              </article>
            </main>
            {record && !embedded && (
              <aside
                aria-label="数据编辑器"
                className="hidden w-[var(--vds-floating-conversation-width)] shrink-0 flex-col gap-[var(--vds-space-3)] overflow-y-auto border-l border-[var(--vds-border-default)] p-[var(--vds-space-4)] lg:flex"
              >
                {renderEditor('preview-json-sidebar')}
              </aside>
            )}
          </div>
        </div>
      </div>
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="!flex h-[var(--vds-preview-editor-height)] !w-[var(--vds-preview-editor-width)] min-h-0 flex-col overflow-hidden">
          <DialogTitle>{t('editorTitle')}</DialogTitle>
          <DialogDescription>{t('editorDescription')}</DialogDescription>
          {renderEditor('preview-json-dialog')}
        </DialogContent>
      </Dialog>
    </div>
  )
}
