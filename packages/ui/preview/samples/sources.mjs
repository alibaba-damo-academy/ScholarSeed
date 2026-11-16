import { contracts } from '../catalog.mjs'
import { generate } from '../schema.mjs'
import { rules } from '../rules.mjs'
import { productivitySources } from './studies.mjs'

const base = generate(contracts.CitationSources.schema, 'answer-sources', rules, 'normal')
const source = {
  number: 1,
  kind: 'searched',
  title: '合成研究网页',
  url: 'https://example.org/research',
  site: 'example.org',
}
const local = {
  ...base.resolution,
  source_kind: 'file',
  handle: 'sample-notes',
  source_id: 'sample-notes',
  title: '阅读笔记.md',
  path: 'preview/阅读笔记.md',
  presentation: {
    ...base.resolution.presentation,
    text: '合成摘录：不同任务的效率指标不能直接混合比较，仅用于展示引用样式。',
  },
}
delete local.bibliography
local.can_open_pdf = false
const literature = {
  ...local,
  source_kind: 'literature',
  handle: 'sample-paper',
  source_id: 'sample-paper',
  title: '任务边界与效率（合成文献）.pdf',
  path: 'preview/sample-paper.pdf',
  pages: [{ page: 3, quads: [] }],
  can_open_pdf: true,
  bibliography: {
    version: 1,
    title: '任务边界与效率（合成文献）',
    authors: '示例作者',
    year: '2026',
    publication: '合成出版来源',
    url: 'https://example.org/sample-paper',
    doi: '',
  },
}
const receipt = (number, resolution) => ({
  number,
  kind: 'receipt',
  handle: resolution.handle,
  citation_urls: [],
})

const repeatedPdf = [
  [3, '合成摘录：研究先区分了任务类型，再比较完成时间。'],
  [4, '合成摘录：不同任务的完成率应分别报告。'],
  [5, '合成摘录：效率指标与质量指标应结合解读。'],
].map(([page, text]) => ({
  ...literature,
  handle: `sample-paper-page-${page}`,
  pages: [{ page, quads: [] }],
  presentation: { ...literature.presentation, text },
}))

const sourceDocuments = [
  {
    ...literature,
    handle: 'noy-writing',
    source_id: 'noy-writing',
    title: 'Noy & Zhang 2023.pdf',
    path: 'preview/Noy & Zhang 2023.pdf',
    pages: [{ page: 1, quads: [] }],
    presentation: {
      ...literature.presentation,
      text: '研究摘要报告写作任务用时与质量评分的变化。这里仅展示来源元数据，不代表已上传或核验全文。',
    },
    bibliography: {
      version: 1,
      title:
        'Experimental evidence on the productivity effects of generative artificial intelligence',
      authors: 'Shakked Noy; Whitney Zhang',
      year: '2023',
      publication: 'Science',
      url: productivitySources[0].url,
      doi: '10.1126/science.adh2586',
    },
  },
  {
    ...literature,
    handle: 'jagged-frontier',
    source_id: 'jagged-frontier',
    title: 'Dell’Acqua 等：技术边界.pdf',
    path: 'preview/jagged-frontier.pdf',
    pages: [
      { page: 3, quads: [] },
      { page: 5, quads: [] },
      { page: 12, quads: [] },
    ],
    presentation: {
      ...literature.presentation,
      text: '边界内外的任务应分别分析。页码来自需求截图的演示定位，预览未加载 PDF，不能视为真实页级核验。',
    },
    bibliography: {
      version: 1,
      title:
        'Navigating the Jagged Technological Frontier: Field Experimental Evidence of the Effects of Artificial Intelligence on Knowledge Worker Productivity and Quality',
      authors: 'Fabrizio Dell’Acqua 等',
      year: '2026',
      publication: 'Harvard Business School · 2026 修订稿',
      url: 'https://www.hbs.edu/ris/Publication%20Files/dell-acqua-et-al-2026-navigating-the-jagged-technological-frontier_5c589c8c-fbb5-458f-b285-c944746cd717.pdf',
      doi: '',
    },
  },
  {
    ...local,
    handle: 'survey-sheet',
    source_id: 'survey-sheet',
    title: '问卷数据-2026秋.xlsx',
    path: 'preview/问卷数据-2026秋.xlsx',
    presentation: {
      ...local.presentation,
      text: '截图演示值：自评写报告用时平均下降 31%（n=186）。仅为需求样例，不是本次真实调查结果；当前协议没有 Sheet1 / B2:B187 的结构化定位字段。',
    },
  },
  {
    ...local,
    handle: 'research-notes',
    source_id: 'research-notes',
    title: '阅读笔记.md',
    path: 'preview/阅读笔记.md',
    presentation: {
      ...local.presentation,
      text: '阅读笔记示例：能力边界内、外的任务要分开统计，不混合比较平均值。当前以文件路径和片段展示，不伪造精确行号。',
    },
  },
]
export const documentResolutions = sourceDocuments.map((resolution) => ({
  ...resolution,
  quote: resolution.presentation.text,
  revision: 'preview-source-v1',
  project_id: 'preview-literature',
}))
export const documentSources = [
  ...productivitySources,
  ...documentResolutions.map((resolution, index) => ({
    ...receipt(index + 4, resolution),
    citation_urls: [`scholarseed-cite:preview/${resolution.handle}`],
  })),
]
const realSources = documentResolutions.map((resolution, index) => ({
  id: `document-${resolution.handle}`,
  label: ['Science：写作研究 PDF', 'HBS：多页文献来源', 'Excel：问卷数据', 'Markdown：研究笔记'][
    index
  ],
  data: {
    resolution,
    children: ['Noy & Zhang 2023', 'Dell’Acqua 等 2026', '问卷数据-2026秋', '研究阅读笔记'][index],
  },
}))
const webStudies = [
  {
    number: 1,
    kind: 'searched',
    title: 'HBS：锯齿状技术边界',
    site: 'hbs.edu',
    url: documentResolutions[1].bibliography.url,
  },
  {
    number: 2,
    kind: 'searched',
    title: 'NBER：Generative AI at Work',
    site: 'nber.org',
    url: 'https://www.nber.org/papers/w31161',
  },
  ...productivitySources,
].map((source, index) => ({
  id: `study-${index}`,
  label: source.title,
  data: { source, named: true },
}))

