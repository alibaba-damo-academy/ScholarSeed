import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createInstance } from 'i18next'

import {
  literatureCollections,
  mergeLiteratureSummaries,
  replaceLiteratureSummary,
  timestampLabel,
} from './projection.ts'
import type { LiteratureSummary } from '../../contracts/literature.ts'

const listSource = readFileSync(new URL('./LiteratureList.tsx', import.meta.url), 'utf8')

test('literature filter uses category terminology in both languages', () => {
  for (const [language, labels] of [
    ['zh', ['未分类', '新建分类']],
    ['en', ['Uncategorized', 'New category']],
  ] as const) {
    assert.deepEqual(
      (['groups.unfiled', 'groups.new'] as const).map((key) =>
        engine.t(key, { ns: 'literature', lng: language })
      ),
      labels
    )
  }
})

test('returning from the literature overview restores the originating project workspace', () => {
  const start = listSource.indexOf('data-testid="literature-return-project"')
  assert.ok(start >= 0)
  const button = listSource.slice(start, listSource.indexOf('</Button>', start))
  assert.match(
    button,
    /act\.selectProject\(returnProject\.id\)\s+act\.openWorkbenchView\('resource', \{ preserveProject: true \}\)/
  )
  assert.doesNotMatch(button, /openWorkbenchView\('literature'/)
})

test('project table painting covers the visible column grid for every row type', () => {
  for (const selector of ['lit-table-head', 'lit-row', 'lit-attachment-row']) {
    assert.ok(
      listSource.includes(
        `[&>.${selector}]:min-w-[max(var(--vds-library-paper-width),var(--literature-grid-width))]`
      ),
      `${selector} must cover the grid, including resized and newly visible columns`
    )
  }
  assert.match(listSource, /columnWidths\.reduce\(/)
  assert.match(listSource, /columnWidths\.map\(/)
  assert.match(listSource, /'--literature-grid-width': `\$\{gridWidth\}px`/)
  assert.doesNotMatch(listSource, /const grid = `72px/)
})

test('group picker scrolls only its bounded collection list', () => {
  const groups = readFileSync(new URL('./Groups.tsx', import.meta.url), 'utf8')
  const popover = groups.slice(groups.indexOf('data-testid="literature-groups"'))
  const outer = popover.slice(0, popover.indexOf('>'))
  assert.match(outer, /overflow-hidden/)
  assert.doesNotMatch(outer, /overflow-y-auto/)
  assert.match(
    popover,
    /<ScrollArea\s+data-testid="literature-group-list"[\s\S]*?max-h-\[var\(--vds-library-group-menu-height\)\][\s\S]*?\{rows\(null\)\}\s*<\/div>\s*<\/ScrollArea>/
  )
  assert.ok(popover.indexOf("{t('groups.new')}") > popover.indexOf('</ScrollArea>'))
})

test('the batch delete button uses a trash icon in every library scope', () => {
  assert.match(
    listSource,
    /icon=\{<Trash\b[^>]*\/>\}\s+onClick=\{\(\) => setDeleteConfirmOpen\(true\)\}/
  )
  assert.doesNotMatch(listSource, /\bLogOut\b/)
})

test('batch destinations include groups, projects and tags in every library scope', () => {
  const toolbar = listSource.slice(listSource.indexOf("{literature('batch.addTo')}"))
  const menu = toolbar.slice(0, toolbar.indexOf('</DropdownMenuContent>'))
  assert.doesNotMatch(menu, /\bprojectId\b/)
  const destinations = [...menu.matchAll(/openBatch\('(collection|project|tag)'\)/g)].map(
    (match) => match[1]
  )
  assert.deepEqual(destinations, ['collection', 'project', 'tag'])
  for (const [language, labels] of [
    ['zh', ['我的分组', '项目', '标签']],
    ['en', ['My groups', 'Projects', 'Tags']],
  ] as const) {
    assert.deepEqual(
      (['collection', 'project', 'tag'] as const).map((key) =>
        engine.t(`batch.${key}`, { ns: 'literature', lng: language })
      ),
      labels
    )
  }
})

const selectAllContract =
  /const selectAllState =\s*visibleSelectedCount === 0\s*\? false\s*: visibleSelectedCount === items\.length \? true : 'mixed'/
const exportNoticeContract =
  /toast\(\{\s*title: literature\('batch\.exportSucceeded', \{ count: exported \}\),\s*tone: 'success',?\s*\}\)/
const timestampColumnContract = (key: string) =>
  new RegExp(
    `${key}: \\{\\s*labelKey: 'columns\\.${key}',\\s*sort: '${key}',\\s*minimum: 160,?\\s*\\}`
  )
const engine = createInstance()
await engine.init({
  fallbackLng: false,
  lng: 'zh',
  resources: {
    en: {
      literature: JSON.parse(
        readFileSync(
          new URL('../../../../localization/locales/en/literature.json', import.meta.url),
          'utf8'
        )
      ),
    },
    zh: {
      literature: JSON.parse(
        readFileSync(
          new URL('../../../../localization/locales/zh/literature.json', import.meta.url),
          'utf8'
        )
      ),
    },
  },
})
const moment = new Date(2026, 8, 15, 15, 46, 32)
const summary = (id: string, title: string, version: number): LiteratureSummary =>
  ({
    id,
    title,
    version,
  }) as LiteratureSummary
test('collection projection respects project scope without global fallback', () => {
  const item = {
    collections: [{ id: 'global', name: 'Global' }],
    project_collections: [{ id: 'project', name: 'Project' }],
  } as LiteratureSummary
  assert.deepEqual(literatureCollections(item), item.collections)
  assert.deepEqual(literatureCollections(item, 'project-id'), item.project_collections)
  assert.deepEqual(literatureCollections({ ...item, project_collections: [] }, 'project-id'), [])
  assert.deepEqual(literatureCollections({ ...item, collections: [] }), [])
})
// 与 localization/format.ts 的 createFormatters 同形, 但保留显式 locale 以便逐语言断言。
const formatters = (locale: string) => ({
  date: (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, options).format(value),
  relative: (
    value: number,
    unit: Intl.RelativeTimeFormatUnit,
    options?: Intl.RelativeTimeFormatOptions
  ) => new Intl.RelativeTimeFormat(locale, options).format(value, unit),
  number: (value: number) => String(value),
  bytes: (value: number) => String(value),
})

test('literature timestamps are shown down to the second', () => {
  assert.equal(timestampLabel(moment.toISOString(), formatters('zh-CN')), '2026/9/15 15:46:32')
  assert.equal(
    timestampLabel(moment.toISOString(), formatters('en-US')),
    new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'medium' }).format(moment)
  )
  assert.equal(timestampLabel('not a timestamp', formatters('zh-CN')), '')
})

test('a saved detail replaces only its visible row and rejects stale responses', () => {
  const first = summary('first', 'First', 2)
  const second = summary('second', 'Second', 4)
  const items = [first, second]

  const updated = summary('first', 'Updated first', 3)
  const next = replaceLiteratureSummary(items, updated)
  assert.notEqual(next, items)
  assert.equal(next[0], updated)
  assert.equal(next[1], second)
  assert.deepEqual(
    next.map((item) => item.id),
    ['first', 'second']
  )

  assert.equal(replaceLiteratureSummary(next, summary('first', 'Stale first', 1)), next)
  assert.equal(replaceLiteratureSummary(next, summary('missing', 'Missing', 1)), next)
})

test('an in-flight list response keeps an equally new local row update', () => {
  const fetched = [summary('first', 'Stale fetch', 3), summary('second', 'Second', 4)]
  const local = new Map([
    ['first', summary('first', 'Latest local', 3)],
    ['missing', summary('missing', 'Not in current query', 5)],
  ])

  const merged = mergeLiteratureSummaries(fetched, local)
  assert.equal(merged[0].title, 'Latest local')
  assert.equal(merged[1], fetched[1])
  assert.deepEqual(
    merged.map((item) => item.id),
    ['first', 'second']
  )

  const newerFetch = mergeLiteratureSummaries([summary('first', 'Newer fetch', 4)], local)
  assert.equal(newerFetch[0].title, 'Newer fetch')
})

test('the time columns keep room for a timestamp that carries seconds', () => {
  for (const key of ['created_at', 'updated_at']) {
    assert.match(listSource, timestampColumnContract(key))
  }
  assert.match(
    listSource,
    /width: Math\.min\([\s\S]*?Math\.max\(COLUMN_META\[entry\.key\]\.minimum, entry\.width\)/
  )
  assert.doesNotMatch(listSource, /Intl\.DateTimeFormat/)
})

test('literature source contracts reject semantic changes while tolerating formatting', () => {
  const mutations: Array<[RegExp, (source: string) => string]> = [
    ...['created_at', 'updated_at'].map((key): [RegExp, (source: string) => string] => [
      timestampColumnContract(key),
      (source) => source.replace('minimum: 160', 'minimum: 159'),
    ]),
    [selectAllContract, (source) => source.replace("'mixed'", 'false')],
    [exportNoticeContract, (source) => source.replace('count: exported', 'count: 0')],
    [exportNoticeContract, (source) => source.replace("tone: 'success'", "tone: 'error'")],
  ]
  for (const [contract, mutate] of mutations) {
    const fragment = listSource.match(contract)?.[0]
    assert.ok(fragment)
    const changed = mutate(fragment)
    assert.notEqual(changed, fragment)
    assert.doesNotMatch(changed, contract)
  }
})

test('the whole literature table is a copy drop target for external files', () => {
  assert.match(listSource, /data-testid="literature-drop-target"/)
  assert.match(listSource, /data-drop-active=\{pdfDropActive \? 'true' : 'false'\}/)
  assert.match(listSource, /hasDraggedFiles\(event\.dataTransfer\)/)
  assert.match(listSource, /event\.dataTransfer\.dropEffect = 'copy'/)
  assert.match(listSource, /void importPdfFiles\(event\.dataTransfer\.files\)/)
  assert.match(listSource, /literature\('pdfImport\.drop'\)/)
})

test('the literature header checkbox shows mixed selection for some visible rows', () => {
  assert.match(
    listSource,
    /const visibleSelectedCount = items\.filter\(\(item\) => picked\.has\(item\.id\)\)\.length/
  )
  assert.match(listSource, selectAllContract)
  assert.match(listSource, /checked=\{selectAllState\}/)
})

test('chip columns let the cell do the clipping so truncation stays detectable', () => {
  // 芯片自己压缩并内部省略时单元格永不溢出, tooltip 便无从判定, 因此必须保持自然宽度。
  assert.match(listSource, /const CHIP_CLASS = 'shrink-0 max-w-none'/)
  // 遗留的 .lit-row-projects 胶囊样式会覆盖设计系统徽标并让它自我省略。
  assert.doesNotMatch(listSource, /lit-row-projects/)
  assert.doesNotMatch(
    readFileSync(new URL('./literature.css', import.meta.url), 'utf8'),
    /lit-row-projects/
  )
})

test('the projects column shows only the first project and folds the rest into a +N chip', () => {
  // 一篇文献可归属多个项目: 全览列只画第一个, 其余折叠成计数芯片, 避免行高与列宽被项目数撑爆。
  assert.doesNotMatch(listSource, /item\.projects\.map\(/)
  assert.match(
    listSource,
    /<Badge\s+className=\{CHIP_CLASS\}\s+tone="brand"\s*>\s*\{item\.projects\[0\]\.name\}\s*<\/Badge>/
  )
  assert.match(listSource, /\+\{item\.projects\.length - 1\}/)
  // 计数芯片同样不参与压缩, 否则它会先自我省略而失去 tooltip 判定依据。
  assert.match(listSource, /const MORE_CHIP_CLASS = 'shrink-0 max-w-none tabular-nums'/)
  // 折叠掉的名单必须仍可通过 +N 芯片自身的 tooltip 与无障碍名读出。
  assert.match(listSource, /facetNames\(item\.projects\.slice\(1\)\)/)
  assert.match(listSource, /literature\('list\.moreProjects', \{/)
})

test('the batch bar exports bib and reports how many entries were written', () => {
  // 选中条目后的导出按钮文案与成功提示都是用户可见口径, 逐语言钉住。
  assert.equal(engine.getFixedT('zh', 'literature')('batch.export'), '导出bib')
  assert.equal(engine.getFixedT('en', 'literature')('batch.export'), 'Export BibTeX')
  assert.equal(
    engine.getFixedT('zh', 'literature')('batch.exportSucceeded', { count: 3 }),
    '成功导出 3 条文献'
  )
  assert.equal(
    engine.getFixedT('en', 'literature')('batch.exportSucceeded', { count: 1 }),
    'Exported 1 literature item'
  )
  assert.equal(
    engine.getFixedT('en', 'literature')('batch.exportSucceeded', { count: 2 }),
    'Exported 2 literature items'
  )
  // 条数取后端实际写入的 count, 请求 id 只在响应缺字段时兜底。
  assert.match(listSource, /const exported = result\.count \?\? ids\.length/)
  assert.match(listSource, exportNoticeContract)
})

test('every literature column reveals its full text through a truncation tooltip', () => {
  const cells = listSource.match(/<EllipsisText\b/g) ?? []
  const portalled = listSource.match(/tooltipPortalled/g) ?? []
  assert.equal(cells.length, portalled.length)
  assert.ok(cells.length >= 9)
  assert.doesNotMatch(listSource, /<span key=\{key\}/)
  assert.doesNotMatch(listSource, /title=\{item\./)
  assert.doesNotMatch(listSource, /title=\{facetNames/)
  assert.doesNotMatch(listSource, /title=\{attachment\.name\}/)
  assert.doesNotMatch(listSource, /<strong title=/)
})

test('double-clicking a row opens its primary fulltext and nothing else', () => {
  // 双击的目标是主附件; 没有可用主附件时不挂处理器, 因此「什么都不做」——
  // 这一判空必须留在渲染层, 否则 store 会弹「附件当前不可用」错误提示。
  // 「可用」= 行在且文件还在: 附件行可以比它的字节活得久, 打开一个已丢失的
  // 主附件只会换来一条错误提示, 与产品要求的静默不一致。
  assert.match(
    listSource,
    /const primaryAttachment = isAttachmentAvailable\(item\.primary_attachment\)\s*\? item\.primary_attachment\s*: null/
  )
  assert.match(
    listSource,
    /onDoubleClick=\{\s*primaryAttachment\s*\? \(\) => onOpenFulltext\(primaryAttachment\.id\)\s*: undefined\s*\}/
  )
  assert.doesNotMatch(listSource, /onDoubleClick=\{onActivate\}/)

  // 单击是详情开关: 抽屉正开着这条就收起, 否则打开这条。双击时 click 先触发两次,
  // 一开一关正好抵消, 所以「双击前抽屉是什么状态, 关掉 PDF 回来还是什么状态」,
  // 双击路径不需要额外收尾。
  assert.match(listSource, /onClick=\{onActivate\}/)
  assert.match(
    listSource,
    /if \(focusedId === item\.id && !focusedAttachmentId\) \{\s*catalogue\.focus\(null\)\s*return\s*\}\s*openDetail\(item\)/
  )
  // 右键菜单的「查看基本信息」是显式意图, 恒打开, 不参与 toggle。
  assert.match(listSource, /viewInfo: \(\) => openDetail\(item\)/)
  // Enter 与单击同语义; 方向键在行之间移动焦点 (roving tabindex)。
  assert.match(
    listSource,
    /if \(event\.key === 'Enter'\) \{\s*event\.preventDefault\(\)\s*toggleDetail\(item\)/
  )
  assert.match(listSource, /tabIndex=\{index === keyRowIndex \? 0 : -1\}/)

  // 容器的 pointerdown 兜底(点空白处收起抽屉)必须让位给行: 它先关一次的话,
  // 随后的 click 读到的 focusedId 已经清空, 抽屉被立刻重新打开, 单击永远关不掉。
  assert.match(listSource, /const ROW_SELECTOR_CLASS = 'lit-row'/)
  assert.match(
    listSource,
    /const ROW_CLASS =\s*'lit-row relative grid min-w-\[var\(--literature-grid-width\)\] library-narrow:min-w-\[max\(var\(--vds-library-table-narrow-min-width\),var\(--literature-grid-width\)\)\] items-center/
  )
  assert.match(
    listSource,
    /className=\{`\$\{ROW_CLASS\} group\/literature font-\[var\(--vds-fw-regular\)\]/
  )
  assert.match(
    listSource,
    /onPointerDownCapture=\{\(event\) => \{\s*if \(event\.button !== 0 \|\| !focusedId\) return[\s\S]*?if \(\(event\.target as HTMLElement\)\.closest\(`\.\$\{ROW_SELECTOR_CLASS\}`\)\) return\s*catalogue\.focus\(null\)\s*setDetailIntent\(null\)/
  )

  // 打开动作复用 store 既有的那一条, 不在列表里另写一份开文档逻辑。
  assert.match(
    listSource,
    /onOpenFulltext=\{\(attachmentId\) =>\s*act\.openLiteratureAttachment\(item\.id, attachmentId\)/
  )

  // 复选框与展开附件这两个自管点击的单元格, 也要挡住双击冒泡到整行。
  const stopped =
    listSource.match(/onDoubleClick=\{\(event\) => event\.stopPropagation\(\)\}/g) ?? []
  assert.equal(stopped.length, 2)
})

test('the paperclip column sorts like every other column and stays a fixed leading column', () => {
  // 曲别针列复用普通列那一条排序切换: 同列再点反转、写 SORT_STORAGE_KEY、
  // 交给 catalogue.query。表头里不允许再抄一份 localStorage + query 逻辑。
  assert.match(
    listSource,
    /const applySort = \(sort: NonNullable<LiteratureQuery\['sort'\]>\): void => \{\s*const order = query\.sort === sort && query\.order === 'asc' \? 'desc' : 'asc'\s*localStorage\.setItem\(SORT_STORAGE_KEY, JSON\.stringify\(\{ sort, order \}\)\)\s*catalogue\.query\(\{ sort, order \}\)\s*\}/
  )
  // 两个入口: 曲别针按钮 + 普通列表头。定义处不算调用。
  assert.equal(listSource.match(/applySort\(/g)?.length, 2)
  // 普通列表头只剩取键与判空, 反转/持久化/查询都交给 applySort。
  assert.match(
    listSource,
    /COLUMN_META\[column\.key\]\.sort \? \([\s\S]*?onClick=\{\(\) => applySort\(COLUMN_META\[column\.key\]\.sort!\)\}/
  )

  // 排序键与后端 ATTACHMENT_SORT_KEY 同名; 它经契约类型进入查询, 不在此处拼字符串。
  assert.match(
    listSource,
    /const ATTACHMENT_SORT: NonNullable<LiteratureQuery\['sort'\]> = 'attachment'/
  )
  const contractSource = readFileSync(
    new URL('../../contracts/literature.ts', import.meta.url),
    'utf8'
  )
  assert.match(contractSource, /export type LiteratureSort\s*=\s*\|?\s*'attachment'\s*\|/)

  // 表头只有曲别针, 不显示升降状态; 单元格仍是展开附件的那个 chevron, 不被换掉。
  assert.match(listSource, /icon=\{<Icon name="clip" size=\{13\} \/>\}/)
  assert.match(listSource, /name=\{expanded \? 'chevron-down' : 'chevron-right'\}/)

  // 这一列固定常驻标题前: 不进 COLUMN_META, 因此不能被隐藏、拖动或改宽。
  assert.doesNotMatch(listSource, /attachment: \{ labelKey: 'columns\./)

  assert.equal(engine.getFixedT('zh', 'literature')('list.sortByAttachment'), '按附件排序')
  assert.equal(engine.getFixedT('en', 'literature')('list.sortByAttachment'), 'Sort by attachment')
})
