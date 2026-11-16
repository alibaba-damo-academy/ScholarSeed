import { contracts } from '../catalog.mjs'
import { generate } from '../schema.mjs'
import { rules } from '../rules.mjs'

const base = generate(contracts.ArtifactGroup.schema, 'artifact-presets', rules, 'normal')
const sample = Object.fromEntries(
  Object.entries(base.items[0]).filter(([key]) => key !== 'image_url')
)
const image = (index) => ({
  ...sample,
  artifact_id: `image-${index}`,
  kind: 'image',
  name: `image-${index + 1}.svg`,
  path: `preview/image-${index + 1}.svg`,
  absolute_path: `/preview/image-${index + 1}.svg`,
  media_type: 'image/svg+xml',
  title: `示例图片 ${index + 1}`,
  image_url: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="#e5eee8"/><circle cx="240" cy="160" r="85" fill="#638878"/><text x="240" y="174" text-anchor="middle" font-size="42" fill="white">${index + 1}</text></svg>`)}`,
})
const file = (index) => ({
  ...sample,
  artifact_id: `file-${index}`,
  kind: index % 2 ? 'directory' : 'file',
  name: index % 2 ? `folder-${index + 1}` : `report-${index + 1}.md`,
  path: index % 2 ? `preview/folder-${index + 1}` : `preview/report-${index + 1}.md`,
  absolute_path: index % 2 ? `/preview/folder-${index + 1}` : `/preview/report-${index + 1}.md`,
  media_type: index % 2 ? '' : 'text/markdown',
  title: index % 2 ? `资料文件夹 ${index + 1}` : `研究文件 ${index + 1}`,
})
const preset = (id, label, items) => ({ id, label, data: { ...base, items } })
const pdfCover = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640"><rect width="480" height="640" fill="white"/><text x="40" y="90" font-size="28">研究报告 · PDF 首页</text><text x="40" y="150" font-size="18">合成预览封面，点击在工作台打开</text><path d="M40 200H440 M40 240H440 M40 280H440" stroke="#a3a3a3"/></svg>')}`
const formats = [
  ['md', '一页简报.md', 'text/markdown', '1.2 KB · Markdown'],
  ['tex', 'main.tex', 'application/x-tex', '86 行 · LaTeX 源码'],
  ['bib', 'references.bib', 'application/x-bibtex', '6 条引用 · BibTeX'],
  [
    'docx',
    '文献综述-初稿.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '约 2,300 字 · Word',
  ],
  ['pdf', '一页简报.pdf', 'application/pdf', '1 页 · 86 KB · PDF'],
  [
    'xlsx',
    '研究对照表.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '1 个工作表 · 4 行',
  ],
  ['csv', 'effect_sizes.csv', 'text/csv', '4 行 · 5 列 · CSV'],
  [
    'pptx',
    '组会汇报.pptx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '8 页 · 2.4 MB · PowerPoint',
  ],
  ['py', 'effect_size.py', 'text/x-python', '186 行 · Python'],
  ['lean', 'BasicProofs.lean', 'text/plain', 'Lean 源码 · 证明示例'],
  ['zip', '检索结果.zip', 'application/zip', '5 个文件 · 1.2 MB · ZIP'],
  ['parquet', 'embeddings.parquet', 'application/vnd.apache.parquet', '3.6 MB · Parquet'],
]
const fileBase = {
  ...generate(contracts.Artifact.schema, 'file-presets', rules, 'normal'),
  menuProps: {
    canSaveAs: true,
    canUsePath: true,
    downloading: false,
    canImport: true,
    revealLabel: '显示文件位置（模拟）',
  },
}
const sizes = {
  md: 1200,
  tex: 3400,
  bib: 1600,
  docx: 123000,
  pdf: 86000,
  xlsx: 4500,
  csv: 1200,
  pptx: 2400000,
  py: 8200,
  lean: 2200,
  zip: 1200000,
  parquet: 3600000,
}
const typed = formats.map(([id, name, mediaType, metadata]) => ({
  id,
  label: name,
  data: {
    ...fileBase,
    primary: {
      ...fileBase.primary,
      artifact_id: `format-${id}`,
      publication_id: 'preview-file-formats',
      name,
      title: name,
      path: `preview/${name}`,
      absolute_path: `/preview/${name}`,
      media_type: mediaType,
      size: sizes[id],
      updated_at: Date.UTC(2026, 10, 4) / 1000,
      status: 'available',
      role: 'final',
      change: 'add',
    },
    primaryMeta: metadata,
    canImport: true,
  },
}))
const state = (id, label, changes) => ({ id, label, data: { ...typed[0].data, ...changes } })

export const artifactExamples = {
  Artifact: [
    ...typed,
    state('import-disabled', '无导入权限', {
      canImport: false,
      primaryMeta: 'Markdown · 导入不可用（模拟权限）',
    }),
    state('downloading', '下载处理中', {
      menuProps: { ...fileBase.menuProps, downloading: true },
      primaryMeta: 'Markdown · 下载处理中（模拟状态）',
    }),
    state('deleted', '文件已删除', {
      primary: { ...typed[0].data.primary, status: 'deleted', change: 'delete' },
      canImport: false,
      menuProps: { ...fileBase.menuProps, canUsePath: false, canSaveAs: false },
      primaryMeta: '已删除 · 文件路径操作不可用',
    }),
    state('failed', '生成失败', {
      primary: { ...typed[0].data.primary, status: 'failed' },
      canImport: false,
      primaryMeta: '生成失败 · 仅状态样例，无真实文件',
    }),
  ],
  ArtifactGroup: [
    preset('pdf-images', 'PDF 与图片共用预览组', [
      image(0),
      {
        ...image(1),
        artifact_id: 'pdf-preview',
        kind: 'file',
        name: '研究报告.pdf',
        title: 'PDF 首页（示例）',
        path: 'preview/研究报告.pdf',
        absolute_path: '/preview/研究报告.pdf',
        media_type: 'application/pdf',
        image_url: pdfCover,
      },
      image(2),
    ]),
    ...[1, 2, 3, 4].map((count) =>
      preset(
        `images-${count}`,
        `${count} 张图片`,
        Array.from({ length: count }, (_, index) => image(index))
      )
    ),
    preset(
      'files-4',
      '4 个文件和文件夹',
      Array.from({ length: 4 }, (_, index) => file(index))
    ),
    preset(
      'files-5',
      '5 个文件和文件夹',
      Array.from({ length: 5 }, (_, index) => file(index))
    ),
    preset('mixed-blocks', '图片与文件混排', [image(0), image(1), file(0), file(1), image(2)]),
    preset(
      'formats',
      '12 种文件类型',
      typed.map(({ data }) => ({
        ...data.primary,
        kind: 'file',
        primaryMeta: data.primaryMeta,
        ...(data.primary.media_type === 'application/pdf' ? { image_url: pdfCover } : {}),
      }))
    ),
    preset(
      'images-10',
      '10 张图片：横向滚动',
      Array.from({ length: 10 }, (_, index) => image(index))
    ),
  ],
}
