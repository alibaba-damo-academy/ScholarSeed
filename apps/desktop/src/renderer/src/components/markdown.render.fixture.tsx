import { useState } from 'react'
import highlight from 'highlight.js'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../localization/engine'
import zhAssistant from '../../../localization/locales/zh/assistant.json'
import enAssistant from '../../../localization/locales/en/assistant.json'
import zhUi from '../../../localization/locales/zh/ui.json'
import enUi from '../../../localization/locales/en/ui.json'
import zhConversation from '../../../localization/locales/zh/conversation.json'
import enConversation from '../../../localization/locales/en/conversation.json'
import zhLiterature from '../../../localization/locales/zh/literature.json'
import enLiterature from '../../../localization/locales/en/literature.json'
import { FloatingWindow } from './primitive/FloatingWindow'
import { EmptyAnswer } from './primitive/Fallback'
import { Code } from './primitive/Code'
import { Formula } from './primitive/Formula'
import { Diagram } from './primitive/Diagram'
import { Plot } from './primitive/Plot'
import { Tabulation } from './primitive/Tabulation'
import { Button, ToastProvider } from './ui'
import { StoreProvider } from '../store'
import { DocumentWorkspaceContext, documentWorkspaces } from '../features/workbench/workspace'
import { createRoot } from 'react-dom/client'
import { WebNavigationContext } from '../contracts/navigation'
import { openWebPage } from '../app/links'

import '../styles.css'
import { Markdown, MarkdownContent } from './primitive/Markdown'
import { sourceOffsetRect } from './markdown/source'
import { CitationSources, WebCitationLink } from '../features/assistant/Citations'
import { CitationSources as SourceDirectory } from './business/Citation'
import { CitationLink as ReceiptCitation } from './business/Citation'
import { Summary } from './business/Summary'
import { CitationSources as CitationDirectory } from './business/Citation'
import type { CitationResolution } from '../contracts/citations'
import { answerProjectSource, projectSource } from '../features/assistant/sources'

Object.assign(window, { sourceOffsetRect })

highlight.addPlugin({
  'before:highlight': ({ code }) => {
    if (code === 'render-failure-probe') throw new Error('Fixture highlighter failure')
  },
})

function HighlightRecovery() {
  const [failed, setFailed] = useState(false)
  return (
    <div data-testid="fallback-highlighter">
      <Button onClick={() => setFailed(true)}>触发高亮异常</Button>
      <Button onClick={() => setFailed(false)}>恢复正常代码</Button>
      <Code
        code={failed ? 'render-failure-probe' : 'print(1)'}
        language="python"
        onCopy={async (source) => {
          document.body.dataset.copiedRecovery = source
        }}
      />
    </div>
  )
}

function RenderRecovery() {
  const [failed, setFailed] = useState(false)
  const text = failed
    ? '回答原文 [来源](https://example.com/recovery)\n\n<!-- scholarseed-ref private -->\n\n<script>window.__recoveryExecuted = true</script>'
    : '正常内容已恢复。'
  return (
    <div data-testid="fallback-renderer">
      <Button onClick={() => setFailed(true)}>触发解析异常</Button>
      <Button onClick={() => setFailed(false)}>恢复正常正文</Button>
      <MarkdownContent
        text={text}
        renderSourceLink={() => {
          throw new Error('Fixture renderer failure')
        }}
        onCopy={async (source) => {
          document.body.dataset.copiedRecoverySource = source
        }}
      />
    </div>
  )
}

async function loadRemoteFixtureImage(url: string): Promise<Uint8Array> {
  document.body.dataset.remoteReads = String(Number(document.body.dataset.remoteReads ?? 0) + 1)
  if (url.endsWith('/failed')) throw new Error('fixture image unavailable')
  if (url.endsWith('/invalid')) return new Uint8Array([0])
  if (url.endsWith('/slow')) await new Promise((resolve) => setTimeout(resolve, 200))
  const response = await fetch('/assets/icon-img.png')
  const bytes = new Uint8Array(await response.arrayBuffer())
  document.body.dataset.remoteCompleted = url
  return bytes
}

function RemoteAnswerFixture() {
  const [source, setSource] = useState('https://example.com/figure.jpg')
  const [mounted, setMounted] = useState(true)
  return (
    <div data-testid="remote-answer-image">
      <Button onClick={() => setSource('https://example.com/slow')}>Slow remote</Button>
      <Button onClick={() => setSource('https://example.com/replacement')}>Replace remote</Button>
      <Button onClick={() => setSource('https://example.com/failed')}>Failed remote</Button>
      <Button onClick={() => setSource('https://example.com/invalid')}>Invalid remote</Button>
      <Button onClick={() => setSource('http://example.com/unsafe')}>Unsafe remote</Button>
      <Button onClick={() => setMounted(false)}>Remove remote</Button>
      {mounted && (
        <MarkdownContent
          text={`![Remote figure](${source})`}
          loadRemoteImage={loadRemoteFixtureImage}
        />
      )}
    </div>
  )
}

const localization = createLocalization(
  'zh',
  {
    zh: {
      assistant: zhAssistant,
      ui: zhUi,
      conversation: zhConversation,
      literature: zhLiterature,
    },
    en: {
      assistant: enAssistant,
      ui: enUi,
      conversation: enConversation,
      literature: enLiterature,
    },
  },
  { report: () => undefined, escapeValue: false }
)

