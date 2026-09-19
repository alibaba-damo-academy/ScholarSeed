import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const detailSource = readFileSync(
  new URL('./LiteratureDetail.tsx', import.meta.url),
  'utf8'
)
const literatureStyles = readFileSync(
  new URL('./literature.css', import.meta.url),
  'utf8'
)

test('attachment icon buttons do not forward unsupported tooltip attributes', () => {
  const iconButtons = detailSource.match(/<IconButton\b[\s\S]*?(?=\sicon=)/g) ?? []
  assert.ok(iconButtons.length > 0)
  for (const iconButton of iconButtons) {
    assert.doesNotMatch(iconButton, /\btooltip(?:\s|=)/)
  }
})

test('attachment double click opens only available files and excludes action buttons', () => {
  assert.match(detailSource, /onDoubleClick=\{isAttachmentAvailable\(candidate\)\s*\? \(\) => act\.openLiteratureAttachment\(item\.id, candidate\.id\)\s*: undefined\}/)
  assert.match(detailSource, /className="lit-row-actions[^"]*"[\s\S]*?onDoubleClick=\{\(event\) => event\.stopPropagation\(\)\}/)
  const listSource = readFileSync(new URL('./LiteratureList.tsx', import.meta.url), 'utf8')
  assert.match(listSource, /onDoubleClick=\{isAttachmentAvailable\(attachment\)\s*\? \(\) => act\.openLiteratureAttachment\(item\.id, attachment\.id\)\s*: undefined\}/)
  assert.match(listSource, /onClick=\{\(\) =>\s*catalogue\.focusAttachment\(item\.id, attachment\.id\)/)
})

test('attachment selection supports multiple files while primary PDF stays single', () => {
  const attachmentInput = detailSource.match(/<Input\s+ref=\{attachmentInput\}[\s\S]*?\/>/)?.[0]
  const primaryInput = detailSource.match(/<Input\s+ref=\{primaryInput\}[\s\S]*?\/>/)?.[0]
  assert.ok(attachmentInput)
  assert.ok(primaryInput)
  assert.match(attachmentInput, /\bmultiple\b/)
  assert.match(attachmentInput, /Array\.from\(event\.target\.files \?\? \[\]\)/)
  assert.match(attachmentInput, /upload\(files, false\)/)
  assert.doesNotMatch(primaryInput, /\bmultiple\b/)
  assert.match(primaryInput, /upload\(\[file\], true\)/)
})

test('literature detail exposes only information and notes tabs', () => {
  for (const tab of ['info', 'notes']) {
    assert.match(detailSource, new RegExp(`${tab}: '${tab}'`))
    assert.match(detailSource, new RegExp(`value=\\{DETAIL_TAB\\.${tab}\\}`))
  }

  assert.doesNotMatch(detailSource, /attachments: 'attachments'/)
  assert.doesNotMatch(detailSource, /marks: 'marks'/)
})

test('basic information preserves attachment management and identity', () => {
  assert.match(
    detailSource,
    /value=\{DETAIL_TAB\.info\}[\s\S]*data-testid="literature-detail-attachments"/
  )
  assert.match(detailSource, /data-testid="literature-detail-attachments"/)
  assert.match(detailSource, /item\.attachments\.map\(\(candidate\) =>/)
  assert.match(
    detailSource,
    /act\.openLiteratureAttachment\(item\.id, candidate\.id\)/
  )
  assert.match(detailSource, /catalogue\.focusAttachment\(item\.id, candidate\.id\)/)
  assert.doesNotMatch(detailSource, /data-testid="literature-detail-marks"/)
})

test('attachment marks show source framing only when comments exist', () => {
  assert.match(detailSource, /const hasComments = markComments\.length > 0/)
  assert.match(
    detailSource,
    /\{hasComments \? <span className="lit-attachment-mark-label">\{literature\('attachment\.sourceLabel'\)\}<\/span> : null\}/
  )
  assert.match(
    detailSource,
    /lit-attachment-mark-text\$\{hasComments \? ' is-source' : ''\}/
  )
  assert.match(literatureStyles, /\.lit-attachment-mark-text\.is-source\s*\{[\s\S]*border-left:/)
})

test('two-tab labels are localized in Chinese and English', () => {
  for (const language of ['zh', 'en']) {
    const resources = JSON.parse(
      readFileSync(
        new URL(
          `../../../../localization/locales/${language}/literature.json`,
          import.meta.url
        ),
        'utf8'
      )
    ) as {
      detail: {
        noAttachments: string
        tabs: Record<string, string>
      }
    }

    assert.deepEqual(Object.keys(resources.detail.tabs).sort(), ['info', 'notes'])
    assert.ok(resources.detail.noAttachments)
  }
})

test('metadata sync is offered for sparse records and confirms title matches', () => {
  // 稀疏判据、维度优先级与确认策略都在 metadata.ts 里, 页面不重算一遍。
  assert.match(detailSource, /needsMetadataSync\(item\)/)
  assert.match(detailSource, /selectPaperMetaQuery\(item\)/)
  assert.match(detailSource, /requiresConfirmation\(query\.dimension\)/)
  assert.match(detailSource, /classifyPaperMetaFailure\(/)
  assert.match(detailSource, /data-testid="literature-sync-banner"/)
  assert.match(detailSource, /data-testid="literature-sync-match"/)

  // 三类结果各走各的提示: 成功 / 配额用尽 / 其余失败与无结果。
  for (const key of ['succeeded', 'quotaFailed', 'failed']) {
    assert.match(detailSource, new RegExp(`detail\\.sync\\.${key}`))
  }

  // 确认后写回文献并刷新详情与列表; 待确认项在失败时保留, 不逼用户重跑检索。
  assert.match(
    detailSource,
    /updateLiterature\(id, \{ fields: paperMetaFields\(record\) \}, projectId\)/
  )
  assert.match(detailSource, /catalogue\.reload\(\)/)
})

test('metadata sync copy is localized and keeps the agreed wording', () => {
  const expected: Record<string, string> = {
    action: '同步元数据',
    succeeded: '同步元数据成功',
    failed: '同步元数据失败',
    quotaFailed: '同步元数据失败，接口配额已用尽'
  }
  for (const language of ['zh', 'en']) {
    const resources = JSON.parse(
      readFileSync(
        new URL(
          `../../../../localization/locales/${language}/literature.json`,
          import.meta.url
        ),
        'utf8'
      )
    ) as { detail: { sync: Record<string, string> } }
    const sync = resources.detail.sync

    assert.deepEqual(
      Object.keys(sync).sort(),
      [
        'action', 'bannerTitle', 'byArxiv', 'byDoi', 'byTitle', 'confirm',
        'confirmDescription', 'confirmTitle', 'failed', 'quotaFailed', 'succeeded'
      ]
    )
    assert.ok(Object.values(sync).every((value) => value.length > 0))
    if (language === 'zh') {
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(sync[key], value)
      }
    }
  }
})
