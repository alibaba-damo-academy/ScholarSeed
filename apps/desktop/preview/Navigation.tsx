import React, { useState } from 'react'
import { ChevronDown, ChevronRight, Play } from 'lucide-react'
import { Badge, Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from '../src/renderer/src/components/ui'
import type { PreviewPage, PreviewScenario } from './catalog.ts'
import { PDFE_PAGE_GROUPS, PDFE_MIN_GROUP_SCENARIOS, pdfeNavigationGroup } from './hierarchy.ts'
import { pdfeTitle, pdfeNavigationScenarios, type PdfeTranslate } from './collaboration.ts'

const CONTENT_CLASS = '!rounded-none !border-0 !bg-transparent !p-0'
const ICON_CLASS = 'size-[var(--vds-icon-8)] shrink-0'
const CHILDREN_CLASS = 'ml-[var(--vds-space-3)] grid min-w-0 grid-cols-1 gap-[var(--vds-space-2)] border-l border-[var(--vds-border-default)] pl-[var(--vds-space-3)]'

function toggleExpanded(current: ReadonlySet<string>, identity: string, open: boolean): Set<string> {
  const next = new Set(current)
  if (open) next.add(identity)
  else next.delete(identity)
  return next
}

interface SceneProps {
  page: PreviewPage
  scenarios: readonly PreviewScenario[]
  activePage: string
  scene: string
  pending: boolean
  translate: PdfeTranslate
  stateLabel: (state: string) => string
  onLaunch: (page: PreviewPage, scene: string) => void
}

function ScenarioButtons({ page, scenarios, activePage, scene, pending, translate, stateLabel, onLaunch }: SceneProps): React.JSX.Element {
  return <>{scenarios.map(scenario => {
    const current = page.id === activePage && scenario.id === scene
    const hintId = 'preview-hint-' + page.id + '-' + scenario.id
    return <Button key={scenario.id} aria-label={pdfeTitle(scenario, translate)} aria-describedby={hintId} data-testid={'preview-scene-' + page.id + '-' + scenario.id} aria-current={current ? 'page' : undefined} variant={current ? 'secondary' : 'ghost'} size="content" disabled={pending || !(page.target || page.host)} className="w-full items-start justify-between !whitespace-normal py-[var(--vds-space-2)] text-left" title={translate(current ? 'replayScene' : 'openScene')} onClick={() => onLaunch(page, scenario.id)}>
      <span className="grid min-w-0 flex-1 grid-cols-1 gap-[var(--vds-space-1)]">
        <span className="flex flex-wrap items-center gap-[var(--vds-space-2)]"><span>{pdfeTitle(scenario, translate)}</span>{current && <Badge size="sm" variant="outline">{translate('current')}</Badge>}</span>
        <span id={hintId} data-testid={hintId} className="text-[length:var(--vds-font-body-lv3)] leading-[var(--vds-lh-body-lv3)] text-[var(--vds-text-secondary)]">{translate('canTry')}: {(scenario.capabilityKeys?.map(key => translate(key)) ?? [...new Set(scenario.states.map(stateLabel))]).join(' · ')}</span>
      </span>
      <Play aria-hidden="true" className={ICON_CLASS} />
    </Button>
  })}</>
}

type ExpansionProps = { searching: boolean; expanded: ReadonlySet<string>; onToggle: (section: string, open: boolean) => void }

function ScenarioGroups(props: SceneProps & ExpansionProps): React.JSX.Element {
  return <>{[...new Set(props.scenarios.map(scenario => scenario.group ?? scenario.id))].map(identity => {
    const entries = props.scenarios.filter(scenario => (scenario.group ?? scenario.id) === identity)
    const group = entries[0].group
    if (!group || new Set(entries.map(entry => entry.aliasOf ?? entry.id)).size < PDFE_MIN_GROUP_SCENARIOS) return <ScenarioButtons key={identity} {...props} scenarios={entries} />
    const open = props.searching || props.expanded.has(group)
    return <Collapsible key={group} className="grid-cols-1 gap-0" open={open} onOpenChange={value => props.onToggle(group, value)}>
      <h4><CollapsibleTrigger asChild><Button aria-label={props.translate(group)} data-testid={'preview-family-' + props.page.id + '-' + group} variant="ghost" size="content" className="w-full justify-start !whitespace-normal">
        {open ? <ChevronDown aria-hidden="true" className={ICON_CLASS} /> : <ChevronRight aria-hidden="true" className={ICON_CLASS} />}
        <span className="flex-1 text-left">{props.translate(group)}</span><Badge aria-hidden="true" variant="outline" size="sm">{entries.length}</Badge>
      </Button></CollapsibleTrigger></h4>
      <CollapsibleContent className={CONTENT_CLASS}><div className={CHILDREN_CLASS}><ScenarioButtons {...props} scenarios={entries} /></div></CollapsibleContent>
    </Collapsible>
  })}</>
}

function ScenarioSections(props: SceneProps & ExpansionProps & { nested: readonly PreviewPage[] }): React.JSX.Element {
  const { page, scenarios, translate, stateLabel, searching, expanded, onToggle } = props
  return <>{[...new Set([...scenarios.map(scenario => scenario.section), ...props.nested.flatMap(child => typeof child.navigation === 'object' ? [child.navigation.section] : [])])].map(section => {
    const entries = scenarios.filter(scenario => scenario.section === section)
    const nested = props.nested.filter(child => typeof child.navigation === 'object' && child.navigation.section === section)
    if (!section) return <ScenarioButtons key="default" {...props} scenarios={entries} />
    const open = searching || expanded.has(section)
    return <Collapsible key={section} className="grid-cols-1 gap-0" open={open} onOpenChange={value => onToggle(section, value)}>
      <h3><CollapsibleTrigger asChild><Button aria-label={translate(section)} data-testid={'preview-section-' + page.id + '-' + section} variant="ghost" size="content" className="w-full justify-start !whitespace-normal font-[var(--vds-fw-medium)]">
        {open ? <ChevronDown aria-hidden="true" className={ICON_CLASS} /> : <ChevronRight aria-hidden="true" className={ICON_CLASS} />}
        <span className="flex-1 text-left">{translate(section)}</span><Badge aria-hidden="true" variant="outline" size="sm">{entries.length + nested.reduce((count, child) => count + child.scenarios.length, 0)}</Badge>
      </Button></CollapsibleTrigger></h3>
      <CollapsibleContent className={CONTENT_CLASS}>
        <div className={CHILDREN_CLASS}>
          <ScenarioGroups {...props} scenarios={entries} />
          {nested.map(child => <ScenarioButtons key={child.id} {...props} page={child} scenarios={child.scenarios} />)}
        </div>
      </CollapsibleContent>
    </Collapsible>
  })}</>
}

export function PdfeNavigation({ pages, selected, activePage, scene, searching, query = '', pending, translate, stateLabel, onSelect, onLaunch }: {
  pages: readonly PreviewPage[]
  selected: PreviewPage
  activePage: string
  scene: string
  searching: boolean
  query?: string
  pending: boolean
  translate: PdfeTranslate
  stateLabel: (state: string) => string
  onSelect: (page: PreviewPage) => void
  onLaunch: (page: PreviewPage, scene: string) => void
}): React.JSX.Element {
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set([pdfeNavigationGroup(selected).id]))
  const [expandedPages, setExpandedPages] = useState(() => new Set([selected.id]))
  const [expandedSections, setExpandedSections] = useState<Record<string, ReadonlySet<string>>>({})
  return <nav aria-label={translate('navigation')} aria-busy={pending} className="grid min-w-0 grid-cols-1 content-start gap-[var(--vds-space-2)]">
    {PDFE_PAGE_GROUPS.map(group => {
      const entries = pages.filter(page => !page.navigation && pdfeNavigationGroup(page).id === group.id)
      if (!entries.length) return null
      const groupOpen = searching || expandedGroups.has(group.id)
      return <Collapsible key={group.id} className="grid-cols-1 gap-0" open={groupOpen} onOpenChange={open => { if (!searching) setExpandedGroups(current => toggleExpanded(current, group.id, open)) }}>
        <CollapsibleTrigger asChild><Button data-testid={'preview-group-' + group.id} variant="ghost" size="content" className="w-full justify-start !whitespace-normal">
          {groupOpen ? <ChevronDown aria-hidden="true" className={ICON_CLASS} /> : <ChevronRight aria-hidden="true" className={ICON_CLASS} />}
          <span className="flex-1 text-left">{translate(group.title)}</span><Badge aria-hidden="true" variant="outline" size="sm">{entries.length}</Badge>
        </Button></CollapsibleTrigger>
        <CollapsibleContent className={CONTENT_CLASS}>
          <div className={CHILDREN_CLASS}>
          {entries.map(page => {
            const pageOpen = searching || expandedPages.has(page.id)
            const available = Boolean(page.target || page.host)
            const scenarios = pdfeNavigationScenarios(page, activePage, scene, query, translate)
            const nested = pages.filter(child => typeof child.navigation === 'object' && child.navigation.parentPage === page.id)
            const sectioned = page.scenarios.some(candidate => candidate.section)
            const context = { page, scenarios, activePage, scene, pending, translate, stateLabel, onLaunch }
            const activeScenario = page.id === activePage ? page.scenarios.find(candidate => candidate.id === scene) : undefined
            const activeChild = nested.find(child => child.id === activePage)
            const activeSection = activeScenario?.section ?? (typeof activeChild?.navigation === 'object' ? activeChild.navigation.section : undefined) ?? page.scenarios.find(candidate => candidate.section)?.section
            const sections = expandedSections[page.id] ?? new Set([activeSection, activeScenario?.group].filter((value): value is NonNullable<typeof value> => Boolean(value)))
            const content = <section key={page.id} data-testid={'preview-capabilities-' + page.id} className="mb-[var(--vds-space-3)] grid min-w-0 grid-cols-1 gap-[var(--vds-space-2)]">
              {!available && <p className="text-[length:var(--vds-font-body-lv3)] text-[var(--vds-text-secondary)]">{translate('mockUnavailable')}</p>}
              {sectioned ? <ScenarioSections {...context} nested={nested} searching={searching} expanded={sections} onToggle={(section, open) => {
                if (!searching) setExpandedSections(current => ({ ...current, [page.id]: toggleExpanded(current[page.id] ?? sections, section, open) }))
                if (open) onSelect(page)
              }} /> : <ScenarioButtons {...context} />}
            </section>
            if (sectioned) return content
            return <Collapsible key={page.id} className="grid-cols-1 gap-0" open={pageOpen} onOpenChange={open => { if (!searching) setExpandedPages(current => toggleExpanded(current, page.id, open)); if (open) onSelect(page) }}>
              <CollapsibleTrigger asChild><Button data-testid={'preview-page-' + page.id} variant="ghost" size="content" className="w-full justify-start !whitespace-normal text-left">
                {pageOpen ? <ChevronDown aria-hidden="true" className={ICON_CLASS} /> : <ChevronRight aria-hidden="true" className={ICON_CLASS} />}
                <span className="flex-1">{page.category === 'page' && page.entry !== 'projects' ? translate('pageOverview') : pdfeTitle(page, translate)}</span><span aria-hidden="true" className="text-[var(--vds-text-tertiary)]">{page.scenarios.length}</span>
              </Button></CollapsibleTrigger>
              <CollapsibleContent className={CONTENT_CLASS}><div className={CHILDREN_CLASS}>{content}</div></CollapsibleContent>
            </Collapsible>
          })}
          </div>
        </CollapsibleContent>
      </Collapsible>
    })}
  </nav>
}