const source = [
  '# 标题',
  '这个 `postgres` 行内代码应正确显示。',
  '',
  '3. 第三项',
  '4. 第四项',
  '',
  '- 外层',
  '  - 内层',
  '',
  '| 名称 | 状态 |',
  '| --- | --- |',
  '| 渲染 | 正常 |',
  '',
  '```ts',
  'const value = 1',
  '```',
  '',
  '公式 $x^2$。',
  '',
  '<script>window.__unsafe = true</script>',
  '![远程图片](https://example.com/image.png)',
  '[危险链接](javascript:alert(1))',
  '<!-- scholarseed-ref claim="private" -->',
  '',
  '😀 PDF [1](scholarseed-cite:fixture)',
  '`[not a citation](scholarseed-cite:code)`',
  '**待验证假设：**BERT 需要验证。',
  '一个**“中文方案”**的说明。',
  '`**代码：**BERT`',
  '\\*\\*字面符号：\\*\\*BERT',
].join('\n')

const citationSource = [
  '未验证的推断。样本量为 30；损失为 2.8 dB[1](scholarseed-cite:numeric)；另一个结论[2](scholarseed-cite:second)。仍需实验。',
  '',
  'Unverified assumption. The result is 0.42.[3](scholarseed-cite:english)',
  '',
  '> 原文第一句。原文包含 `[CLS]` 与 **句子对**。[4](scholarseed-cite:quote)[5](scholarseed-cite:duplicate)',
  '',
  '| 对照 | 结论 |',
  '| --- | --- |',
  '| BERT | 使用编码器[6](scholarseed-cite:table) |',
  '',
  '- 实验尚未完成。论文报告有提升[7](scholarseed-cite:list)',
  '',
  '普通[网页链接](https://example.com)保持原样。',
  '',
  '```text',
  '代码中的[8](scholarseed-cite:code)不处理',
  '```',
].join('\n')

const claimStart = source.indexOf('postgres')
const encodedCitationUrl =
  'https://example.com/%E4%B8%AD%E6%96%87?q=%E6%9D%A5%E6%BA%90#%E7%89%87%E6%AE%B5'
const wrappedWebSource =
  '网页来源（[新华网](https://example.com/source)、[银联](https://example.com/unionpay)）'
const tildeSource = '气温：24~33℃；次日 23~31℃。\n\n标准：~~已取消~~。\n\n代码：`24~33℃`。'
const currencySource =
  '52周区间 **$16.60 – $71.48**，目标价 $31[1](https://example.com/source)，另一目标价 $40。'
const mixedReferences =
  '😀正文[9]，数字[48](https://example.com/source)，具名[网站](https://example.com/source)。\r\n\r\n[9] https://example.com/source\r\n\r\n`[9]` 与 \\[9]。'
const streamingReference = '结论[49](https://example.com/source)'
const referenceFrames = Array.from({ length: streamingReference.length + 1 }, (_, index) =>
  streamingReference.slice(0, index)
)
const bracketedReference = '结论[[49]](https://example.com/source)'
const bracketedFrames = Array.from({ length: bracketedReference.length + 1 }, (_, index) =>
  bracketedReference.slice(0, index)
)
const streamingUrls = ['来源：https://example.com/source', '来源：www.example.com/source']
const appendixReferences =
  '- [9] https://example.com/source\r\n- [10] <https://example.com/second>\r\n\r\n[9] https://example.com/second\r\n\r\n[9] [官网](https://example.com/source)\r\n\r\n`[9] https://example.com/source`'

