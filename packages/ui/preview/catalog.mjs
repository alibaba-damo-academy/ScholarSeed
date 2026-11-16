import { schemas } from '../schemas.ts'
import {
  object,
  text,
  constant,
  choice,
  number,
  list,
  identifier,
  assertSchema,
  LIMITS,
} from './schema.mjs'

export const GROUPS = Object.freeze({
  content: '正文与富内容',
  charts: '图表',
  citations: '引用与证据',
  artifacts: '产物与工作台',
  foundations: '基础组件',
})

const GENERATED = '合成内容，仅用于交互预览，不代表真实研究结果。'
const initial = (value, ...values) => ({
  enum: [value, ...values],
  default: value,
})
const empty = () => list(text(), 0)
const yes = () => ({ type: 'boolean', default: true })
const no = () => ({ type: 'boolean', default: false })
const url = () => ({ type: 'string', maxLength: 2048, 'x-rule': 'url' })
const nullable = (schema) => ({ oneOf: [constant(null), schema] })
const source = (rule) => ({ type: 'string', maxLength: 65536, 'x-rule': rule })
const dataset = { ...schemas.dataset, 'x-rule': 'dataset' }
const chart = (kind, fixed = true) => ({
  ...schemas.chart,
  properties: {
    ...schemas.chart.properties,
    kind: fixed ? constant(kind) : schemas.chart.properties.kind,
  },
  'x-rule': 'chart',
  'x-kind': kind,
})
const artifact = object({
  artifact_id: identifier(),
  publication_id: identifier(),
  name: choice('report.md', 'measurements.csv', 'survey.pdf'),
  title: text('研究报告'),
  path: constant('preview/report.md'),
  absolute_path: constant('/preview/report.md'),
  media_type: constant('text/markdown'),
  size: number(0, Number.MAX_SAFE_INTEGER),
  sha256: constant('0'.repeat(64)),
  status: constant('available'),
  role: constant('final'),
  updated_at: number(1700000000, 1800000000),
  change: initial('add', 'update', 'delete'),
})
const groupArtifact = {
  ...artifact,
  properties: {
    ...artifact.properties,
    name: { type: 'string', minLength: 1, maxLength: 255 },
    path: { type: 'string', minLength: 1, maxLength: 1024 },
    absolute_path: { type: 'string', minLength: 1, maxLength: 1024 },
    media_type: { type: 'string', maxLength: 255 },
    kind: { enum: ['file', 'directory', 'image'] },
    image_url: { type: 'string', maxLength: 65536 },
    primaryMeta: text('文件信息'),
  },
}
const fileArtifact = {
  ...artifact,
  properties: {
    ...artifact.properties,
    name: groupArtifact.properties.name,
    path: groupArtifact.properties.path,
    absolute_path: groupArtifact.properties.absolute_path,
    media_type: groupArtifact.properties.media_type,
    status: initial('available', 'deleted', 'failed'),
    role: initial('final', 'intermediate', 'supporting'),
    change: initial('add', 'update', 'delete'),
  },
}
const web = object({
  number: number(1, 20),
  kind: constant('searched'),
  title: text('网页来源'),
  url: url(),
  site: { type: 'string', maxLength: 253 },
})
const resolution = object({
  handle: identifier(),
  pages: empty(),
  source_kind: { type: 'string', minLength: 1, maxLength: 80, default: 'file' },
  source_id: identifier(),
  content_level: constant('structured_text'),
  project_id: identifier(),
  path: constant('preview/notes.md'),
  title: text('原始资料'),
  revision: identifier(),
  quote: text('原文摘录'),
  version_bound: yes(),
  state: constant('source_only'),
  matches: empty(),
  presentation: object({
    version: constant(1),
    mode: constant('structured_text'),
    precision: constant('source'),
    text: text('合成原文'),
    quality_reasons: empty(),
    manual_check: yes(),
  }),
})
resolution.properties.bibliography = object({
  version: constant(1),
  title: text('文献标题'),
  authors: text('示例作者'),
  year: text('2026'),
  publication: text('合成出版来源'),
  url: url(),
  doi: { type: 'string', maxLength: 2048 },
})
resolution.properties.can_open_pdf = yes()
resolution.properties.path = text('preview/notes.md')
resolution.properties.pages = list(
  object({ page: number(1, 1000), quads: list(list(number()), 0) }),
  0
)
const receipt = object({
  number: number(1, 20),
  kind: constant('receipt'),
  handle: identifier(),
  citation_urls: empty(),
})
const paper = object({
  id: identifier(),
  title: text('候选文献'),
  authors: list(text('作者'), 2),
  year: number(2000, 2026),
  venue: text('合成出版来源'),
  doi: constant(null),
  url: url(),
  abstract: text('摘要'),
  reasons: list(text('纳入依据'), 2),
  tier: constant(null),
  citation_count: number(0, 1000),
  access: constant('unknown'),
  sources: empty(),
  decision: constant('candidate'),
  decision_reason: text('检索说明'),
  fulltext: constant('unknown'),
})
const search = {
  ...object({
    schema_version: constant('1.0'),
    run_id: identifier(),
    session_id: identifier(),
    round: number(1, 3),
    criteria: list(text('比较口径'), 2),
    status: initial(
      'success',
      'partial',
      'no_confident_match',
      'source_failed',
      'execution_blocked',
      'invalid_result'
    ),
    sources: empty(),
    candidates: number(),
    deduplicated: number(),
    retained: number(),
    papers: list(paper, 4),
    warnings: empty(),
    origin: constant('agentic-search'),
    report: object({}),
    metadata: object({}),
    selection: object({}),
    fulltext: object({}),
  }),
  'x-rule': 'search',
}
const review = {
  ...object({
    schema_version: constant('1.2'),
    session_id: identifier(),
    workspace: identifier(),
    checkpoint: initial('result', 'outline'),
    status: initial('generated', 'outline', 'partial', 'incomplete', 'failed'),
    section_count: number(0, LIMITS.rows),
    title: text('合成综述'),
    intent: text('研究目标'),
    scope: object({
      topic: nullable(text('主题')),
      time_range: text('资料范围'),
      focus: list(text('关注点'), 2),
      requested_materials: empty(),
      project_materials: number(0, 10),
      external_materials: number(1, 10),
    }),
    output: object({
      format: constant('markdown'),
      citation_style: constant('author_year'),
      decided_by: constant('user'),
    }),
    sections: list(
      object({
        id: identifier(),
        title: text('章节'),
        description: text('章节说明'),
        papers: number(0, 5),
        children: list(text('子主题'), 2),
        comparison_tables: list(text('对照表'), 1),
      }),
      2
    ),
    included: number(0, LIMITS.rows),
    fulltext: number(0, LIMITS.rows),
    abstract_only: number(0, LIMITS.rows),
    references: object({
      cited_count: nullable(number(0, LIMITS.rows)),
      fulltext_cited_count: nullable(number(0, LIMITS.rows)),
      abstract_cited_count: nullable(number(0, LIMITS.rows)),
      rows: list(object({
        citation_key: identifier(),
        paper_id: nullable(identifier()),
        citation: object({
          number: nullable(number(1, LIMITS.rows)),
          title: text('引文'),
          authors: text('作者'),
          year: number(2000, 2026),
          venue: text('来源'),
        }),
        evidence: nullable(object({
          basis: choice('fulltext', 'abstract', 'unknown'),
          reason: text('证据限制'),
          extracted_chars: nullable(number(0, 10000)),
        })),
        target: { oneOf: [
          constant(null),
          object({ kind: constant('library'), item_id: identifier() }),
          object({ kind: constant('web'), url: url() }),
        ] },
      }), 2),
    }),
    verification: object({
      issue_count: nullable(number(0, LIMITS.rows)),
      rows: list(object({
        check: object({
          id: identifier(),
          title: text('检查'),
          verdict: choice('PASS', 'WARN', 'FAIL', 'NOT_CHECKED', 'NOT_APPLICABLE'),
          reason: text('检查说明'),
        }),
        issue: nullable(object({
          title: text('核对问题'),
          detail: text('问题说明'),
          paper_ids: list(identifier(), 2),
          affected_content: text('涉及范围'),
          priority: nullable(choice('urgent', 'attention', 'low')),
        })),
      }), 3),
    }),
    warnings: empty(),
    source_hashes: object({}),
    artifacts: list(artifact, 1),
    generation_status: initial('SUCCESS', 'PARTIAL_SUCCESS', 'FAILED'),
  }),
  'x-rule': 'review',
}
const menu = object({
  canSaveAs: yes(),
  canUsePath: yes(),
  downloading: no(),
  canImport: yes(),
  revealLabel: text('显示位置'),
})
const contracts = {}
function register(name, label, group, schema, adapter = 'plain') {
  assertSchema(schema)
  contracts[name] = { label, group, schema, adapter, description: GENERATED }
}

