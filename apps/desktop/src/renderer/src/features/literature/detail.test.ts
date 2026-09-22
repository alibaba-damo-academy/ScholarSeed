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
  assert.match(detailSource, /onDoubleClick=\{isAttachmentAvailable\(candidate\)[\s\S]*?\? \(\) => act\.openLiteratureAttachment\(item\.id, candidate\.id\)[\s\S]*?: undefined\}/)
  assert.match(detailSource, /className="lit-row-actions[^"]*"[\s\S]*?onDoubleClick=\{\(event\) => event\.stopPropagation\(\)\}/)
  const listSource = readFileSync(new URL('./LiteratureList.tsx', import.meta.url), 'utf8')
  assert.match(listSource, /onDoubleClick=\{\s*isAttachmentAvailable\(attachment\)[\s\S]*?\? \(\) =>[\s\S]*?act\.openLiteratureAttachment\([\s\S]*?item\.id,[\s\S]*?attachment\.id[\s\S]*?\)[\s\S]*?: undefined[\s\S]*?\}/)
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

test('literature detail exposes information, attachments and notes tabs', () => {
  for (const tab of ['info', 'attachments', 'notes']) {
    assert.match(detailSource, new RegExp(`${tab}: '${tab}'`))
    assert.match(detailSource, new RegExp(`value=\\{DETAIL_TAB\\.${tab}\\}`))
  }

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

test('three-tab labels are localized in Chinese and English', () => {
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

    assert.deepEqual(Object.keys(resources.detail.tabs).sort(), ['attachments', 'info', 'notes'])
    assert.ok(resources.detail.noAttachments)
  }
})

test('metadata sync is offered for every identifier and confirms title matches', () => {
  // 可用性判据、维度优先级与确认策略都在 metadata.ts 里, 页面不重算一遍。
  assert.match(detailSource, /selectPaperMetaQuery\(item\)/)
  assert.match(detailSource, /requiresConfirmation\(query\.dimension\)/)
  assert.match(detailSource, /classifyPaperMetaFailure\(/)
  // 横幅的标题与说明都按维度从 metadata.ts 取键, 页面不自己判断该显示哪句提示。
  assert.match(detailSource, /paperMetaTitleKey\(syncQuery\.dimension\)/)
  assert.match(detailSource, /paperMetaDescriptionKey\(syncQuery\.dimension\)/)
  // 同步横幅的稳定测试钩子: StatusCard 把 testId 落成 data-testid, 调用点给出具体值。
  assert.match(detailSource, /data-testid=\{testId\}/)
  assert.match(detailSource, /testId="literature-sync-banner"/)
  assert.match(detailSource, /data-testid="literature-sync-match"/)

  // 三类结果各走各的提示: 成功 / 上游限流 / 网络失败 / 无结果 / 其余失败。失败文案键
  // 集中在 metadata.ts 的 PAPER_META_FAILURE_KEYS, 页面只按 kind 取键, 不自己拼文案。
  assert.match(detailSource, /detail\.sync\.succeeded/)
  assert.match(detailSource, /PAPER_META_FAILURE_KEYS\[kind\]/)
  const metadataSource = readFileSync(new URL('./metadata.ts', import.meta.url), 'utf8')
  for (const key of ['quotaFailed', 'networkFailed', 'missed', 'failed']) {
    assert.match(metadataSource, new RegExp(`detail\\.sync\\.${key}`))
  }

  // 三条腿同形返回 { success, fields, bib_type? }: 页面只认 payload.fields, 不再解析
  // 任何上游命中项形状, 落库时连文献类型一起写回。
  assert.match(detailSource, /const fields = paperMetaFields\(payload\)/)
  assert.match(detailSource, /await applyMetadata\(fields, payload\.bib_type\)/)
  assert.match(
    detailSource,
    /updateLiterature\(id, \{ fields, \.\.\.\(bibType \? \{ bib_type: bibType \} : \{\}\) \}, projectId\)/
  )
  // 确认框里勾选的字段同样带上命中项的文献类型。
  assert.match(
    detailSource,
    /paperMetaPickedFields\(syncMatch\.fields, syncPicked\),\s*syncMatch\.bibType/
  )
  // 免登录: 可用性判据不再吃登录态, 页面也不再为此取账号身份。
  assert.match(detailSource, /canSyncMetadata\(item\)/)
  assert.doesNotMatch(detailSource, /useAccountIdentity/)
  assert.match(detailSource, /catalogue\.reload\(\)/)
})

test('metadata sync copy is localized and keeps the agreed wording', () => {
  const expected: Record<string, string> = {
    action: '同步元数据',
    bannerByDoi: '从 doi.org 同步元数据',
    bannerByArxiv: '从 arxiv.org 同步元数据',
    bannerByTitle: '从 openalex.org 同步元数据',
    succeeded: '同步元数据成功',
    failed: '同步元数据失败',
    quotaFailed: '接口限流，请稍后重试'
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
        'action', 'bannerByArxiv', 'bannerByDoi', 'bannerByTitle', 'byArxiv',
        'byDoi', 'byTitle', 'confirm', 'confirmDescription', 'confirmTitle',
        'currentValue', 'failed', 'missed', 'networkFailed', 'nextValue',
        'quotaFailed', 'reasonLabel', 'succeeded', 'supplementIdentifier'
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
