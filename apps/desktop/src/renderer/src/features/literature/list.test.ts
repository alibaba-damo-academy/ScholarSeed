import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createInstance } from 'i18next'

import { timestampLabel } from './projection.ts'

const listSource = readFileSync(new URL('./LiteratureList.tsx', import.meta.url), 'utf8')
const engine = createInstance()
await engine.init({
  fallbackLng: false,
  lng: 'zh',
  resources: {
    en: { literature: JSON.parse(readFileSync(new URL('../../../../localization/locales/en/literature.json', import.meta.url), 'utf8')) },
    zh: { literature: JSON.parse(readFileSync(new URL('../../../../localization/locales/zh/literature.json', import.meta.url), 'utf8')) }
  }
})
const moment = new Date(2026, 8, 15, 15, 46, 32)
// 与 localization/format.ts 的 createFormatters 同形, 但保留显式 locale 以便逐语言断言。
const formatters = (locale: string) => ({
    date: (value: Date | number, options?: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, options).format(value),
    relative: (value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions) => new Intl.RelativeTimeFormat(locale, options).format(value, unit),
    number: (value: number) => String(value)
})

test('literature timestamps are shown down to the second', () => {
    assert.equal(timestampLabel(moment.toISOString(), formatters('zh-CN')), '2026/9/15 15:46:32')
    assert.equal(
        timestampLabel(moment.toISOString(), formatters('en-US')),
        new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'medium' }).format(moment)
    )
    assert.equal(timestampLabel('not a timestamp', formatters('zh-CN')), '')
})

test('the time columns keep room for a timestamp that carries seconds', () => {
    for (const key of ['created_at', 'updated_at']) {
        assert.match(
            listSource,
            new RegExp(`${key}: \\{\\s*labelKey: 'columns\\.${key}',\\s*sort: '${key}',\\s*minimum: 160\\s*\\}`)
        )
    }
    assert.match(listSource, /width: Math\.max\(COLUMN_META\[entry\.key\]\.minimum, entry\.width\)/)
    assert.doesNotMatch(listSource, /Intl\.DateTimeFormat/)
})

test('chip columns let the cell do the clipping so truncation stays detectable', () => {
    // 芯片自己压缩并内部省略时单元格永不溢出, tooltip 便无从判定, 因此必须保持自然宽度。
    assert.match(listSource, /const CHIP_CLASS = 'shrink-0 max-w-none'/)
    // 遗留的 .lit-row-projects 胶囊样式会覆盖设计系统徽标并让它自我省略。
    assert.doesNotMatch(listSource, /lit-row-projects/)
    assert.doesNotMatch(readFileSync(new URL('./literature.css', import.meta.url), 'utf8'), /lit-row-projects/)
})

test('the projects column shows only the first project and folds the rest into a +N chip', () => {
  // 一篇文献可归属多个项目: 全览列只画第一个, 其余折叠成计数芯片, 避免行高与列宽被项目数撑爆。
  assert.doesNotMatch(listSource, /item\.projects\.map\(/)
  assert.match(listSource, /<Badge\s+className=\{CHIP_CLASS\}\s+tone="brand"\s*>\s*\{item\.projects\[0\]\.name\}\s*<\/Badge>/)
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
  assert.equal(engine.getFixedT('zh', 'literature')('batch.exportSucceeded', { count: 3 }), '成功导出 3 条文献')
  assert.equal(engine.getFixedT('en', 'literature')('batch.exportSucceeded', { count: 1 }), 'Exported 1 literature item')
  assert.equal(engine.getFixedT('en', 'literature')('batch.exportSucceeded', { count: 2 }), 'Exported 2 literature items')
  // 条数取后端实际写入的 count, 请求 id 只在响应缺字段时兜底。
  assert.match(listSource, /const exported = result\.count \?\? ids\.length/)
  assert.match(listSource, /toast\(\{\s*title: literature\('batch\.exportSucceeded', \{ count: exported \}\),\s*tone: 'success'\s*\}\)/)
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
  assert.doesNotMatch(listSource, /onDoubleClick=\{onOpen\}/)

  // 单击仍然是打开详情, 两个手势不被混成一件事。
  assert.match(listSource, /onClick=\{onOpen\}/)
  assert.match(listSource, /catalogue\.focus\(item\.id\)/)

  // 打开动作复用 store 既有的那一条, 不在列表里另写一份开文档逻辑。
  assert.match(
    listSource,
    /onOpenFulltext=\{\(attachmentId\) =>\s*act\.openLiteratureAttachment\(item\.id, attachmentId\)/
  )

  // 复选框与展开附件这两个自管点击的单元格, 也要挡住双击冒泡到整行。
  const stopped = listSource.match(/onDoubleClick=\{\(event\) => event\.stopPropagation\(\)\}/g) ?? []
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
    /onClick=\{\(\) => \{\s*const sort = COLUMN_META\[column\.key\]\.sort\s*if \(!sort\) return\s*applySort\(sort\)\s*\}\}/
  )

  // 排序键与后端 ATTACHMENT_SORT_KEY 同名; 它经契约类型进入查询, 不在此处拼字符串。
  assert.match(
    listSource,
    /const ATTACHMENT_SORT: NonNullable<LiteratureQuery\['sort'\]> = 'attachment'/
  )
  const contractSource = readFileSync(new URL('../../contracts/literature.ts', import.meta.url), 'utf8')
  assert.match(contractSource, /export type LiteratureSort = 'attachment' \|/)

  // 表头只有曲别针, 不显示升降状态; 单元格仍是展开附件的那个 chevron, 不被换掉。
  assert.match(listSource, /icon=\{<Icon name="clip" size=\{13\} \/>\}/)
  assert.match(listSource, /name=\{expanded \? 'chevron-down' : 'chevron-right'\}/)

  // 这一列固定常驻标题前: 不进 COLUMN_META, 因此不能被隐藏、拖动或改宽。
  assert.doesNotMatch(listSource, /attachment: \{ labelKey: 'columns\./)

  assert.equal(engine.getFixedT('zh', 'literature')('list.sortByAttachment'), '按附件排序')
  assert.equal(engine.getFixedT('en', 'literature')('list.sortByAttachment'), 'Sort by attachment')
})
