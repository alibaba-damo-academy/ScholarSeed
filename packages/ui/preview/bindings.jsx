import React from 'react'
import { useTranslation } from 'react-i18next'
import * as Conversation from '../conversation'
import * as UI from '../controls'
import { createLiteraturePorts } from '../ports'
import { jsonToOpenUI } from '@openuidev/lang-core'
import { RegisteredContent, registeredConversationLibrary } from '../../../apps/desktop/src/renderer/src/components/business/Declarative'
import { PublicComponentsContext } from '../../../apps/desktop/src/renderer/src/components/business/publicComponents'
import { OPENUI_FORMAT, OPENUI_VERSION, OPENUI_SLOT } from '../document'
import { nativeTree } from './native.mjs'
import { datasetTSV } from '../../../apps/desktop/src/renderer/src/components/ui/statistics'
import { groupArtifactBlocks } from '../../../apps/desktop/src/renderer/src/components/business/partition'
import { citationSourceGroupKeys, citationSourceType, groupCitationReferences, groupWebCitationSources } from '../../../apps/desktop/src/renderer/src/components/business/grouping'
import { citationReferenceUrl } from '../../../apps/desktop/src/renderer/src/contracts/citations'
import { webSearchSiteIconUrl } from '../../../apps/desktop/src/renderer/src/features/resources/api'
import { artifactPreviewKind } from '../../../apps/desktop/src/renderer/src/features/assistant/delivery'
import { writeClipboard } from '../../../apps/desktop/src/renderer/src/components/primitive/clipboard'
import { Icon } from '../../../apps/desktop/src/renderer/src/icons'

const callbackNames = [
  'onCopy',
  'onOpen',
  'onOpenExternal',
  'onOpenSessionFile',
  'onOpenResult',
  'openWebSource',
  'onRemove',
]
const controlled = {
  onSelectionChange: 'selected',
  onOpenChange: 'open',
  onModeChange: 'mode',
  onLocationChange: 'location',
}

export class Boundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: '' }
  }
  static getDerivedStateFromError(error) {
    return { error: String(error) }
  }
  render() {
    return this.state.error ? (
      <UI.Alert tone="error" data-testid="preview-render-error">
        <UI.AlertDescription>{this.state.error}</UI.AlertDescription>
      </UI.Alert>
    ) : (
      this.props.children
    )
  }
}

function Menu({ name, data, callbacks }) {
  const { t } = useTranslation('official')
  const Component = Conversation[name]
  return (
    <UI.DropdownMenu>
      <UI.DropdownMenuTrigger asChild>
        <UI.Button variant="secondary">{t('openMenu')}</UI.Button>
      </UI.DropdownMenuTrigger>
      <UI.DropdownMenuContent>
        <Component {...data} {...callbacks} kind="dropdown" />
      </UI.DropdownMenuContent>
    </UI.DropdownMenu>
  )
}

function SourceDirectory({ sources, resolutions, onOpen, onOpenWeb }) {
  return (
    <Conversation.CitationSources
      sourceIconUrl={webSearchSiteIconUrl}
      answerSources={sources}
      sourceKey={JSON.stringify([sources, resolutions])}
      loadSources={async () => ({ count: resolutions.length, sources: resolutions })}
      resolveSource={async (handle) => {
        const source = resolutions.find((candidate) => candidate.handle === handle)
        if (!source) throw new Error('preview_source_missing')
        return source
      }}
      reveal={onOpen}
      previewUrl={() => ''}
      openWebSource={onOpenWeb}
    />
  )
}

function FileCitationGroup({ entries, resolutions, sources = [], onOpen }) {
  const references = groupCitationReferences(
    entries,
    resolutions,
    async (source) => source,
    sources
  )
  if (!references.length) return null
  const groups = new Map()
  for (const reference of references) {
    const key =
      citationSourceType(reference.source.source_kind).groupKey ??
      JSON.stringify(['unknown', reference.source.handle])
    const group = groups.get(key) ?? []
    group.push(reference)
    groups.set(key, group)
  }
  return (
    <span className="inline-flex max-w-full flex-wrap gap-[var(--vds-space-1)]">
      {[...groups].map(([key, group]) => (
        <Conversation.CitationLink
          key={key}
          references={group}
          resolve={group[0].resolve}
          reveal={onOpen}
          previewUrl={() => ''}
        >
          {group[0].source.title}
        </Conversation.CitationLink>
      ))}
    </span>
  )
}

