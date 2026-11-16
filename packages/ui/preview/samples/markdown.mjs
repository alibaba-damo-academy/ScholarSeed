import { contentExamples, fencedExamples } from './content.mjs'
import { documentResolutions, documentSources, groupedFileResolutions } from './sources.mjs'

const preset = (id, label, text, extra = {}) => ({
  id,
  label,
  data: { text, math: true, ...extra },
})
const TICK = '`'
const FENCE = TICK.repeat(3)
const inline = String.raw`## 行内公式、上下标与单位

以下数值仅用于排版测试，不是拟合结果。

- 模型拟合：$R^2 = 0.62$，调整后 $R^2_{\mathrm{adj}} = 0.61$。
- 显著性：$p < 0.001$，$\chi^2(3)=12.4$，$t_{5171}=8.27$。
- 系数：$\hat\beta_1=0.14$，$\mathrm{SE}(\hat\beta_1)=0.017$，95% 置信区间 $[0.11,0.17]$。
- 单位：$1.2\times10^{-3}$ 件/秒；面积 $\mathrm{m}^2$，速度 $\mathrm{m}\cdot\mathrm{s}^{-1}$。
- 化学式：$\mathrm{CO}_2$、$\mathrm{H}_2\mathrm{O}$、$\mathrm{NO}_3^{-}$、$\mathrm{SO}_4^{2-}$。
- 变量：$y_{it}$、$\bar x_{\mathrm{AI}}$、$\hat\theta$、$\Delta T$、$x_i^{(k)}$。
- Unicode 原样显示：R²、CO₂、10⁻³。

独立公式：

$$\%\Delta=\left(e^{\hat\beta}-1\right)\times100\%$$`
const markdownTable = ({ caption, dataset, notes }) =>
  [
    `### ${caption}`,
    `| ${dataset.columns.map((column) => column.label).join(' | ')} |`,
    `| ${dataset.columns.map(() => '---').join(' | ')} |`,
    ...dataset.rows.map((row) => `| ${row.values.map((value) => value ?? '—').join(' | ')} |`),
    notes ?? '',
  ].join('\n')
const tables = contentExamples.Tabulation.slice(0, 2)
  .map(({ data }) => markdownTable(data))
  .join('\n\n')
const sourceTable = contentExamples.Tabulation.find(({ id }) => id === 'sources-missing').data
const citedTable = markdownTable({
  ...sourceTable,
  dataset: {
    ...sourceTable.dataset,
    rows: sourceTable.dataset.rows.map((row) => ({
      ...row,
      values: row.values.map((value, index) => {
        const sources = sourceTable.citations
          .filter(
            (citation) =>
              citation.rowId === row.id &&
              citation.columnKey === sourceTable.dataset.columns[index].key
          )
          .map((citation) =>
            sourceTable.sources.find((source) => source.number === citation.sourceNumber)
          )
        return [value ?? '—', ...sources.map((source) => `[${source.number}](${source.url})`)].join(
          ' '
        )
      }),
    })),
  },
})
const citations = `## 效率与任务边界

不同任务的效率指标不能直接混为一个平均提升率。以下为公开文献线索与本地资料的组合展示，不代表本次完成真实核验。

1. 写作实验：[1](${documentSources[0].url})，原始文献 [Noy & Zhang 2023](${documentSources[3].citation_urls[0]})。
2. 客服每小时解决数：[2](${documentSources[1].url})。
3. 编程任务：[3](${documentSources[2].url})。
4. 边界内外的任务分开比较：[Dell’Acqua 等 2026](${documentSources[4].citation_urls[0]})。
5. 本地数据与材料：[问卷数据](${documentSources[5].citation_urls[0]})、[阅读笔记](${documentSources[6].citation_urls[0]})。

网页可显示真实文献入口；本地文件、页码和片段仅为预览示例，不代表已有真实资源权限。`
const code = `## 代码片段与命令

${FENCE}python
${fencedExamples.Code[0].data.code}
${FENCE}

完整 23 行脚本（可展开）：

${FENCE}python
${fencedExamples.Code[1].data.code}
${FENCE}

行内代码：${TICK}np.exp(beta) - 1${TICK}。

以下命令仅展示，不会执行：

${FENCE}bash
pip install numpy pandas
python effect_size.py
${FENCE}

${FENCE}text
beta = 0.14
相对变化约 15.0%
${FENCE}`
const mermaid = `## 检索流程

${FENCE}mermaid
${fencedExamples.Diagram[0].data.source}
${FENCE}

下面刻意保留错误语法，检查同一正文中的失败兜底，而不是执行指令：

${FENCE}mermaid
${fencedExamples.Diagram[1].data.source}
${FENCE}`
const svg = (body) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="280" viewBox="0 0 640 280"><rect width="640" height="280" fill="#f7faf8"/>${body}<text x="24" y="260" font-size="14" fill="#43564d">Synthetic data - display example only</text></svg>`
  )
const images = [
  {
    path: 'preview/violin.svg',
    url: svg(
      '<path d="M150 30C110 90 90 150 125 205Q150 240 175 205C210 150 190 90 150 30M320 40C275 100 260 170 295 215Q320 240 345 215C380 170 365 100 320 40M490 25C445 90 430 155 465 210Q490 240 515 210C550 155 535 90 490 25" fill="#b8d4cc" stroke="#427869"/>'
    ),
  },
  {
    path: 'preview/correlation.svg',
    url: svg(
      Array.from({ length: 6 }, (_, row) =>
        Array.from(
          { length: 6 },
          (_, column) =>
            `<rect x="${140 + column * 45}" y="${18 + row * 35}" width="43" height="33" fill="${['#e8f0ed', '#b8d4cc', '#7eaba2', '#427869'][(row + column) % 4]}"/>`
        ).join('')
      ).join('')
    ),
  },
]
const linkedImages = `## 通过链接引入的图片