function Fixture() {
  const [fallbackPending, setFallbackPending] = useState(true)
  const [imageRecovered, setImageRecovered] = useState(false)
  const [emptyAttempts, setEmptyAttempts] = useState(0)
  const [revision, setRevision] = useState(0)
  const [citationComplete, setCitationComplete] = useState(false)
  const [streamRevision, setStreamRevision] = useState(0)
  const [windowOpen, setWindowOpen] = useState(false)
  const [copiedTable, setCopiedTable] = useState('')
  const directoryReceipt: CitationResolution = {
    handle: 'directory-receipt',
    pages: [],
    source_kind: 'literature',
    source_id: 'paper',
    content_level: 'fulltext',
    project_id: 'project',
    path: 'paper.pdf',
    title: 'Local source',
    revision: 'revision',
    quote: 'Deferred evidence',
    version_bound: true,
    state: 'source_only',
    can_open_pdf: false,
    matches: [],
    presentation: {
      version: 1,
      mode: 'structured_text',
      precision: 'source',
      text: 'Deferred evidence',
      quality_reasons: [],
      manual_check: false,
    },
  }
  if (new URLSearchParams(window.location.search).has('citationBoundary')) {
    const boundaryText =
      'This synthetic test fixture holds one English sentence of exactly two hundred forty ASCII characters so a reader can verify character level quote boundaries and no other sentence punctuation appears anywhere inside this single line of text.'
    return (
      <>
        <Button onClick={() => void localization.changeLanguage('en')}>English</Button>
        <Button onClick={() => void localization.changeLanguage('zh')}>中文</Button>
        {['First\nSecond\nThird', 'First\nSecond\nThird\nFourth', boundaryText.repeat(20)].map(
          (text, index) => {
            const receipt = {
              ...directoryReceipt,
              handle: `boundary-${index}`,
              title: `Boundary ${index}.pdf`,
              quote: text,
              presentation: { ...directoryReceipt.presentation, text },
            }
            return (
              <div key={receipt.handle} data-testid={`citation-boundary-${index}`}>
                <ReceiptCitation
                  resolve={async () => receipt}
                  reveal={async (source) => {
                    document.body.dataset.boundaryOpened = source.handle
                  }}
                  previewUrl={() => ''}
                  references={
                    index === 1
                      ? [
                          {
                            source: receipt,
                            resolve: async () => receipt,
                            excerpts: [
                              { source: receipt, resolve: async () => receipt },
                              {
                                source: { ...directoryReceipt, handle: 'boundary-short' },
                                resolve: async () => ({
                                  ...directoryReceipt,
                                  handle: 'boundary-short',
                                }),
                              },
                            ],
                          },
                          {
                            source: { ...directoryReceipt, handle: 'boundary-other' },
                            resolve: async () => ({
                              ...directoryReceipt,
                              handle: 'boundary-other',
                            }),
                            excerpts: [],
                          },
                        ]
                      : undefined
                  }
                >
                  {index + 1}
                </ReceiptCitation>
              </div>
            )
          }
        )}
      </>
    )
  }
  return (
    <>
      <div data-testid="literature-citation">
        {[
          { authors: 'Alexandria Example-With-A-Very-Long-Name, Jamie Example', year: '2024' },
          { authors: '', year: '2025' },
          { authors: '', year: '' },
        ].map(({ authors, year }, index) => {
          const source: CitationResolution = {
            ...directoryReceipt,
            handle: `literature-${index}`,
            source_kind: 'literature',
            title: `Paper ${index + 1}`,
            bibliography: {
              version: 1,
              title: '',
              authors,
              year,
              publication: 'Journal',
              url: '',
              doi: '',
            },
          }
          const resolve = async () => source
          const target = { source, resolve, excerpts: [] }
          const other = { ...directoryReceipt, handle: 'mixed-file' }
          return (
            <ReceiptCitation
              key={source.handle}
              identity={source}
              resolve={resolve}
              reveal={async () => undefined}
              previewUrl={() => ''}
              references={
                index === 0
                  ? [target, { source: other, resolve: async () => other, excerpts: [] }]
                  : undefined
              }
            >
              {source.title}
            </ReceiptCitation>
          )
        })}
      </div>
      <div data-testid="grouped-file-citation">
        <ReceiptCitation
          resolve={async () => directoryReceipt}
          reveal={async (source) => {
            document.body.dataset.groupedCitation = source.handle
          }}
          previewUrl={() => ''}
          references={Array.from({ length: 3 }, (_, index) => {
            const title = `Source ${index + 1}.pdf`
            const excerpts = [
              'First cited excerpt.',
              'Second cited excerpt.',
              'Third cited excerpt.',
            ].map((text, excerptIndex) => {
              const source = {
                ...directoryReceipt,
                handle: `source-${index}-excerpt-${excerptIndex}`,
                title,
                pages: excerptIndex < 2 ? [{ page: excerptIndex + 1, quads: [] }] : [],
                presentation: { ...directoryReceipt.presentation, text },
              }
              return { source, resolve: async () => source }
            })
            return {
              ...excerpts[0],
              excerpts,
            }
          })}
        >
          Grouped files
        </ReceiptCitation>
      </div>
      <div data-testid="direct-file-citation">
        <ReceiptCitation
          identity={{ title: 'Initial.pdf', path: 'Initial.pdf' }}
          resolve={async () => ({
            ...directoryReceipt,
            state: 'exact',
            can_open_pdf: true,
            pages: [{ page: 2, quads: [] }],
          })}
          reveal={async (source) => {
            document.body.dataset.directCitation = source.handle
          }}
          previewUrl={() => ''}
        >
          Local source
        </ReceiptCitation>
      </div>
      <div data-testid="missing-file-citation">
        <ReceiptCitation
          resolve={async () => ({
            ...directoryReceipt,
            state: 'unavailable',
            source_missing: true,
          })}
          reveal={async () => {
            throw new Error('missing source must not open')
          }}
          previewUrl={() => ''}
        >
          Missing source
        </ReceiptCitation>
      </div>
      <div data-testid="mixed-citation-directory">
        <CitationDirectory
          sourceKey="directory"
          loadSources={async () => ({ count: 1, sources: [directoryReceipt] })}
          resolveSource={async (handle) => {
            document.body.dataset.directoryResolves = String(
              Number(document.body.dataset.directoryResolves ?? 0) + 1
            )
            document.body.dataset.directoryHandle = handle
            return directoryReceipt
          }}
          reveal={async () => {
            throw new Error('read-only fixture cannot open original')
          }}
          previewUrl={() => ''}
          openWebSource={(url) => {
            document.body.dataset.directoryWeb = url
          }}
          answerSources={[
            { kind: 'receipt', number: 1, handle: directoryReceipt.handle, citation_urls: [] },
            {
              kind: 'searched',
              number: 2,
              title: 'Web source',
              url: 'https://example.com/directory',
              citation_urls: [],
              search_kind: 'web',
              search_id: 'directory-search',
            },
          ]}
        />
      </div>
      <div data-testid="tabulation-copy">
        <Tabulation
          caption="Table caption"
          copyText="Original table"
          onCopy={async (text) => setCopiedTable(text)}
        >
          <span>Table content</span>
        </Tabulation>
        <output>{copiedTable}</output>
      </div>
      <Button onClick={() => setRevision((value) => value + 1)}>刷新父组件 {revision}</Button>
      <Button onClick={() => setCitationComplete(true)}>结束引用流式</Button>
      <Button onClick={() => setStreamRevision((value) => value + 1)}>追加引用文本</Button>
      <CitationSources
        sessionId="fixture-stream"
        answerId="stream-answer"
        text={`流式 ${streamRevision} [1](scholarseed-cite:fixture)`}
        resolveEnabled={citationComplete}
        coverage={{ status: 'reviewing' }}
      />
      <Markdown
        text={source}
        math
        sourceMapped
        renderCitation={(range, children) => (
          <span data-testid="pdf-citation" data-original={source.slice(range.start, range.end)}>
            {children}
          </span>
        )}
        evidence={[
          {
            claim_ref: 'claim:inline-code',
            start_utf16: claimStart,
            end_utf16: claimStart + 'postgres'.length,
            span_text_hash: 'sha256:test',
            priority: 'supported',
            source_refs: ['url:https://example.com/source'],
            citation_nums: [1],
          },
        ]}
        answerAnnotations={[
          {
            id: 'annotation:inline-code',
            start_utf16: claimStart,
            end_utf16: claimStart + 'postgres'.length,
            focused: true,
          },
        ]}
        renderAnswerAnnotationMarker={(annotation) => (
          <span data-testid="answer-marker">{annotation.id}</span>
        )}
      />
      <div data-testid="native-citation">
        <Markdown
          text={'😀原生结论。**粗体**\r\n后文'}
          sourceMapped
          citationUrls={['https://example.com/native']}
          citationOccurrences={[
            { href: 'https://example.com/native', end_utf16: 7 },
            { href: 'https://example.com/native', end_utf16: 13 },
          ]}
          renderCitation={(range, _children, href) => (
            <span
              data-testid="native-marker"
              data-start={range.start}
              data-end={range.end}
              data-href={href}
            >
              [1]
            </span>
          )}
        />
      </div>
      <div data-testid="native-table-citation">
        <Markdown
          sourceMapped
          text={'| 日期 | 天气 |\n| --- | --- |\n| 明天 | 阵雨 |'}
          citationUrls={['https://example.com/native']}
          citationOccurrences={[
            {
              href: 'https://example.com/native',
              end_utf16: '| 日期 | 天气 |\n| --- | --- |\n| 明天 | 阵雨 |'.length,
            },
          ]}
          renderCitation={() => <span data-testid="native-table-marker">[1]</span>}
        />
      </div>
      <div data-testid="native-url-citations">
        <Markdown
          sourceMapped
          text={
            '下载：https://example.com/native\n\n依据：<https://example.com/native>\n\n说明：[https://example.com/native](https://example.com/native)\n\n[官网](https://example.com/native) 与 https://example.com/unrelated\n\n`https://example.com/native`'
          }
          citationUrls={['https://example.com/native']}
          renderCitation={(range) => (
            <span data-testid="native-url-marker" data-start={range.start} data-end={range.end}>
              [1]
            </span>
          )}
        />
      </div>
      {streamingUrls.flatMap((text, sourceIndex) =>
        Array.from({ length: text.length + 1 }, (_, index) => (
          <div key={`${sourceIndex}:${index}`} data-testid={`url-frame-${sourceIndex}-${index}`}>
            <Markdown text={text.slice(0, index)} sourceMapped citationPending />
          </div>
        ))
      )}
      <div data-testid="streaming-url-prose">
        <Markdown
          text={
            '来源 https://example.com/source。后文保留\n\n第二行 https://example.com/next\n\n`https://example.com/code`'
          }
          sourceMapped
          citationPending
        />
      </div>
      <div data-testid="url-title-citation">
        <WebCitationLink
          source={{
            kind: 'searched',
            number: 1,
            title: encodedCitationUrl,
            url: encodedCitationUrl,
            citation_urls: [encodedCitationUrl],
            search_kind: 'web',
            search_id: 'fixture',
          }}
        />
      </div>
      <div data-testid="named-title-citation">
        <WebCitationLink
          source={{
            kind: 'searched',
            number: 2,
            title: '原始页面标题 100% %E4%B8%AD',
            url: encodedCitationUrl,
            citation_urls: [encodedCitationUrl],
            search_kind: 'web',
            search_id: 'fixture',
          }}
        />
      </div>
      <div data-testid="candidate-only">
        <CitationSources
          sessionId="fixture"
          answerId="answer"
          text="事实没有关联证据"
          answerSources={[]}
          coverage={{ status: 'partial', unresolved: ['事实没有关联证据'] }}
        />
      </div>
      <div data-testid="nested-pending-url">
        <Markdown
          text={'[**https://example.com/**](https://example.com/)'}
          sourceMapped
          citationPending
        />
      </div>
      <div data-testid="slash-url-citation">
        <Markdown
          text={'[https://example.com](https://example.com/)'}
          sourceMapped
          citationUrls={['https://example.com/']}
          renderCitation={() => <span data-testid="slash-citation">[1]</span>}
        />
      </div>
      <div data-testid="mixed-project-source-directory">
        <SourceDirectory
          sourceKey="mixed-project"
          resolveSource={async () => {
            throw new Error('navigation_is_not_a_receipt')
          }}
          reveal={async () => undefined}
          previewUrl={() => ''}
          openWebSource={() => undefined}
          renderProjectSource={(source) => (
            <Button onClick={() => document.body.setAttribute('data-directory-open', source.url)}>
              {source.title}
            </Button>
          )}
          answerSources={[
            {
              kind: 'project',
              number: 1,
              source_kind: 'resource',
              project_id: 'p',
              path: 'report.md',
              title: 'report.md',
              url: '/api/resource/raw?project=p&path=report.md',
              citation_urls: [],
            },
            {
              kind: 'project',
              number: 2,
              source_kind: 'resource',
              project_id: 'p',
              path: 'report.md',
              title: 'report.md',
              url: '/api/resource/raw?project=p&path=report.md',
              citation_urls: [],
            },
            {
              kind: 'searched',
              number: 3,
              title: '公开论文',
              url: 'https://example.test/paper',
              search_kind: 'paper',
              search_id: 'read',
              citation_urls: [],
            },
          ]}
        />
      </div>
      <div data-testid="cited-source-list">
        <CitationSources
          sessionId="fixture"
          answerId="cited-answer"
          text="已引用的事实"
          coverage={{
            status: 'partial',
            unresolved: ['内部核验记录：Direct source support；search/run'],
          }}
          answerSources={[
            {
              kind: 'searched',
              number: 1,
              title: '已引用页面',
              url: 'https://example.com/cited/%E4%B8%AD%E6%96%87',
              citation_urls: ['https://example.com/cited/%E4%B8%AD%E6%96%87'],
              search_kind: 'web',
              search_id: 'search',
            },
            {
              kind: 'searched',
              number: 2,
              title: encodedCitationUrl,
              url: encodedCitationUrl,
              citation_urls: [encodedCitationUrl],
              search_kind: 'web',
              search_id: 'search',
            },
          ]}
        />
      </div>
      <div data-testid="no-source-list">
        <CitationSources
          sessionId="fixture"
          answerId="empty-answer"
          text="普通回答"
          answerSources={[]}
        />
      </div>
      <div data-testid="coverage-source-list">
        <CitationSources
          sessionId="fixture"
          answerId="coverage-answer"
          text="有依据的事实。尚未找到依据的事实。"
          coverage={{
            status: 'partial',
            unresolved: ['尚未找到依据的事实。'],
            unread_sources: 14,
          }}
          answerSources={[
            {
              kind: 'searched',
              number: 1,
              title: '有依据的来源',
              url: 'https://example.com/evidence',
              citation_urls: ['https://example.com/evidence'],
              search_kind: 'web',
              search_id: 'search',
            },
          ]}
        />
      </div>
      {(['reviewed', 'unavailable', 'interrupted'] as const).map((status) => (
        <div key={status} data-testid={`coverage-${status}-list`}>
          <CitationSources
            sessionId="fixture"
            answerId={`coverage-${status}-answer`}
            text="终态核验的回答。未关联的终态原文。"
            coverage={{
              status,
              unresolved: ['未关联的终态原文。'],
              ...(status === 'reviewed' ? { unread_sources: 3 } : {}),
            }}
            answerSources={[
              {
                kind: 'searched',
                number: 1,
                title: `终态来源 ${status}`,
                url: `https://example.com/${status}`,
                citation_urls: [`https://example.com/${status}`],
                search_kind: 'web',
                search_id: 'search',
              },
            ]}
          />
        </div>
      ))}
      <div data-testid="stale-source-list">
        <CitationSources
          sessionId="fixture-stale"
          answerId="stale-answer"
          text="刷新失败的回答[1](scholarseed-cite:stale)"
          coverage={{ status: 'reviewed' }}
          answerSources={[
            {
              kind: 'searched',
              number: 1,
              title: '保留的来源',
              url: 'https://example.com/stale',
              citation_urls: ['https://example.com/stale'],
              search_kind: 'web',
              search_id: 'search',
            },
          ]}
        />
      </div>
      <div data-testid="citation-content">
        <Markdown
          text={citationSource}
          sourceMapped
          renderCitation={(range, children) => (
            <span
              data-testid="claim-link"
              data-original={citationSource.slice(range.start, range.end)}
            >
              {children}
            </span>
          )}
        />
      </div>
      <div data-testid="wrapped-web-citation">
        <Markdown
          text={wrappedWebSource}
          sourceMapped
          citationUrls={['https://example.com/source', 'https://example.com/unionpay']}
          renderCitation={(range, children) => (
            <span
              data-testid="web-citation"
              data-original={wrappedWebSource.slice(range.start, range.end)}
            >
              {children}
            </span>
          )}
        />
      </div>
      <div data-testid="localized-markdown">
        <Markdown text={'- [x] User task\n- [ ] AI task\n\n![](https://example.com/empty.png)'} />
      </div>
      <div data-testid="mixed-references">
        <Markdown
          sourceMapped
          text={mixedReferences}
          citationUrls={['https://example.com/source']}
          citationReferences={[{ label: '9', href: 'https://example.com/source' }]}
          renderCitation={(range) => (
            <span
              data-testid="mapped-citation"
              data-original={mixedReferences.slice(range.start, range.end)}
            >
              [1]
            </span>
          )}
        />
      </div>
      <div data-testid="adjacent-references">
        <Markdown
          sourceMapped
          text={'正文[9][10]，重复[9][9][9]，分隔[9]文字[9]，未完成[9](url，命名[9][name]'}
          citationUrls={['https://example.com/source', 'https://example.com/second']}
          citationReferences={[
            { label: '9', href: 'https://example.com/source' },
            { label: '10', href: 'https://example.com/second' },
          ]}
          renderCitation={(range, children) => (
            <span data-testid="adjacent-marker" data-length={range.end - range.start}>
              {children}
            </span>
          )}
        />
      </div>
      <div data-testid="adjacent-links">
        <Markdown
          sourceMapped
          text={'正文[2](https://example.com/source)[2](https://example.com/source)'}
          citationUrls={['https://example.com/source']}
          renderCitation={(range) => (
            <span data-testid="adjacent-link-marker" data-length={range.end - range.start}>
              [2]
            </span>
          )}
        />
      </div>
      <div data-testid="styled-postfix-reference">
        <Markdown
          sourceMapped
          text={
            '**https://example.com/source** [9]\n\n*https://example.com/source* [9]\n\n**保留文字** [9]\n\n`https://example.com/source [9]`'
          }
          citationUrls={['https://example.com/source']}
          citationReferences={[{ label: '9', href: 'https://example.com/source' }]}
          renderCitation={(range) => (
            <span data-testid="styled-postfix-marker" data-length={range.end - range.start}>
              [1]
            </span>
          )}
        />
      </div>
      <div data-testid="publisher-citation-boundary">
        <Markdown text={'出版方：https://aclanthology.org/2024.eacl-demo.16/[3]'} />
        <Markdown text={'出版方：https://aclanthology.org/2024.eacl-demo.16/[3'} citationPending />
      </div>
      <div data-testid="url-and-reference">
        <Markdown
          sourceMapped
          text={'https://example.com/source [2](https://example.com/source)'}
          citationUrls={['https://example.com/source']}
          renderCitation={(range) => (
            <span data-testid="url-reference-marker" data-length={range.end - range.start}>
              [2]
            </span>
          )}
        />
      </div>
      <div data-testid="appendix-references">
        <Markdown
          sourceMapped
          text={appendixReferences}
          citationUrls={['https://example.com/source', 'https://example.com/second']}
          citationReferences={[
            { label: '9', href: 'https://example.com/source' },
            { label: '10', href: 'https://example.com/second' },
          ]}
          renderCitation={(range, _children, href) => (
            <span
              data-testid="appendix-marker"
              data-original={appendixReferences.slice(range.start, range.end)}
            >
              {href === 'https://example.com/source' ? '[1]' : '[2]'}
            </span>
          )}
        />
      </div>
      {referenceFrames.map((text, index) => (
        <div key={index} data-testid={`citation-frame-${index}`}>
          <Markdown text={text} sourceMapped citationPending />
        </div>
      ))}
      {bracketedFrames.map((text, index) => (
        <div key={index} data-testid={`bracketed-frame-${index}`}>
          <Markdown text={text} sourceMapped citationPending />
        </div>
      ))}
      <div data-testid="bracketed-reference">
        <Markdown
          text={bracketedReference}
          sourceMapped
          citationUrls={['https://example.com/source']}
          renderCitation={(range) => (
            <span
              data-testid="bracketed-citation"
              data-original={bracketedReference.slice(range.start, range.end)}
            >
              [1]
            </span>
          )}
        />
      </div>
      <div data-testid="interrupted-reference">
        <Markdown text={streamingReference.slice(0, -1)} sourceMapped />
      </div>
      <div data-testid="streaming-code">
        <Markdown text={'`[49](https://example.com/source`'} sourceMapped citationPending />
      </div>
      <div data-testid="streaming-ordinary">
        <Markdown text={'[网站](https://example.com/source)'} sourceMapped citationPending />
      </div>
      <div data-testid="streaming-escaped">
        <Markdown text={'\\[49](https://example.com/source'} sourceMapped citationPending />
      </div>
      <div data-testid="streaming-parentheses">
        <Markdown text={'正文 [49](https://example.com/(source)'} sourceMapped citationPending />
      </div>
      <div data-testid="streaming-siblings">
        <Markdown
          text={'参见 [49](https://zh.wikipedia.org/wiki/Foo_(bar 与 **重点**'}
          sourceMapped
          citationPending
        />
      </div>
      <div data-testid="streaming-text-tail">
        <Markdown text={'参见 [49](relative_(bar 与正文'} sourceMapped citationPending />
      </div>
      <div data-testid="streaming-prefix">
        <Markdown
          text={'研究表明 A[1] 与 B[2] 相关[3](https://zh.wikipedia.org/wiki/X_(y'}
          sourceMapped
          citationPending
          citationReferences={[
            { label: '1', href: 'https://example.com/one' },
            { label: '2', href: 'https://example.com/two' },
          ]}
          renderCitation={(range, children) => (
            <span data-testid="prefix-citation" data-start={range.start} data-end={range.end}>
              {children}
            </span>
          )}
        />
      </div>
      <div data-testid="malformed-mapped">
        <Markdown
          text={'[9](https://a.com/(x'}
          sourceMapped
          citationReferences={[{ label: '9', href: 'https://example.com/source' }]}
          renderCitation={() => <span data-testid="incorrect-citation">[1]</span>}
        />
      </div>
      <div data-testid="fallback-table">
        <Markdown text={'| 研究 | 效率变化 |\n| --- |\n| Noy & Zhang | -40% |'} />
      </div>
      <div data-testid="fallback-links" className="w-[var(--vds-preview-width)]">
        <MarkdownContent
          text={
            'https://example.com/research/appendix?query=' +
            'long'.repeat(80) +
            '\n\n[原文](https://example.com/paper "来源标题")'
          }
          onOpenExternal={(url) => {
            document.body.dataset.openedFallbackLink = url
          }}
          onCopy={async (value) => {
            document.body.dataset.copiedFallbackLink = value
          }}
        />
      </div>
      <div data-testid="fallback-image">
        <Button onClick={() => setImageRecovered(true)}>更新图片来源</Button>
        <MarkdownContent
          text={'![研究图](outputs/missing-figure.png)'}
          resolveImage={() =>
            imageRecovered
              ? (new URLSearchParams(location.search).get('imageSource') ?? '/assets/icon-img.png')
              : '/fixture-missing-figure.png'
          }
          onOpenSessionFile={(path) => {
            document.body.dataset.openedFallbackImage = path
          }}
        />
      </div>
      <RemoteAnswerFixture />
      <div data-testid="fallback-empty">
        <EmptyAnswer
          onRetry={async () => {
            setEmptyAttempts((value) => value + 1)
            return false
          }}
        />
        <output>{emptyAttempts}</output>
      </div>
      <div data-testid="fallback-unavailable">
        <EmptyAnswer />
      </div>
      <HighlightRecovery />
      <RenderRecovery />
      <div data-testid="fallback-theme">
        <MarkdownContent text={'```mermaid\ngraph LR\nA[Input] --> B[Output]\n```'} />
      </div>
      <div data-testid="fallback-nonstandard" className="min-w-0 max-w-[var(--vds-preview-width)]">
        <MarkdownContent
          sourceMapped
          text={[
            '```unknown-research-language',
            '<unsafe>value</unsafe>',
            '```',
            '',
            'doi:' + 'long'.repeat(120),
            '',
            '<div class="note">仅供参考</div>',
            '',
            '<script>window.__formatExecuted = true</script>',
          ].join('\n')}
          onCopy={async (value) => {
            document.body.dataset.copiedFallbackCode = value
          }}
        />
      </div>
      <div data-testid="fallback-streaming">
        <Button onClick={() => setFallbackPending(false)}>完成格式测试轮次</Button>
        <Markdown
          math
          sourceMapped
          pending={fallbackPending}
          text={[
            '| 研究 | 效率变化 |',
            '| --- |',
            '| A | 1 |',
            '',
            '$$',
            '\\missingCommand{x}',
            '$$',
            '',
            '行内 $\\missingCommand{x}$',
            '',
            '```mermaid',
            'not a valid diagram',
            '```',
          ].join('\n')}
        />
      </div>
      <div data-testid="tilde-markdown">
        <Markdown text={tildeSource} />
      </div>
      <div data-testid="tilde-markdown-math">
        <Markdown text={tildeSource} math />
      </div>
      <div data-testid="formula-style">
        <Formula source="a+b" caption="Formula" onCopy={async () => {}} />
      </div>
      <div data-testid="card-headers">
        <Formula source="a+b" caption="Formula" onCopy={async () => {}} />
        <Code
          code={Array.from({ length: 23 }, (_, index) => `const value${index} = ${index}`).join(
            '\n'
          )}
          language="js"
          onCopy={async () => {}}
        />
        <Diagram source="graph LR; A-->B" title="Diagram" onCopy={async () => {}} />
        <Plot
          title="Chart"
          model={{
            kind: 'bar',
            dataset: {
              columns: [
                { key: 'name', label: 'Name' },
                { key: 'score', label: 'Score' },
              ],
              rows: [{ id: 'a', values: ['A', 2] }],
            },
            x: 0,
            y: [1],
          }}
          onCopy={async () => {}}
        />
      </div>
      <div data-testid="standalone-formula-copy">
        <MarkdownContent
          text={'$$\\frac{F}{k}=x$$'}
          math
          onCopy={async (text, html) => {
            document.body.dataset.copiedFormulaText = text
            document.body.dataset.copiedFormulaHtml = html ?? ''
          }}
        />
      </div>
      <div data-testid="formula-selection-copy">
        <MarkdownContent
          text={[
            'Before the formula',
            String.raw`$$\mathrm{NDVI}=\frac{\rho_{NIR}-\rho_{Red}}{\rho_{NIR}+\rho_{Red}}$$`,
            'After the formula',
            String.raw`$$\begin{cases}x^2 & x<0\\x & x\ge 0\end{cases}$$`,
          ].join('\n\n')}
          math
        />
      </div>
      <div data-testid="standalone-formula-layout" className="w-[328px]">
        <MarkdownContent
          text={[
            '**MSE**',
            '$$x^2$$',
            '**Long aligned formula**',
            String.raw`$$\begin{aligned} S &= ${'x_i+'.repeat(40)}y \\ T &= z \end{aligned}$$`,
          ].join('\n')}
          math
          sourceMapped
        />
      </div>
      <div data-testid="tex-delimiter-math">
        <Markdown text={'公式 \\(x^2\\) 与 \\[a+b\\]。'} math />
      </div>
      <div data-testid="currency-markdown">
        <Markdown
          text={currencySource}
          math
          sourceMapped
          citationUrls={['https://example.com/source']}
          renderCitation={(range, children, href) => (
            <a
              href={href}
              data-testid="currency-citation"
              data-original={currencySource.slice(range.start, range.end)}
            >
              {children}
            </a>
          )}
        />
      </div>
      <div data-testid="project-source-markdown">
        <Markdown
          text="[Project file](/api/resource/raw?project=project&path=resources%2Fa.md) [Foreign file](/api/resource/raw?project=foreign&path=resources%2Fa.md)"
          renderSourceLink={(href, children) =>
            projectSource(href, 'project') ? (
              <Button
                onClick={() => {
                  document.body.dataset.openedProjectSource = href
                }}
              >
                {children}
              </Button>
            ) : undefined
          }
        />
      </div>
      <div data-testid="local-project-source-markdown">
        <Markdown
          sourceMapped
          text={[
            '来源：resources/项目A/calibration.md#L5（项目资源）',
            '`D:\\work space\\项目A\\resources\\项目A\\calibration.md`',
            '`resources/中文目录 空格/note.txt`',
            '[编码来源](resources/%E9%A1%B9%E7%9B%AEA/calibration.md#L3)',
            '`D:\\other\\resources\\项目A\\calibration.md`',
            '```text\nresources/项目A/calibration.md\n```',
          ].join('\n\n')}
          renderSourceLink={(href, children) => {
            const source = answerProjectSource(
              href,
              { id: 'project', path: 'D:\\work space\\项目A' },
              ['resources/项目A/calibration.md', 'resources/中文目录 空格/note.txt'].map(
                (path) => ({
                  id: path,
                  kind: 'file',
                  title: path,
                  reference: {
                    id: path,
                    type: 'assistant_context',
                    kind: 'resource',
                    sourceId: path,
                    title: path,
                  },
                })
              )
            )
            return source?.kind === 'resource' ? (
              <Button
                onClick={() => {
                  document.body.dataset.openedLocalProjectSource = source.path
                }}
              >
                {children}
              </Button>
            ) : undefined
          }}
        />
      </div>
      <div data-testid="session-file-markdown">
        <Markdown
          text={
            '[报告](outputs/report%20one.md) · [越界](../secret.md) · [网页](https://example.com) · [伪协议](file:///tmp/report.md)'
          }
          onOpenSessionFile={(path) => {
            document.body.dataset.openedSessionFile = path
          }}
        />
      </div>
      <Summary
        value={{
          text: '',
          paper_type: 'study',
          contribution: { text: '**研究贡献**' },
          claims: [{ text: '**关键结论**', evidence: [{ page: 5, quote: 'source text' }] }],
          method: { text: '**方法**' },
          limitations: {
            text: '1. **依赖LLM生成质量**：需要核查。\n2. **超参数敏感性**：需要调优。',
          },
        }}
        onSource={({ page, quote: text }) => {
          document.body.dataset.summarySource = `${page}:${text}`
        }}
      />
      <Button onClick={() => void localization.changeLanguage('en')}>Switch to English</Button>
      <Button onClick={() => void localization.changeLanguage('zh')}>Switch to Chinese</Button>
      <Button onClick={() => setWindowOpen(true)}>Open floating window</Button>
      {windowOpen && (
        <FloatingWindow title="用户标题" onClose={() => setWindowOpen(false)}>
          原始内容
        </FloatingWindow>
      )}
    </>
  )
}
createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={localization}>
    <ToastProvider>
      <StoreProvider assistantSources={[]}>
        <DocumentWorkspaceContext.Provider value={documentWorkspaces.forProject(null)}>
          <WebNavigationContext.Provider
            value={(url) => {
              void openWebPage(url, {
                available: true,
                dispatch: (command) => window.scholarseed.browser.dispatch(command),
                reveal: (options) => {
                  document.body.dataset.openedBrowserPage = options.browserPageId
                },
              })
            }}
          >
            <Fixture />
          </WebNavigationContext.Provider>
        </DocumentWorkspaceContext.Provider>
      </StoreProvider>
    </ToastProvider>
  </I18nextProvider>
)