export function Bound({ name, contract, data, onAction, surface = 'conversation', onOpenSidebar, onOpenWebSource }) {
  const { t } = useTranslation('official')
  const { t: artifactText } = useTranslation('assistant')
  const [changes, setChanges] = React.useState({})
  const report = React.useCallback(
    (action, values) => {
      onAction(t('action', { name, action, values: JSON.stringify(values ?? null) }))
      return true
    },
    [name, onAction, t]
  )
  const callbacks = Object.fromEntries(
    callbackNames.map((action) => [action, async (...values) => report(action, values)])
  )
  if (onOpenWebSource) callbacks.openWebSource = onOpenWebSource
  callbacks.onCopy = async (text) => {
    await writeClipboard(text)
    report('onCopy', [text])
  }
  for (const [action, field] of Object.entries(controlled))
    callbacks[action] = (value) => {
      setChanges((current) => ({ ...current, [field]: value }))
      report(action, value)
    }
  const props = { ...data, ...changes }
  const sidebar = surface === 'sidebar' ? contract.sidebar : undefined
  const Component = Conversation[sidebar?.name ?? name]
  const fileMenu = {
    apps: [],
    appsLoading: false,
    loadApps: callbacks.onOpen,
    onCopyPath: callbacks.onCopy,
    onOpenWith: callbacks.onOpen,
    onReveal: callbacks.onOpen,
    onSaveAs: callbacks.onOpen,
    onImport: callbacks.onOpen,
    onOpen: callbacks.onOpen,
  }
  const ports = React.useMemo(
    () =>
      createLiteraturePorts(
        async (action, values = {}) => {
          report(action, values)
          if (action === 'open-results' && contract.sidebar && onOpenSidebar) onOpenSidebar()
          if (action === 'collections') return []
          if (action === 'create-collection') return { id: 'preview-collection', name: values.name }
          if (action === 'add-reference') return { id: values.refId }
          if (['open-source', 'open-results', 'open-artifact'].includes(action))
            return undefined
          throw new Error('预览未声明该模拟动作：' + action)
        },
        { projectId: 'preview-project', projectName: '合成交互预览' }
      ),
    [data, report, contract.sidebar, onOpenSidebar]
  )
  const renderArtifact = (item) => (
    <Conversation.Artifact
      key={item.artifact_id}
      primary={item}
      versions={[item]}
      primaryMeta={props.primaryMeta ?? item.primaryMeta}
      canImport={props.canImport}
      menuProps={{
        ...props.menuProps,
        ...fileMenu,
        directory: item.kind === 'directory',
        onOpen: () => report('preview', item.path),
      }}
      preview={() => report('preview', item.path)}
      previewVersion={() => report('version', item.artifact_id)}
      openImport={() => report('import', item.artifact_id)}
    />
  )
  switch (contract.adapter) {
    case 'markdown': {
      const sources = props.answerSources ?? []
      const resolutions = props.resolutions ?? []
      const renderCitation = (range, children, href) => {
        const source = sources.find(
          (candidate) => candidate.url === href || candidate.citation_urls?.includes(href)
        )
        if (!source) return undefined
        if (source.kind === 'searched')
          return (
            <Conversation.CitationLink
              key={range.start}
              source={source}
              named
              openWebSource={callbacks.openWebSource}
            />
          )
        const resolution = resolutions.find((candidate) => candidate.handle === source.handle)
        if (!resolution) return undefined
        return (
          <Conversation.CitationLink
            key={range.start}
            identity={resolution}
            resolve={async () => resolution}
            reveal={callbacks.onOpen}
            previewUrl={() => ''}
          >
            {children}
          </Conversation.CitationLink>
        )
      }
      return (
        <>
          <Component
            text={props.text}
            math={props.math}
            {...callbacks}
            citationUrls={sources.flatMap((source) => source.citation_urls ?? [source.url])}
            renderCitation={renderCitation}
            citationGroupKeys={citationSourceGroupKeys(resolutions, sources)}
            renderCitationGroup={(entries) => {
              const [source, ...additionalSources] = groupWebCitationSources(entries, sources)
              return source
                ? <Conversation.CitationLink source={source} additionalSources={additionalSources} sourceIconUrl={webSearchSiteIconUrl} openWebSource={callbacks.openWebSource} />
                : <FileCitationGroup entries={entries} resolutions={resolutions} sources={sources} onOpen={callbacks.onOpen} />
            }}
            resolveImage={(path) => props.images?.find((image) => image.path === path)?.url}
          />
          {sources.length > 0 && (
            <SourceDirectory
              sources={sources}
              resolutions={resolutions}
              onOpen={callbacks.onOpen}
              onOpenWeb={callbacks.openWebSource}
            />
          )}
        </>
      )
    }
    case 'artifact':
      return renderArtifact(props.primary)
    case 'artifacts': {
      const blocks = groupArtifactBlocks(props.items, (item) =>
        artifactPreviewKind(item) ? 'images' : 'files'
      )
      return blocks.map((block) =>
        block.kind === 'images' ? (
          <Conversation.ArtifactGroup
            key={block.entries[0].artifact_id}
            images={block.entries.map((item) => ({
              id: item.artifact_id,
              title: item.title || item.name,
              url: item.image_url,
              failed: !item.image_url,
              fit: artifactPreviewKind(item) === 'pdf' ? 'contain' : undefined,
              onOpen: artifactPreviewKind(item) === 'pdf' ? () => report('preview', item.path) : undefined,
            }))}
            renderImageActions={(image, preview, onClose) => {
              const item = block.entries.find((entry) => entry.artifact_id === image.id)
              if (!item) return null
              const action = (operation) => () => report(operation, item.path)
              return (
                <UI.DropdownMenu>
                  <UI.DropdownMenuTrigger asChild>
                    <UI.IconButton
                      icon={<Icon name="more-horizontal" className={preview ? undefined : 'rotate-90'} />}
                      label={artifactText('artifactEntry.moreActions', { name: item.name })}
                      size={preview ? 'sm' : 'md'}
                      variant={preview ? 'ghostIcon' : 'icon'}
                    />
                  </UI.DropdownMenuTrigger>
                  <UI.DropdownMenuContent
                    className={preview ? '!z-[var(--vds-z-modal-nested-flyout)]' : undefined}
                  >
                    {preview ? (
                      <UI.DropdownMenuItem onSelect={() => {
                        report('preview', item.path)
                        onClose?.()
                      }}>
                        {artifactText('images.openWorkbench')}
                      </UI.DropdownMenuItem>
                    ) : (
                      <>
                        <UI.DropdownMenuItem onSelect={action('preview')}>
                          {artifactText('artifactEntry.open')}
                        </UI.DropdownMenuItem>
                        <UI.DropdownMenuItem onSelect={action('addToConversation')}>
                          {artifactText('artifactEntry.addToConversation')}
                        </UI.DropdownMenuItem>
                      </>
                    )}
                    <Conversation.ArtifactMenuItems
                      {...fileMenu}
                      kind="dropdown"
                      imagePreview={preview}
                      canImport
                      canSaveAs
                      canUsePath
                      revealLabel={artifactText('images.reveal')}
                      onOpen={undefined}
                      onImport={action('import')}
                      onSaveAs={action('saveAs')}
                      onCopyPath={() => void callbacks.onCopy(item.path)}
                      onReveal={action('reveal')}
                    />
                  </UI.DropdownMenuContent>
                </UI.DropdownMenu>
              )
            }}
          />
        ) : (
          <Conversation.ArtifactGroup key={block.entries[0].artifact_id} fileLayout>
            {block.entries.map(renderArtifact)}
          </Conversation.ArtifactGroup>
        )
      )
    }
    case 'menu':
      return <Menu name={name} data={props} callbacks={fileMenu} />
    case 'research':
      return <Component detail={false} {...sidebar?.props} content={props.content} ports={ports} />
    case 'selection':
      return <Component {...props} {...callbacks} selected={props.selected ?? []} />
    case 'citation':
      if (props.resolutions?.length)
        return <FileCitationGroup entries={props.resolutions.map((source, index) => ({ href: citationReferenceUrl(source.handle), start: index, end: index + 1, label: source.title }))} resolutions={props.resolutions} onOpen={callbacks.onOpen} />
      if (props.source)
        return <Conversation.CitationLink {...props} sourceIconUrl={webSearchSiteIconUrl} openWebSource={callbacks.openWebSource} />
      return (
        <Component
          identity={props.resolution}
          resolve={async () => props.resolution}
          reveal={callbacks.onOpen}
          previewUrl={() => ''}
        >
          {props.children}
        </Component>
      )
    case 'sources':
      return (
        <SourceDirectory
          sources={props.answerSources}
          resolutions={props.resolutions ?? [props.resolution]}
          onOpen={callbacks.onOpen}
          onOpenWeb={callbacks.openWebSource}
        />
      )
    case 'tabulation': {
      const sources = props.sources ?? []
      const citations = props.citations ?? []
      const cellSources = (row, column) =>
        citations
          .filter((citation) => citation.rowId === row.id && citation.columnKey === column.key)
          .map((citation) => sources.find((source) => source.number === citation.sourceNumber))
          .filter(Boolean)
      const labels = props.dataset.columns.map((column) =>
        column.unit ? `${column.label} (${column.unit})` : column.label
      )
      const copyText = datasetTSV({
        columns: props.dataset.columns.map((column, index) => ({
          ...column,
          label: labels[index],
        })),
        rows: props.dataset.rows.map((row) => ({
          ...row,
          values: row.values.map((value, index) =>
            [
              value ?? '—',
              ...cellSources(row, props.dataset.columns[index]).map(
                (source) => `[${source.title}]`
              ),
            ].join(' ')
          ),
        })),
      })
      return (
        <>
          <Component
            caption={props.caption}
            notes={props.notes}
            copyText={copyText}
            onCopy={callbacks.onCopy}
          >
            <UI.Table>
              <UI.TableHeader>
                <UI.TableRow>
                  {props.dataset.columns.map((column, index) => (
                    <UI.TableHead key={column.key}>{labels[index]}</UI.TableHead>
                  ))}
                </UI.TableRow>
              </UI.TableHeader>
              <UI.TableBody>
                {props.dataset.rows.map((row) => (
                  <UI.TableRow key={row.id}>
                    {row.values.map((value, index) => (
                      <UI.TableCell key={index}>
                        {value ?? '—'}
                        {cellSources(row, props.dataset.columns[index]).map((source) => (
                          <Conversation.CitationLink
                            key={source.number}
                            source={source}
                            named
                            openWebSource={callbacks.openWebSource}
                          />
                        ))}
                      </UI.TableCell>
                    ))}
                  </UI.TableRow>
                ))}
              </UI.TableBody>
            </UI.Table>
          </Component>
          {sources.length ? (
            <Conversation.CitationSources
              sourceIconUrl={webSearchSiteIconUrl}
              sourceKey={JSON.stringify(sources)}
              answerSources={sources}
              resolveSource={async () => {
                throw new Error('网页来源不具有本地文档定位')
              }}
              reveal={callbacks.onOpen}
              previewUrl={() => ''}
              openWebSource={callbacks.openWebSource}
            />
          ) : null}
        </>
      )
    }
    case 'canvas':
      return (
        <Component document={props.document} title={props.title} draft={changes.draft} status={changes.status ?? props.status}
          full={Boolean(sidebar)} onOpen={onOpenSidebar}
          onDraft={async values => setChanges(current => ({ ...current, draft: values }))}
          onAction={async (action, values) => { report(action, values); setChanges(current => ({ ...current, status: action === 'cancel' ? 'cancelled' : 'resolved' })) }} />
      )
    case 'destination':
      return (
        <>
          <UI.Button onClick={() => setChanges((current) => ({ ...current, open: true }))}>
            {t('destination')}
          </UI.Button>
          <Component
            {...props}
            open={Boolean(changes.open)}
            onOpenChange={callbacks.onOpenChange}
            onLocationChange={callbacks.onLocationChange}
            onSubmit={() => {
              report('save', props.location)
              setChanges((current) => ({ ...current, open: false }))
            }}
          />
        </>
      )
    default:
      if (contract.adapter !== 'plain') throw new Error('未支持的组合适配：' + contract.adapter)
      return <Component {...props} {...callbacks} />
  }
}

export function RegisteredPreview({ name, contract, data, draft = {}, onDraft, onAction, surface = 'conversation', onOpenSidebar, onOpenWebSource }) {
  const bindings = React.useMemo(() => new Map([[name, {
    slot: name,
    render: scope => <Bound name={name} contract={contract} data={scope.data} onAction={onAction} surface={surface} onOpenSidebar={onOpenSidebar} onOpenWebSource={onOpenWebSource} />,
  }]]), [name, contract, onAction, surface, onOpenSidebar])
  const description = React.useMemo(() => contract.native ? {
    format: OPENUI_FORMAT, version: OPENUI_VERSION,
    source: jsonToOpenUI(nativeTree(contract.component, data, registeredConversationLibrary.root), registeredConversationLibrary),
  } : undefined, [contract.native, contract.component, data])
  return <PublicComponentsContext.Provider value={bindings}>
    <RegisteredContent slot={contract.native ? OPENUI_SLOT : name} data={description ?? data}
      status="pending" draft={draft}
      onDraft={async values => { onDraft(values); return { state: values } }}
      onAction={(action, values) => onAction(`${name} / ${action}：${JSON.stringify(values)}（仅模拟，不调用 Agent 或业务接口）`)} />
  </PublicComponentsContext.Provider>
}