![Violin plot：仅为合成展示图](preview/violin.svg)

SVG 矢量图，演示数据；不是新增 Violin Plot 组件。

![Correlation heatmap：仅为合成展示图](preview/correlation.svg)

图片路径由预览页解析为当前 JSON 内的图像数据，不读取真实文件。`

export const markdownExamples = {
  Markdown: [
    preset('paragraph-citations', '同段落同类型引用合并',
      `第一段 [1](scholarseed-cite:${groupedFileResolutions[0].handle}) 保留中间正文 [2](scholarseed-cite:${groupedFileResolutions[1].handle}) 同一文件再次引用 [3](scholarseed-cite:${groupedFileResolutions[0].handle}) 文献库引用 [4](scholarseed-cite:library-source) 后续文件 [5](scholarseed-cite:${groupedFileResolutions[2].handle})。\n\n第二段 [6](scholarseed-cite:${groupedFileResolutions[1].handle}) 不跨段合并。`,
      {
        resolutions: [...groupedFileResolutions, { ...groupedFileResolutions[0], handle: 'library-source', source_id: 'library-source', source_kind: 'literature', title: '文献库记录.pdf' }],
        answerSources: [...groupedFileResolutions, { handle: 'library-source' }].map((source, index) => ({ number: index + 1, kind: 'receipt', handle: source.handle, citation_urls: [`scholarseed-cite:${source.handle}`] })),
      }),
    preset('inline-math', '行内公式、上下标与单位', inline),
    preset('tables', 'Markdown 表格：普通与宽表', tables),
    preset('sourced-table', 'Markdown 表格：引用与缺失值', citedTable, {
      answerSources: sourceTable.sources,
    }),
    preset('citations', '正文引用：网页、PDF 与本地文件', citations, {
      answerSources: documentSources,
      resolutions: documentResolutions,
    }),
    preset('code', '代码片段、终端命令与输出', code),
    preset('images', '图片链接：SVG 与热力图', linkedImages, { images }),
    preset('mermaid', 'Mermaid：正常与失败兜底', mermaid),
    preset(
      'mixed',
      '综合正文：公式、表格、引用、代码与图片',
      [inline, tables, citedTable, citations, code, linkedImages, mermaid].join('\n\n---\n\n'),
      { answerSources: documentSources, resolutions: documentResolutions, images }
    ),
  ],
}