export const groupedFileResolutions = [local, ...['研究记录.md', '分析结果.md'].map((title, index) => ({
  ...local, handle: `group-file-${index}`, source_id: `group-file-${index}`,
  path: `preview/${title}`, title,
  presentation: { ...local.presentation, text: `${title}：合成引用内容，仅用于组件交互预览。` },
}))]

export const sourceExamples = {
  CitationLink: [
    {
      id: 'multiple-files',
      label: '同类型多个文件',
      data: { resolutions: groupedFileResolutions },
    },
    ...webStudies,
    ...realSources,
    { id: 'web', label: '网页来源', data: { source, named: true } },
    {
      id: 'multiple-web',
      label: '多个网页',
      data: {
        source,
        additionalSources: [
          { ...source, number: 2, title: '合成数据网页', url: 'https://example.net/data', site: 'example.net' },
          { ...source, number: 3, title: '合成方法网页', url: 'https://example.com/methods', site: 'example.com' },
        ],
      },
    },
    {
      id: 'paper',
      label: '文献来源',
      data: { resolutions: repeatedPdf },
    },
    {
      id: 'local',
      label: '文件来源',
      data: { resolution: local, children: '阅读笔记' },
    },
    ...[
      ['resource', '资料库来源', 'resource', local],
      ['attachment', '会话附件来源', 'attachment', local],
      ['selection', '文件选区来源', 'selection', local],
      ['managed-fulltext', '受管全文来源', 'managed_fulltext', literature],
      ['unknown-source', '未知来源', 'unregistered', local],
    ].map(([id, label, kind, original]) => ({
      id, label,
      data: { resolution: { ...original, source_kind: kind, handle: `sample-${id}`, source_id: `sample-${id}` }, children: original.title },
    })),
    {
      id: 'long',
      label: '长文件名与长引用',
      data: {
        resolution: {
          ...local,
          title: '用于展示长文件名换行的研究阅读笔记与不同任务边界比较.md',
          presentation: {
            ...local.presentation,
            text: local.presentation.text.repeat(30),
          },
        },
        children: '长文件名的研究阅读笔记',
      },
    },
  ],
  CitationSources: [
    {
      id: 'repeated-pdf',
      label: '同一 PDF 多处引用',
      data: {
        resolution: repeatedPdf[0],
        resolutions: repeatedPdf,
        answerSources: repeatedPdf.map((resolution, index) => receipt(index + 1, resolution)),
      },
    },
    {
      id: 'document-mixed',
      label: '研究对照：网页、PDF 与本地文件',
      data: {
        resolution: documentResolutions[0],
        resolutions: documentResolutions,
        answerSources: documentSources,
      },
    },
    {
      id: 'mixed',
      label: '网页、文献与本地文件',
      data: {
        ...base,
        resolution: literature,
        resolutions: [literature, local],
        answerSources: [
          source,
          receipt(2, literature),
          receipt(3, local),
          { ...source, number: 4, title: '合成标准网页', url: 'https://example.org/standard' },
        ],
      },
    },
    {
      id: 'files',
      label: '文件来源',
      data: {
        ...base,
        resolution: literature,
        resolutions: [literature, local],
        answerSources: [receipt(1, literature), receipt(2, local)],
      },
    },
    {
      id: 'repeated-source',
      label: '同一来源的多处引用',
      data: {
        ...base,
        answerSources: [
          {
            ...source,
            number: 1,
            title: '研究来源',
            url: 'https://example.org/research',
            site: 'example.org',
          },
          {
            ...source,
            number: 2,
            title: '研究来源',
            url: 'https://example.org/research',
            site: 'example.org',
          },
          {
            ...source,
            number: 3,
            title: '补充来源',
            url: 'https://example.org/other',
            site: 'example.org',
          },
        ],
      },
    },
  ],
}