for (const [name, label, kind, group = GROUPS.charts] of [
  ['Plot', '通用图表', 'bar', GROUPS.foundations],
  ['BarChart', '柱状图', 'bar'],
  ['GroupedBarChart', '分组柱状图', 'grouped-bar'],
  ['StackedBarChart', '堆叠柱状图', 'stacked-bar'],
  ['LineChart', '折线图', 'line'],
  ['ScatterChart', '散点图', 'scatter'],
  ['PieChart', '饼图', 'pie'],
  ['DonutChart', '环图', 'donut'],
  ['Histogram', '直方图', 'histogram'],
  ['BoxPlot', '箱线图', 'boxplot'],
  ['Heatmap', '热力图', 'heatmap'],
])
  register(
    name,
    label,
    group,
    object(
      {
        title: text(label),
        model: chart(kind, name !== 'Plot'),
        sources: list(text('合成数据来源'), 1),
        selected: empty(),
        notes: { ...text('图表口径与说明'), minLength: 0 },
      },
      ['title', 'model', 'sources', 'selected']
    ),
    'selection'
  )
contracts.Plot.previewGroup = GROUPS.charts
register(
  'DataTable',
  '交互数据表',
  GROUPS.foundations,
  object({ dataset, selected: empty() }),
  'selection'
)
register(
  'Markdown',
  '正文',
  GROUPS.content,
  object(
    {
      text: source('markdown'),
      math: yes(),
      answerSources: list({ oneOf: [web, receipt] }, 0),
      resolutions: list(resolution, 0),
      images: list(
        object({ path: text('图片路径'), url: { type: 'string', maxLength: 65536 } }),
        0
      ),
    },
    ['text', 'math']
  ),
  'markdown'
)
register(
  'Formula',
  '公式',
  GROUPS.content,
  object(
    {
      source: source('formula'),
      caption: { ...text('公式'), minLength: 0 },
      notes: { ...text('非数学核验'), minLength: 0 },
    },
    ['source']
  )
)
register(
  'Tabulation',
  '简表',
  GROUPS.content,
  {
    ...object(
      {
        caption: { ...text('表格说明'), minLength: 0 },
        dataset: { ...dataset, 'x-rule': 'tabulationDataset' },
        notes: { ...text('口径与缺失值说明'), minLength: 0 },
        sources: { ...list(web, 3), maxItems: 20 },
        citations: list(
          object({
            rowId: identifier(),
            columnKey: identifier(),
            sourceNumber: number(1, 20),
          }),
          1
        ),
      },
      ['dataset']
    ),
    'x-rule': 'tabulation',
  },
  'tabulation'
)

