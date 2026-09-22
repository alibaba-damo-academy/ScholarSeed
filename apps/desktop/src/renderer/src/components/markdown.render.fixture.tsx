import { useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../localization/engine'
import zhAssistant from '../../../localization/locales/zh/assistant.json'
import enAssistant from '../../../localization/locales/en/assistant.json'
import zhUi from '../../../localization/locales/zh/ui.json'
import enUi from '../../../localization/locales/en/ui.json'
import { FloatingWindow } from './primitive/FloatingWindow'
import { Button } from './ui'
import { createRoot } from 'react-dom/client'

import '../styles.css'
import { Markdown } from './primitive/Markdown'
import { sourceOffsetRect } from './markdown/source'

Object.assign(window, { sourceOffsetRect })

const localization = createLocalization('zh', { zh: { assistant: zhAssistant, ui: zhUi }, en: { assistant: enAssistant, ui: enUi } }, { report: () => undefined })

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
  '\\*\\*字面符号：\\*\\*BERT'
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
  '```'
].join('\n')

const claimStart = source.indexOf('postgres')
const wrappedWebSource = '网页来源（[新华网](https://example.com/source)、[银联](https://example.com/unionpay)）'
const tildeSource = '气温：24~33℃；次日 23~31℃。\n\n标准：~~已取消~~。\n\n代码：`24~33℃`。'

function Fixture() {
  const [revision, setRevision] = useState(0)
  const [windowOpen, setWindowOpen] = useState(false)
  return <><Button onClick={() => setRevision(value => value + 1)}>刷新父组件 {revision}</Button>
  <Markdown
    text={source}
    math
    sourceMapped
    renderCitation={(range, children) => <span data-testid="pdf-citation" data-original={source.slice(range.start, range.end)}>{children}</span>}
    evidence={[{
      claim_ref: 'claim:inline-code',
      start_utf16: claimStart,
      end_utf16: claimStart + 'postgres'.length,
      span_text_hash: 'sha256:test',
      priority: 'supported',
      source_refs: ['url:https://example.com/source'],
      citation_nums: [1]
    }]}
    answerAnnotations={[{
      id: 'annotation:inline-code',
      start_utf16: claimStart,
      end_utf16: claimStart + 'postgres'.length,
      focused: true
    }]}
    renderAnswerAnnotationMarker={(annotation) => (
      <span data-testid="answer-marker">{annotation.id}</span>
    )}
  />
  <div data-testid="citation-content"><Markdown text={citationSource} sourceMapped
    renderCitation={(range, children) => <span data-testid="claim-link" data-original={citationSource.slice(range.start, range.end)}>{children}</span>} /></div>
  <div data-testid="wrapped-web-citation"><Markdown text={wrappedWebSource} sourceMapped
    citationUrls={['https://example.com/source', 'https://example.com/unionpay']}
    renderCitation={(range, children) => <span data-testid="web-citation" data-original={wrappedWebSource.slice(range.start, range.end)}>{children}</span>} /></div>
  <div data-testid="localized-markdown"><Markdown text={'- [x] User task\n- [ ] AI task\n\n![](https://example.com/empty.png)'} /></div>
  <div data-testid="tilde-markdown"><Markdown text={tildeSource} /></div>
  <div data-testid="tilde-markdown-math"><Markdown text={tildeSource} math /></div>
  <div data-testid="session-file-markdown"><Markdown
    text={'[报告](outputs/report%20one.md) · [越界](../secret.md) · [网页](https://example.com) · [伪协议](file:///tmp/report.md)'}
    onOpenSessionFile={(path) => { document.body.dataset.openedSessionFile = path }}
  /></div>
  <Button onClick={() => void localization.changeLanguage('en')}>Switch to English</Button>
  <Button onClick={() => void localization.changeLanguage('zh')}>Switch to Chinese</Button>
  <Button onClick={() => setWindowOpen(true)}>Open floating window</Button>
  {windowOpen && <FloatingWindow title="用户标题" onClose={() => setWindowOpen(false)}>原始内容</FloatingWindow>}
  </>
}
createRoot(document.getElementById('root')!).render(<I18nextProvider i18n={localization}><Fixture /></I18nextProvider>)
