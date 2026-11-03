import { useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../localization/engine'
import zhAssistant from '../../../localization/locales/zh/assistant.json'
import enAssistant from '../../../localization/locales/en/assistant.json'
import zhUi from '../../../localization/locales/zh/ui.json'
import enUi from '../../../localization/locales/en/ui.json'
import { FloatingWindow } from './primitive/FloatingWindow'
import { Button, ToastProvider } from './ui'
import { StoreProvider } from '../store'
import { DocumentWorkspaceContext, documentWorkspaces } from '../features/workbench/workspace'
import { createRoot } from 'react-dom/client'

import '../styles.css'
import { Markdown } from './primitive/Markdown'
import { sourceOffsetRect } from './markdown/source'
import { CitationSources, WebCitationLink } from '../features/assistant/Citations'
import { Summary } from '../features/workbench/pdf/Summary'
import { answerProjectSource, projectSource } from '../features/assistant/sources'

Object.assign(window, { sourceOffsetRect })

const localization = createLocalization(
  'zh',
  { zh: { assistant: zhAssistant, ui: zhUi }, en: { assistant: enAssistant, ui: enUi } },
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
  const [revision, setRevision] = useState(0)
  const [citationComplete, setCitationComplete] = useState(false)
  const [streamRevision, setStreamRevision] = useState(0)
  const [windowOpen, setWindowOpen] = useState(false)
  return (
    <>
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
          named
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
      <div data-testid="tilde-markdown">
        <Markdown text={tildeSource} />
      </div>
      <div data-testid="tilde-markdown-math">
        <Markdown text={tildeSource} math />
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
        onSource={(page, text) => {
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
          <Fixture />
        </DocumentWorkspaceContext.Provider>
      </StoreProvider>
    </ToastProvider>
  </I18nextProvider>
)