for (const [name, label, schema] of [
  ['Results', '科研结果', search],
  ['Details', '结果详情', search],
  ['Review', '科研综述', review],
]) {
  register(
    name,
    label,
    GROUPS.artifacts,
    object({ content: schema }),
    'research'
  )
}

register(
  'CitationLink',
  '引用标记',
  GROUPS.foundations,
  {
    oneOf: [object({ resolution, children: text('[1]') }), object({ source: web, named: yes() }), object({ resolutions: list(resolution, 3) }), object({ source: web, additionalSources: list(web, 2) })],
  },
  'citation'
)
register(
  'CitationSources',
  '引用来源',
  GROUPS.foundations,
  {
    ...object({
      answerSources: list({ oneOf: [web, receipt] }, 3),
      resolution,
    }),
    properties: {
      answerSources: list({ oneOf: [web, receipt] }, 3),
      resolution,
      resolutions: list(resolution, 3),
    },
  },
  'sources'
)

register(
  'Artifact',
  '文件产物',
  GROUPS.foundations,
  object({
    primary: fileArtifact,
    primaryMeta: text('版本说明'),
    canImport: yes(),
    menuProps: menu,
  }),
  'artifact'
)
register(
  'ArtifactGroup',
  '产物分组',
  GROUPS.artifacts,
  object({ items: list(groupArtifact, 3), canImport: yes(), menuProps: menu }),
  'artifacts'
)
register('FileMenuItems', '文件／产物操作菜单', GROUPS.foundations, menu, 'menu')
contracts.ArtifactMenuItems = {
  ...contracts.FileMenuItems,
  label: '产物操作菜单',
  aliasOf: 'FileMenuItems',
}
register(
  'ArtifactDestination',
  '产物保存目标',
  GROUPS.foundations,
  object({
    title: text('保存报告'),
    description: text('仅模拟，不写文件'),
    projectName: text('项目'),
    location: object({
      path: constant(''),
      name: choice('report.md', 'data.csv'),
    }),
    saving: no(),
    error: constant(''),
    tree: list(
      object({
        id: identifier(),
        name: text('目录'),
        path: constant('preview'),
      }),
      0
    ),
  }),
  'destination'
)
register(
  'FileFormatIcon',
  '文件格式',
  GROUPS.foundations,
  object({
    name: choice('preview.pdf', 'report.md', 'data.csv', 'model.py', 'result.xlsx'),
  })
)
contracts.ArtifactDestination.internal =
  'Host destination dialog; demonstrated through artifact actions.'
contracts.Details.internal = 'Host results workspace detail, not a standalone conversation entry.'
contracts.Results.sidebar = { name: 'Details' }
contracts.Review.sidebar = { name: 'Review', props: { detail: true } }
contracts.FileFormatIcon.internal =
  'Shared file icon; demonstrated inside artifact and citation cards.'
register(
  'Canvas',
  '画布',
  GROUPS.artifacts,
  object({
    title: text('交互画布'),
    document: object({
      format: initial('openui-lang', 'html'), version: constant(1),
      source: { type: 'string', default: 'root = Stack([Input("note", "输入备注")])' },
      initial_state: { type: 'object', default: {} },
      interaction: object({ actions: { type: 'array', items: { enum: ['rollback', 'cancel', 'submit'] }, default: ['rollback', 'cancel', 'submit'] }, output_schema: { type: 'object', default: { type: 'object' } } }),
    }, ['format', 'version', 'source']),
    status: initial('pending', 'resolved'),
  }),
  'canvas'
)
contracts.Canvas.sidebar = { name: 'Canvas', props: { full: true } }

export { contracts }
