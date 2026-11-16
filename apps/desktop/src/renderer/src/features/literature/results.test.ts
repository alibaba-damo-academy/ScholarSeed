import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

test('authorization preview renders localized diagnostics and preserves the forty-paper count', async (context) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { addEventListener() {}, removeEventListener() {} },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: {} },
  })
  context.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  })
  const desktop = fileURLToPath(new URL('../../../../../', import.meta.url))
  const directory = mkdtempSync(join(desktop, 'node_modules/.literature-preview-'))
  try {
    const output = join(directory, 'preview.mjs')
    await build({
      stdin: {
        contents: `
          import React from 'react';
          import { renderToStaticMarkup } from 'react-dom/server';
          import { I18nextProvider } from 'react-i18next';
          import { createLocalization } from './src/localization/engine';
          import { resources } from './src/localization/resources';
          import { StoreContext } from './src/renderer/src/storeContext';
          import { LiteratureResults } from './src/renderer/src/features/literature/Summary';
          import { LiteratureCard } from './src/renderer/src/features/literature/Card';
          import { LiteratureReviewCard } from './src/renderer/src/features/literature/Review';
          import { ResultReport } from './src/renderer/src/features/literature/Report';
          import { SearchSurface } from './src/renderer/src/features/literature/Matches';
          import { ToastProvider } from './src/renderer/src/components/ui';
          import { LiteratureAuthorizationReceipt, LiteratureAuthorizationNode } from './src/renderer/src/features/literature/Authorization';
          import { literatureFeature } from './src/renderer/src/features/literature/feature';
          export function renderReceipt(answer, selectedPaperIds, kind = 'precise', threadFlags = {}, receiptFlags = {}, language = 'zh') {
            const question = { id: kind + '-search-fulltext:q', header: '精准检索授权', question: 'Read?',
              options: [{ label: '一键授权' }, { label: '拒绝' }],
              papers: [{ id: 'paper:p1', label: 'Paper One' }, { id: 'paper:p2', label: 'Paper Two' }] };
            if (kind !== 'precise') {
              question.id = kind + '-fulltext:q';
              question.header = kind === 'literature-review' ? '综述检索授权' : '想法原文授权';
              delete question.papers;
            }
            const props = { requestId: question.id, questions: [question], answers: { [question.id]: answer }, selectedPaperIds, decisionSource: 'user_explicit', ...receiptFlags };
            const policy = literatureFeature().interactionPolicies.find(candidate => candidate.matches([question]));
            const receipt = kind === 'precise'
              ? React.createElement(LiteratureAuthorizationReceipt, props)
              : policy.renderReply?.(props);
            return renderToStaticMarkup(React.createElement(I18nextProvider,
              { i18n: createLocalization(language, resources) },
              React.createElement(StoreContext.Provider, { value: { state: {
                activeSession: 'thread', threads: { thread: { sessionId: 'session', running: false, conversation: [], ...threadFlags } }
              } } }, receipt)));
          }
          export function renderNode(answer, flags = {}, language = 'zh') {
            const question = { id: 'precise-search-fulltext:q', header: '精准检索授权', question: 'Read?',
              resultCardId: 'result', options: [{ label: '一键授权' }, { label: '拒绝' }] };
            const request = { kind: 'hil', requestId: question.id, hilKind: 'question', questions: [question],
              hilState: answer ? 'resolved' : 'pending', answers: answer ? { [question.id]: answer } : {}, decisionSource: 'user_explicit', ...flags };
            return renderToStaticMarkup(React.createElement(I18nextProvider,
              { i18n: createLocalization(language, resources) },
              React.createElement(StoreContext.Provider, { value: { state: {
                activeSession: 'thread', threads: { thread: { sessionId: 'session', running: false,
                  conversation: [request] } }
              } } }, React.createElement(LiteratureAuthorizationNode, { cardId: 'result' }, 'Literature list'))));
          }
          export function renderHostedCard(content, component, conversation = []) {
            return renderToStaticMarkup(React.createElement(I18nextProvider,
              { i18n: createLocalization('zh', resources) },
              React.createElement(StoreContext.Provider, { value: { act: {}, state: {
                activeSession: 'thread', projects: [], threads: { thread: { sessionId: 'session', conversation } }
              } } }, React.createElement(LiteratureCard, { type: 'literature-search', cardId: 'result', content, component }))));
          }
          export function renderReview(content) {
            return renderToStaticMarkup(React.createElement(I18nextProvider,
              { i18n: createLocalization('zh', resources) },
              React.createElement(LiteratureReviewCard, { content, ports: { openResults: async () => {} } })));
          }
          export function renderReport(language, criteriaData, authorization) {
            const result = { schema_version: '1.0', session_id: 'session', status: 'no_confident_match',
              retained: 0, candidates: 0, deduplicated: 0, papers: [], sources: [], warnings: [], ...criteriaData };
            const View = ({query, output}) => React.createElement('pre', null, query + '\\n' + output);
            return renderToStaticMarkup(React.createElement(I18nextProvider,
              { i18n: createLocalization(language, resources) }, React.createElement(ResultReport, {result, View, authorization})));
          }
          export function renderSearchReport(authorization, language = 'zh', origin = 'precise-search', authors = [], saved = []) {
            const result = {schema_version: '1.0', session_id: 'session', status: 'success',
              origin,
              retained: 2, candidates: 2, deduplicated: 2, criteria: [], sources: [], warnings: [],
              papers: ['one', 'two'].map(id => ({id, title: 'Paper ' + id, authors, year: 2025,
                reasons: ['Reason ' + id], abstract: 'Abstract ' + id, sources: [], access: 'unknown'}))};
            const View = props => React.createElement(SearchSurface, {...props, actions: {
              receipts: new Map(),
              Join: ({papers, selection}) => React.createElement(React.Fragment, null,
                React.createElement('output', { id: 'joinable-count' }, papers.length),
                React.createElement('output', {
                  id: 'joinable',
                  'data-selection': selection ? selection.count + '/' + selection.total : undefined,
                }, papers.map(paper => paper.paper_id).join(','))),
              openSource: async () => undefined
            }});
            return renderToStaticMarkup(React.createElement(I18nextProvider,
              {i18n: createLocalization(language, resources)}, React.createElement(ToastProvider, null,
                React.createElement(ResultReport, {result, View, authorization, saved}))));
          }
          export function render(language, warnings, authorization, criteriaData = {}) {
            const content = { schema_version: '1.0', session_id: 'session', status: 'success',
              context: { authorization },
              selection: { artifact_id: 'selection' }, retained: 40, candidates: 40,
              criteria: ['Review'], sources: [], warnings,
              papers: Array.from({ length: 3 }, (_, index) => ({ id: String(index), title: 'Paper ' + index,
                authors: [], year: 2025, reasons: [], sources: [], access: 'unknown' })), ...criteriaData };
            return renderToStaticMarkup(React.createElement(I18nextProvider,
              { i18n: createLocalization(language, resources) },
              React.createElement(LiteratureResults, { content, ports: {
                openResults: async () => undefined, openSource: async () => undefined
              } })));
          }
        `,
        resolveDir: desktop,
        loader: 'ts',
      },
      outfile: output,
      bundle: true,
      platform: 'node',
      nodePaths: [join(desktop, 'node_modules')],
      format: 'esm',
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      jsx: 'automatic',
      define: { 'import.meta.env.DEV': 'false' },
      loader: { '.png': 'dataurl', '.svg': 'dataurl', '.webp': 'dataurl', '.gif': 'dataurl' },
      plugins: [
        {
          name: 'dependencies',
          setup(builder) {
            builder.onResolve({ filter: /^[^./]/ }, async (args) => {
              if (args.path.endsWith('.css')) return
              if (args.pluginData?.resolving) return
              if (args.kind === 'dynamic-import' && !args.path.startsWith('@openuidev/'))
                return { path: args.path, external: true }
              const resolved = await builder.resolve(args.path, {
                resolveDir: args.resolveDir,
                kind: args.kind,
                pluginData: { resolving: true },
              })
              return { ...resolved, external: !args.path.startsWith('@openuidev/') }
            })
          },
        },
        {
          name: 'styles',
          setup(builder) {
            builder.onResolve({ filter: /\.css$/ }, (args) => ({
              path: args.path,
              namespace: 'styles',
            }))
            builder.onLoad({ filter: /.*/, namespace: 'styles' }, () => ({
              contents: '',
              loader: 'js',
            }))
          },
        },
      ],
    })
    const {
      render,
      renderReport,
      renderReview,
      renderReceipt,
      renderNode,
      renderHostedCard,
      renderSearchReport,
    } = await import(pathToFileURL(output).href)
    await context.test('review receipt exposes both open targets without preview actions', () => {
      const { data } = JSON.parse(
        readFileSync(
          join(desktop, '../../skills/community/literature-review/components/review.json'),
          'utf8'
        )
      )
      const markup = renderReview({ ...data, title: 'Review topic' })
      assert.match(markup, /Review topic/)
      assert.match(markup, /综述核对/)
      assert.match(markup, /lucide-book-open-check/)
      assert.match(markup, />查看<\/button>/)
      assert.match(markup, /data-testid="artifact-open-default"/)
      assert.match(markup, /data-testid="artifact-open"/)
      assert.equal(markup.match(/<button\b/g)?.length, 2)
      assert.doesNotMatch(markup, /范围与交付|receipt-preview|artifact-more-actions/)
    })
    await context.test(
      'joined rows count as checked but cannot be submitted again',
      () => {
        const mixed = renderSearchReport(undefined, 'zh', 'precise-search', [], ['one'])
        assert.match(mixed, /aria-checked="true" aria-label="选择 Paper one"[^>]*disabled=""/)
        assert.match(mixed, /aria-checked="true" aria-label="选择 Paper two"[^>]*role="checkbox"/)
        assert.doesNotMatch(mixed, /aria-label="选择 Paper two"[^>]*disabled=""/)
        assert.match(mixed, /<output id="joinable-count">1<\/output>/)
        assert.match(mixed, /<output id="joinable" data-selection="2\/2">two<\/output>/)

        const joined = renderSearchReport(undefined, 'zh', 'precise-search', [], ['one', 'two'])
        assert.match(
          joined,
          /aria-checked="false" aria-label="选择当前筛选的全部结果"[^>]*disabled=""/
        )
        assert.match(joined, /<output id="joinable" data-selection="2\/2"><\/output>/)
      }
    )
    await context.test('approval receipts preserve the server-owned decision source', () => {
      for (const [decisionSource, expected] of [
        ['auto_delegated', /自动策略已批准全文访问/],
        [undefined, /全文授权已记录，批准来源待核对/],
      ] as const) {
        const historical = renderNode('一键授权', { decisionSource })
        assert.match(historical, expected)
        assert.doesNotMatch(historical, /用户已授权文献/)
        const receipt = renderReceipt('一键授权', ['paper:p1'], 'precise', {}, { decisionSource })
        assert.match(receipt, expected)
        assert.doesNotMatch(receipt, /用户授权读取文献/)
      }
    })
    await context.test('cancelled authorization receipts never imply a grant or rejection', () => {
      for (const answer of ['', '一键授权', '拒绝', '不读取全文，并停止本次全文处理。']) {
        const markup = renderReceipt(answer, ['paper:p1'], 'precise', {}, { cancelled: true })
        assert.match(markup, /全文授权已取消/)
        assert.doesNotMatch(markup, /用户已授权文献|用户未授权文献|重新授权/)
      }
      assert.match(renderNode('一键授权', { hilState: 'cancelled' }), /全文授权已取消/)
    })
    for (const status of ['pending', 'rejected', 'unknown']) {
      const candidate = renderSearchReport({ status, selectedIds: ['paper:two'] })
      assert.match(candidate, /Paper one/)
      assert.match(candidate, /Reason one/)
      assert.doesNotMatch(candidate, /Abstract one|Abstract two|>摘要</)
    }
    const authorized = renderSearchReport({ status: 'authorized', selectedIds: ['paper:two'] })
    assert.match(authorized, />摘要</)
    assert.match(authorized, /Abstract two/)
    assert.doesNotMatch(authorized, /Abstract one/)
    assert.match(authorized, /Reason one/)
    assert.match(authorized, /Paper one/)
    const englishResults = renderSearchReport(
      { status: 'authorized', selectedIds: ['one', 'two'] },
      'en'
    )
    assert.match(englishResults, />Abstract</)
    assert.match(englishResults, /Abstract one/)
    const unresolvedScope = renderSearchReport({ status: 'authorized' })
    assert.doesNotMatch(unresolvedScope, /Abstract one|Abstract two|>摘要</)
    const twoAuthors = renderSearchReport(undefined, 'en', 'precise-search', [
      'First author',
      'Second author',
    ])
    assert.match(twoAuthors, />First author, Second author</)
    const threeAuthors = renderSearchReport(undefined, 'en', 'precise-search', [
      'First author',
      'Second author',
      'Third author',
    ])
    assert.match(threeAuthors, />First author<[^]*?>et al\.</)
    assert.doesNotMatch(threeAuthors, />First author, Second author</)
    const citedResults = renderSearchReport(
      { status: 'authorized', selectedIds: ['paper:two'] },
      'zh',
      'research-idea-citations'
    )
    assert.match(renderReport('zh', { origin: 'research-idea-citations' }), /实际引用文献/)
    assert.match(citedResults, /<output id="joinable-count">2<\/output>/)
    assert.match(citedResults, /<output id="joinable" data-selection="2\/2">one,two<\/output>/)
    assert.match(citedResults, /Paper two|Reason two/)
    assert.doesNotMatch(citedResults, /Abstract one|Abstract two|>摘要</)
    const pendingNode = renderNode()
    assert.match(pendingNode, /role="status"[\s\S]*icon-qingqiupizhun[\s\S]*等待用户授权/)
    assert.doesNotMatch(pendingNode, /turn-activity-trigger|aria-expanded/)
    assert.match(pendingNode, /data-testid="literature-authorization-result">Literature list/)
    assert.match(
      renderNode('一键授权'),
      /data-testid="turn-activity-trigger"[\s\S]*icon-qingqiupizhun[\s\S]*用户已授权文献/
    )
    assert.doesNotMatch(renderNode('一键授权'), /重新授权|literature-authorization-receipt/)
    const rejectedNode = renderNode('拒绝')
    assert.match(
      rejectedNode,
      /data-testid="turn-activity-trigger"[\s\S]*icon-qingqiupizhun[\s\S]*用户未授权文献/
    )
    assert.match(rejectedNode, /重新授权/)
    assert.match(rejectedNode, /h-\[var\(--vds-control-height-xs\)\]/)
    assert.doesNotMatch(renderNode('一键授权', { hilState: 'unknown' }), /用户已授权文献|重新授权/)
    assert.match(
      renderNode('一键授权', { hilState: 'unknown' }),
      /role="alert"[\s\S]*授权结果待核对/
    )
    assert.match(renderNode('一键授权', { timedOut: true }), /文献授权超时/)
    assert.match(renderNode('拒绝', {}, 'en'), /User did not authorize access to papers/)
    const linkedQuestion = {
      id: 'precise-search-fulltext:q',
      header: '精准检索授权',
      question: 'Read?',
      resultCardId: 'result',
      options: [{ label: '一键授权' }, { label: '拒绝' }],
      papers: [{ id: 'paper:p1', label: 'Paper One' }],
    }
    const linkedCard = {
      kind: 'display_card',
      card: {
        cardId: 'result',
        type: 'literature-search',
        content: {
          schema_version: '1.0',
          session_id: 'session',
          status: 'success',
          selection: { artifact_id: 'selection' },
          papers: [],
          criteria: [],
          sources: [],
          warnings: [],
        },
      },
    }
    assert.equal(
      renderReceipt(
        '一键授权',
        undefined,
        'precise',
        { conversation: [linkedCard] },
        { questions: [linkedQuestion] }
      ),
      ''
    )
    const component = {
      plugin: 'host',
      component: 'display.literature-search',
      fingerprint: 'test',
    }
    assert.equal(
      renderReceipt(
        '拒绝',
        undefined,
        'precise',
        { conversation: [{ ...linkedCard, card: { ...linkedCard.card, component } }] },
        { questions: [linkedQuestion] }
      ),
      ''
    )
    assert.match(
      renderHostedCard(linkedCard.card.content, component),
      /literature-authorization-node/
    )
    assert.match(renderHostedCard(linkedCard.card.content, component), /授权结果待核对/)
    assert.doesNotMatch(renderHostedCard(linkedCard.card.content, component), /等待用户授权/)
    assert.match(renderHostedCard(linkedCard.card.content, component), /data-artifact-receipt/)
    assert.doesNotMatch(renderHostedCard(linkedCard.card.content, component), /receipt-toggle/)
    assert.match(renderHostedCard(linkedCard.card.content, component), /vds-card--bordered/)
    const unselected = { ...linkedCard.card.content, selection: undefined }
    assert.match(
      renderHostedCard(unselected, component, [{ kind: 'hil', questions: [linkedQuestion] }]),
      /data-artifact-receipt/
    )
    assert.match(renderHostedCard(unselected), /data-artifact-receipt/)
    assert.doesNotMatch(renderHostedCard(unselected), /literature-authorization-node/)
    const quick = {
      ...linkedCard.card.content,
      origin: 'literature-review',
      fulltext_authorization: { disposition: 'not_required', evidence_kind: 'abstract' },
    }
    assert.doesNotMatch(renderHostedCard(quick), /literature-authorization-node|等待用户授权/)
    assert.match(renderHostedCard(quick), /data-artifact-receipt/)
    for (const fulltext_authorization of [
      undefined,
      {},
      { disposition: 'not_required', evidence_kind: 'fulltext' },
      { disposition: 'authorized', evidence_kind: 'abstract' },
    ]) {
      const unknown = renderHostedCard({ ...quick, fulltext_authorization })
      assert.match(unknown, /literature-authorization-node/)
      assert.match(unknown, /授权结果待核对/)
      assert.doesNotMatch(unknown, /等待用户授权|用户已授权文献/)
    }
    assert.match(
      renderHostedCard({ ...quick, origin: 'precise-search' }),
      /literature-authorization-node/
    )
    for (const [hilState, answer, label] of [
      ['pending', undefined, '等待用户授权'],
      ['resolved', '一键授权', '用户已授权文献'],
      ['resolved', '拒绝', '用户未授权文献'],
      ['cancelled', '一键授权', '全文授权已取消'],
      ['unknown', '一键授权', '授权结果待核对'],
    ]) {
      const request = {
        kind: 'hil',
        requestId: 'real-authorization',
        hilKind: 'question',
        hilState,
        questions: [linkedQuestion],
        answers: answer ? { [linkedQuestion.id]: answer } : {},
        selectedPaperIds: ['paper:p1'],
        decisionSource: 'user_explicit',
      }
      const withRequest = renderHostedCard(quick, undefined, [request])
      assert.match(withRequest, /literature-authorization-node/)
      assert.ok(withRequest.includes(label), String(hilState))
    }
    const selectedReport = { selection: { artifact_id: 'selection' } }
    assert.match(renderReport('zh', selectedReport, { status: 'pending' }), /待授权使用/)
    for (const status of ['unknown', 'authorized', 'rejected'])
      assert.doesNotMatch(renderReport('zh', selectedReport, { status }), /待授权使用/)
    assert.doesNotMatch(renderReport('zh', selectedReport), /待授权使用/)
    const ideaQuestion = {
      ...linkedQuestion,
      id: 'research-idea-fulltext:q',
      header: '想法原文授权',
      papers: undefined,
    }
    const ideaConversation = [
      { ...linkedCard, card: { ...linkedCard.card, content: unselected } },
      {
        kind: 'hil',
        requestId: ideaQuestion.id,
        questions: [ideaQuestion],
        hilState: 'resolved',
        decisionSource: 'user_explicit',
        answers: { [ideaQuestion.id]: '一键授权' },
      },
    ]
    assert.match(renderHostedCard(unselected, component, ideaConversation), /用户已授权文献/)
    assert.equal(
      renderReceipt(
        '一键授权',
        undefined,
        'research-idea',
        { conversation: ideaConversation },
        { questions: [ideaQuestion] }
      ),
      ''
    )
    for (const timedOut of [false, true]) {
      const declinedConversation = ideaConversation.map((item) =>
        item.kind === 'hil' ? { ...item, timedOut, answers: { [ideaQuestion.id]: '拒绝' } } : item
      )
      assert.equal(
        renderReceipt(
          '拒绝',
          undefined,
          'research-idea',
          { conversation: declinedConversation },
          { questions: [ideaQuestion], timedOut }
        ),
        ''
      )
    }
    assert.match(
      renderReceipt(
        '拒绝',
        undefined,
        'precise',
        { conversation: [] },
        { questions: [linkedQuestion] }
      ),
      /重新授权/
    )
    assert.match(
      renderReceipt(
        '拒绝',
        undefined,
        'precise',
        { conversation: [{ ...linkedCard, card: { ...linkedCard.card, content: {} } }] },
        { questions: [linkedQuestion] }
      ),
      /重新授权/
    )
    const receipt = renderReceipt('一键授权', ['paper:p2'])
    assert.match(receipt, /data-testid="turn-activity-trigger"[\s\S]*用户已授权文献/)
    assert.doesNotMatch(receipt, /查看本次全部|<h3/)
    assert.doesNotMatch(receipt, /重新授权/)
    const denied = renderReceipt('拒绝')
    assert.match(denied, /未授权文献/)
    assert.match(denied, /已停止/)
    assert.match(denied, /重新授权/)
    const unconfirmed = renderReceipt('unknown')
    assert.match(unconfirmed, /授权结果待核对/)
    assert.doesNotMatch(unconfirmed, /已授权文献|重新授权/)
    for (const kind of ['literature-review', 'research-idea']) {
      const rejected = renderReceipt('拒绝', undefined, kind)
      assert.match(rejected, /用户未授权文献/)
      assert.match(rejected, /重新授权/)
      assert.doesNotMatch(rejected, /查看全部|Paper One|<h3/)
      const granted = renderReceipt('一键授权', undefined, kind)
      assert.match(granted, /用户已授权文献/)
      assert.doesNotMatch(granted, /重新授权/)
      assert.doesNotMatch(renderReceipt('unknown', undefined, kind), /重新授权/)
      assert.doesNotMatch(
        renderReceipt('拒绝', undefined, kind, {}, { timedOut: true }),
        /重新授权|用户拒绝读取文献/
      )
      const english = renderReceipt('拒绝', undefined, kind, {}, {}, 'en')
      assert.match(english, /data-testid="literature-reauthorize"/)
      assert.doesNotMatch(english, /重新授权|用户拒绝读取文献/)
      for (const flags of [{ running: true }, { readOnly: true }]) {
        assert.match(renderReceipt('拒绝', undefined, kind, flags), /disabled=""/)
      }
    }
    const diagnostic = 'agentic-search used degraded retrieval (source_mode=web_only)'
    const chinese = render('zh', [diagnostic])
    assert.match(chinese, /检索结果/)
    assert.match(chinese, /data-testid="receipt-preview"[\s\S]*title="Paper 2">Paper 2</)
    assert.doesNotMatch(chinese, /本次仅使用网页来源检索|agentic-search|source_mode/)
    for (const status of ['authorized', 'rejected', 'unknown']) {
      const receipt = render('zh', [], { status, selectedIds: ['paper:1'] })
      assert.match(receipt, /检索结果/)
      assert.match(receipt, /data-testid="receipt-preview"[\s\S]*title="Paper 1">Paper 1</)
      assert.doesNotMatch(receipt, /待授权文献/)
    }
    const english = render('en', [diagnostic])
    assert.match(english, /aria-label="Open search results"/)
    assert.match(english, /Papers found: 40/)
    assert.doesNotMatch(english, /agentic-search|source_mode|web_only/)
    const unknown = render('zh', ['private-tool raw_parameter=private-value'])
    assert.match(unknown, /检索结果/)
    assert.doesNotMatch(unknown, /private-tool|raw_parameter|private-value/)
    const criteriaData = {
      criteria: ['年份：2023–不限', '本轮结果上限：1 篇'],
      criteria_details: [
        { kind: 'years', text: '年份：2023–不限', values: ['2023', ''] },
        { kind: 'limit', text: '本轮结果上限：1 篇', values: ['1'] },
      ],
    }
    const frozen = JSON.stringify(criteriaData)
    const englishReport = renderReport('en', criteriaData)
    assert.match(englishReport, /Years: 2023–Any/)
    assert.match(englishReport, /Result limit: 1 paper/)
    assert.doesNotMatch(englishReport, /年份|不限|本轮结果上限/)
    const englishCard = render('en', [], undefined, criteriaData)
    assert.match(englishCard, /aria-label="Open search results"/)
    assert.match(englishCard, /Papers found: 40/)
    assert.doesNotMatch(englishCard, /年份|不限/)
    assert.match(renderReport('zh', criteriaData), /年份：2023–不限/)
    assert.match(render('zh', [], undefined, criteriaData), /检索结果/)
    assert.match(renderReport('en', { criteria: criteriaData.criteria }), /年份：2023–不限/)
    assert.equal(JSON.stringify(criteriaData), frozen)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
