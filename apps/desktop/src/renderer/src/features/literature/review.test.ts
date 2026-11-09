import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import i18next, { createInstance } from 'i18next'

import type { ConvItem } from '../../model.ts'
import { latestDisplayCardItems } from '../../transcript.ts'
import {
  literatureRetrievalAuthorization,
  literatureReviewInteraction,
  preciseFulltextSubsetAuthorization,
  literatureCurationInteraction,
  literatureOutlineConfirmation,
} from './interaction.ts'
import {
  parseReview,
  reviewNotice,
  reviewIssueSummary,
  reviewStatus,
  reviewEvidenceReason,
  reviewSupersessionKey,
  REVIEW_VERDICTS,
} from './projection.ts'
import { reviewCopy } from './copy.ts'

const engine = createInstance()
const englishEngine = createInstance()
const resources = {
  zh: {
    literature: JSON.parse(
      readFileSync(
        new URL('../../../../localization/locales/zh/literature.json', import.meta.url),
        'utf8'
      )
    ),
  },
  en: {
    literature: JSON.parse(
      readFileSync(
        new URL('../../../../localization/locales/en/literature.json', import.meta.url),
        'utf8'
      )
    ),
  },
}
await engine.init({ lng: 'zh', fallbackLng: false, resources })
await englishEngine.init({ lng: 'en', fallbackLng: false, resources })
await i18next.init({ lng: 'zh', fallbackLng: false, resources })

test('outline confirmation localizes product copy without changing answers or publication text', () => {
  const policy = literatureOutlineConfirmation
  assert.ok(policy)
  const question = {
    id: 'outline-review:owned',
    header: '大纲与输出设置确认',
    question: '原始中文问题',
    options: [{ label: '按当前方案开始撰写', description: '使用当前大纲和输出设置。' }],
    presentation: {
      kind: 'literature-outline-confirmation',
      format: 'PDF: English typesetting',
      citation_style: 'Numbered references',
      timeout_seconds: 300,
    },
  }
  assert.equal(policy.matches([question]), true)
  const english = policy.presentQuestion!(question, englishEngine)
  assert.match(english.question, /Output format: PDF: English typesetting/)
  assert.match(english.question, /Citation style: Numbered references/)
  assert.match(english.question, /5 minutes/)
  assert.doesNotMatch(english.question, /[\p{Script=Han}]/u)
  assert.equal(english.options[0].label, 'Start writing with the current plan')
  assert.equal(english.options[0].description, 'Use the current outline and output settings.')
  assert.equal(question.options[0].label, '按当前方案开始撰写')
  assert.equal(
    policy.presentAnswer!(question, '按当前方案开始撰写', englishEngine),
    english.options[0].label
  )
  assert.equal(policy.presentAnswer!(question, '请调整第二章', englishEngine), '请调整第二章')
  assert.equal(
    policy.presentAnswer!(question, '按当前方案开始撰写\n请调整第二章', englishEngine),
    '按当前方案开始撰写\n请调整第二章'
  )
  const required = {
    ...question,
    presentation: { ...question.presentation, timeout_seconds: null },
  }
  const requiredEnglish = policy.presentQuestion!(required, englishEngine)
  assert.match(requiredEnglish.question, /Writing will start only after confirmation/)
  assert.doesNotMatch(requiredEnglish.question, /minutes|no reply/)
  const chinese = policy.presentQuestion!(question, engine)
  assert.match(chinese.question, /请在 5 分钟内确认/)
  assert.match(chinese.question, /PDF: English typesetting/)
  assert.equal(chinese.options[0].label, question.options[0].label)
  assert.equal(policy.matches([{ ...question, presentation: undefined }]), false)
  assert.equal(policy.matches([{ ...question, id: 'user-question' }]), false)
  assert.equal(policy.matches([{ ...question, options: [{ label: '用户选项' }] }]), false)
  for (const presentation of [
    { ...question.presentation, kind: 'unknown' },
    { ...question.presentation, timeout_seconds: 1 },
    { ...question.presentation, format: null },
    { ...question.presentation, citation_style: '' },
  ])
    assert.equal(policy.matches([{ ...question, presentation: presentation as never }]), false)
  assert.equal(
    policy.presentQuestion!({ ...question, presentation: undefined }, englishEngine).question,
    question.question
  )
})

test('curation confirmation localizes presentation while retaining canonical answers', () => {
  const policy = literatureCurationInteraction
  const question = {
    id: 'literature-curation-owned',
    header: '文献库操作确认',
    question: '中文原始问题',
    options: [{ label: '确认执行' }, { label: '取消' }],
    presentation: {
      kind: 'literature-curation',
      operation: 'delete',
      count: 1,
      titles: ['用户标题'],
    },
  }
  assert.equal(policy.matches([question]), true)
  const presented = policy.presentQuestion!(question, englishEngine)
  assert.equal(presented.header, 'Literature library confirmation')
  assert.match(presented.question, /delete/)
  assert.match(presented.question, /用户标题/)
  assert.equal(presented.options[0].label, 'Confirm execution')
  assert.equal(question.options[0].label, '确认执行')
  assert.equal(policy.presentAnswer!(question, '取消', englishEngine), 'Cancel')
  assert.equal(policy.matches([{ ...question, presentation: undefined }]), false)
  assert.equal(
    policy.matches([{ ...question, presentation: { ...question.presentation, count: -1 } }]),
    false
  )
  assert.equal(policy.presentAnswer!(question, '用户原文', englishEngine), '用户原文')
  assert.equal(
    typeof policy.title === 'function' ? policy.title(englishEngine) : policy.title,
    'Literature library confirmation'
  )
  assert.equal(
    typeof policy.title === 'function' ? policy.title(engine) : policy.title,
    '文献库操作确认'
  )
  for (const presentation of [
    null,
    { ...question.presentation, kind: 'unknown' },
    { ...question.presentation, operation: null },
    { ...question.presentation, count: 1.5 },
    { ...question.presentation, count: Infinity },
    { ...question.presentation, titles: [null] },
  ])
    assert.equal(policy.matches([{ ...question, presentation: presentation as never }]), false)
  assert.equal(policy.matches([{ ...question, id: 'unrelated' }]), false)
  assert.equal(policy.matches([{ ...question, multiSelect: true }]), false)
  assert.equal(
    policy.matches([{ ...question, options: [{ label: '确认执行' }, { label: '确认执行' }] }]),
    false
  )
  assert.equal(
    policy.matches([
      { ...question, options: [{ label: 'Confirm execution' }, { label: 'Cancel' }] },
    ]),
    false
  )
  assert.equal(policy.matches([question, question]), false)
  assert.equal(
    policy.presentQuestion!({ ...question, presentation: undefined }, englishEngine).question,
    question.question
  )
  assert.equal(
    policy.presentAnswer!(question, '确认执行\n用户补充', englishEngine),
    '确认执行\n用户补充'
  )
})

const snapshot = {
  schema_version: '1.1',
  session_id: 'session',
  workspace: 'survey',
  title: '研究方法',
  intent: '比较方法边界',
  checkpoint: 'outline',
  status: 'outline',
  generation_status: null,
  scope: {
    topic: '研究方法',
    time_range: '2021–2026',
    focus: ['方法演进'],
    requested_materials: [],
    project_materials: 1,
    external_materials: 1,
  },
  output: { format: null, citation_style: null, decided_by: null },
  included: 2,
  fulltext: null,
  abstract_only: null,
  pending_checks: null,
  cited: null,
  section_count: 1,
  sections: [
    {
      id: '1',
      title: '方法',
      description: '',
      papers: 2,
      children: ['条件'],
      comparison_tables: [],
    },
  ],
  citations: [],
  abstract_evidence: [],
  issues: [],
  warnings: [],
  checks: [],
  source_hashes: { 'survey/outline.md': 'digest' },
  artifacts: [
    {
      artifact_id: 'outline',
      path: 'survey/outline.md',
      name: 'outline.md',
      title: '完整大纲',
      sha256: 'digest',
    },
  ],
}

test('review preserves unknown coverage and original artifact identities', () => {
  assert.equal(parseReview(snapshot)?.fulltext, null)
  assert.equal(parseReview(snapshot)?.artifacts[0].artifact_id, 'outline')
  assert.equal(parseReview({ ...snapshot, schema_version: '2.0' }), null)
})

test('abstract evidence localizes application reasons in cards and copied text', () => {
  const reasons = [
    [
      'not_in_paperhub',
      '全文来源暂未返回可下载文件，仅使用摘要证据',
      'The full-text source has not returned a downloadable file; only abstract-level evidence is used.',
    ],
    ['auth_failed', '全文服务认证失败', 'Full-text service authentication failed.'],
    ['fetch_failed', '全文服务暂时不可用', 'The full-text service is temporarily unavailable.'],
    ['extract_failed', '全文解析失败', 'Full-text extraction failed.'],
    [
      'too_large',
      '全文文件超过可处理大小限制',
      'The full-text file exceeds the processing size limit.',
    ],
    ['not_a_pdf', '全文格式无法解析', 'The full-text format could not be parsed.'],
    [
      '',
      '未取得全文，只能支持题录或摘要层判断',
      'Full text is unavailable; only metadata or abstract-level judgments are supported.',
    ],
  ]
  for (const [code, chinese, english] of reasons) {
    for (const reason_code of [code, undefined]) {
      const evidence = {
        paper_id: 'p1',
        title: 'Original paper title',
        reason: chinese,
        reason_code,
      }
      const review = { ...snapshot, abstract_evidence: [evidence] }
      assert.ok(parseReview(review))
      for (const [localization, expected] of [
        [engine, chinese],
        [englishEngine, english],
      ] as const) {
        const translate = localization.getFixedT(null, 'literature')
        assert.equal(reviewEvidenceReason(evidence, translate), expected)
        const copied = reviewCopy(review, translate).text
        assert.ok(copied?.includes(expected))
        assert.ok(copied?.includes(evidence.title))
        if (localization === englishEngine) assert.ok(!copied?.includes(chinese))
      }
      assert.equal(evidence.reason, chinese)
    }
  }
})

test('abstract evidence preserves unrecognized source text and validates reason codes', () => {
  const evidence = { paper_id: 'p1', title: 'Paper', reason: '用户原文，不应翻译' }
  const translate = englishEngine.getFixedT(null, 'literature')
  assert.equal(reviewEvidenceReason(evidence, translate), evidence.reason)
  assert.equal(
    reviewEvidenceReason({ ...evidence, reason_code: 'extract_failed' }, translate),
    'Full-text extraction failed.'
  )
  for (const reason_code of ['unknown_outcome', 'constructor', '__proto__']) {
    assert.equal(
      reviewEvidenceReason({ ...evidence, reason_code }, translate),
      'Full text is unavailable; only metadata or abstract-level judgments are supported.'
    )
  }
  assert.equal(
    parseReview({ ...snapshot, abstract_evidence: [{ ...evidence, reason_code: 1 }] }),
    null
  )
})

test('review accepts GB/T 7714 alongside existing styles at both checkpoints', () => {
  for (const checkpoint of ['outline', 'result']) {
    for (const style of ['numeric', 'author_year', 'ieee', 'acm', 'gbt7714_2025', null]) {
      const review = parseReview({
        ...snapshot,
        checkpoint,
        output: { ...snapshot.output, citation_style: style },
      })
      assert.ok(review)
      assert.equal(review.output.citation_style, style)
    }
  }
  assert.equal(
    parseReview({ ...snapshot, output: { ...snapshot.output, citation_style: 'unsupported' } }),
    null
  )
})

test('the settled review replaces its outline while other workspaces remain visible', () => {
  const cards: ConvItem[] = [
    {
      kind: 'display_card',
      card: {
        cardId: 'outline-one',
        type: 'literature-review',
        content: { workspace: 'one', checkpoint: 'outline' },
      },
    },
    {
      kind: 'display_card',
      card: {
        cardId: 'outline-two',
        type: 'literature-review',
        content: { workspace: 'two', checkpoint: 'outline' },
      },
    },
    {
      kind: 'display_card',
      card: {
        cardId: 'failed-one',
        type: 'literature-review',
        content: { workspace: 'one', checkpoint: 'result', status: 'failed' },
      },
    },
    {
      kind: 'display_card',
      card: {
        cardId: 'recovered-one',
        type: 'literature-review',
        content: { workspace: 'one', checkpoint: 'result', status: 'generated' },
      },
    },
  ]

  const visible = latestDisplayCardItems(cards, (card) => reviewSupersessionKey(card.content))

  assert.deepEqual(
    visible.map((item) => (item.kind === 'display_card' ? item.card.cardId : '')),
    ['outline-two', 'recovered-one']
  )
  assert.equal(cards.length, 4)
  assert.equal(reviewSupersessionKey({ workspace: 'one', checkpoint: 'unknown' }), null)
})

test('malformed nested cards do not crash or hide original evidence', () => {
  for (const change of [
    { checks: [null] },
    { sections: [{ title: 'bad' }] },
    { artifacts: [{}] },
    { included: -1 },
    { status: 'toString' },
  ]) {
    assert.equal(parseReview({ ...snapshot, ...change }), null)
  }
})

test('historic derived status is not relabeled as a producer verdict', () => {
  const historic = parseReview({ ...snapshot, checkpoint: 'result', status: 'partial' })!
  assert.equal(reviewStatus(historic, engine.getFixedT('zh', 'literature')), '结果快照')
  assert.equal(
    reviewStatus(
      { ...historic, generation_status: 'SUCCESS' },
      engine.getFixedT('zh', 'literature')
    ),
    '生成报告：成功'
  )
})

test('generation and verification notices remain independent without rewriting evidence', () => {
  const result = parseReview({
    ...snapshot,
    checkpoint: 'result',
    status: 'generated',
    generation_status: 'SUCCESS',
  })!
  const before = structuredClone(result)
  assert.equal(reviewNotice(parseReview(snapshot)!), null)
  assert.equal(reviewNotice(result), 'verification')
  for (const verdict of ['WARN', 'FAIL', 'NOT_CHECKED'] as const) {
    assert.equal(
      reviewNotice({ ...result, checks: [{ title: 'Audit', verdict, reason: 'Producer reason' }] }),
      'verification'
    )
  }
  for (const verdict of ['PASS', 'NOT_APPLICABLE'] as const) {
    assert.equal(
      reviewNotice({ ...result, checks: [{ title: 'Audit', verdict, reason: '' }] }),
      null
    )
  }
  assert.equal(
    reviewNotice({
      ...result,
      issues: [{ title: 'Unresolved', detail: '', paper_ids: [], affected_content: '' }],
    }),
    'verification'
  )
  for (const generation_status of ['PARTIAL_SUCCESS', 'FAILED'] as const) {
    assert.equal(reviewNotice({ ...result, generation_status }), 'incomplete')
  }
  assert.equal(
    reviewNotice({ ...result, generation_status: null, status: 'incomplete' }),
    'incomplete'
  )
  assert.equal(reviewNotice({ ...result, generation_status: null }), 'verification')
  assert.deepEqual(result, before)
})

test('issue summaries disclose omitted entries and keep historical cards readable', () => {
  const issue = {
    title: 'Metadata',
    detail: 'Missing pages',
    paper_ids: ['Paper'],
    affected_content: 'References',
  }
  const card = parseReview({ ...snapshot, issues: [issue], issue_count: 40 })!
  assert.deepEqual(reviewIssueSummary(card), { total: 40, hidden: 39 })
  assert.deepEqual(reviewIssueSummary(parseReview({ ...snapshot, issues: [issue] })!), {
    total: 1,
    hidden: 0,
  })
  assert.deepEqual(
    reviewIssueSummary(parseReview({ ...snapshot, issues: [issue], issue_count: null })!),
    { total: 1, hidden: 0 }
  )
  for (const issue_count of [-1, 0, '40', 1.5]) {
    assert.equal(parseReview({ ...snapshot, issues: [issue], issue_count }), null)
  }
  for (const language of ['zh', 'en']) {
    const translator = engine.getFixedT(language, 'literature')
    assert.notEqual(
      translator('review.verificationPendingTitle'),
      'review.verificationPendingTitle'
    )
    assert.match(translator('review.moreIssues', { shown: 32, total: 41, count: 9 }), /32.*41.*9/)
  }
})

const outputQuestions = [
  {
    header: '综述输出格式',
    question: '请选择输出格式',
    options: [{ label: 'PDF' }, { label: 'Markdown' }],
  },
  {
    header: '综述引用格式',
    question: '请选择引用格式',
    options: [{ label: '通用数字顺序制' }, { label: '通用作者—年份制' }, { label: '出版社格式' }],
  },
]

test('SLR output policy requires every answer and records exact skip defaults', () => {
  assert.equal(literatureReviewInteraction.matches(outputQuestions), true)
  assert.equal(
    literatureReviewInteraction.complete(outputQuestions, { 0: ['Markdown'] }, {}),
    false
  )
  assert.equal(
    literatureReviewInteraction.complete(
      outputQuestions,
      { 0: ['Markdown'], 1: ['通用数字顺序制'] },
      {}
    ),
    true
  )
  assert.deepEqual(literatureReviewInteraction.defaults(outputQuestions), {
    综述输出格式: 'Markdown',
    综述引用格式: '通用数字顺序制',
  })
})

test('publisher follow-up stays inside IEEE and ACM and other HIL remains unmatched', () => {
  const publisher = [
    {
      header: '综述出版社格式',
      question: '请选择出版社格式',
      options: [{ label: 'IEEE' }, { label: 'ACM' }],
    },
  ]
  assert.equal(literatureReviewInteraction.matches(publisher), true)
  assert.equal(literatureReviewInteraction.complete(publisher, {}, {}), false)
  assert.equal(
    literatureReviewInteraction.matches([{ question: '继续吗', options: [{ label: '继续' }] }]),
    false
  )
})

test('all literature fulltext headers reuse the exact two-option one-click interaction', () => {
  for (const header of ['精准检索授权', '综述检索授权', '想法原文授权']) {
    const authorization = [
      {
        id: `${header}:challenge`,
        header,
        question: '是否允许读取已展示文献的全文？',
        options: [{ label: '一键授权 (Recommended)' }, { label: '拒绝' }],
      },
    ]
    assert.equal(literatureRetrievalAuthorization.matches(authorization), true, header)
    assert.deepEqual(
      authorization[0].options.map((option) =>
        literatureRetrievalAuthorization.optionLabel?.(option)
      ),
      ['一键授权', '拒绝'],
      header
    )
    assert.equal(
      literatureRetrievalAuthorization.directDecision?.(
        authorization[0],
        authorization[0].options[0]
      ),
      'respond',
      header
    )
    assert.equal(
      literatureRetrievalAuthorization.directDecision?.(
        authorization[0],
        authorization[0].options[1]
      ),
      'respond',
      header
    )
    assert.equal(literatureReviewInteraction.matches(authorization), false, header)
    assert.equal(
      literatureRetrievalAuthorization.matches([
        {
          ...authorization[0],
          options: [{ label: '一键授权 (Recommended)' }],
        },
      ]),
      false,
      header
    )
    assert.equal(
      literatureRetrievalAuthorization.matches([
        {
          ...authorization[0],
          options: [...authorization[0].options, { label: '稍后' }],
        },
      ]),
      false,
      header
    )
  }
  assert.equal(literatureRetrievalAuthorization.directPresentation, 'primary-secondary')
  assert.equal(
    literatureRetrievalAuthorization.cancelledLabel?.({
      header: '精准检索授权',
      question: '是否允许读取全文？',
      options: [],
    }),
    '已拒绝全文授权。本次任务已停止，未读取任何文献全文。'
  )
})

test('fulltext authorization receipts confirm scope without assuming the task', () => {
  const scenarios = [
    { prefix: 'precise-search-fulltext:', header: '精准检索授权' },
    { prefix: 'literature-review-fulltext:', header: '综述检索授权' },
    { prefix: 'research-idea-fulltext:', header: '想法原文授权' },
  ]
  const languages = [
    {
      localization: engine,
      granted: '用户已授权 AI 读取本次授权范围内的文献全文。',
      title: '用户授权读取文献',
      rejected: '暂不授权阅读文献全文。',
    },
    {
      localization: englishEngine,
      granted:
        'The user has authorized AI to read the full text of the papers covered by this authorization.',
      title: 'User authorized literature access',
      rejected: 'I do not authorize reading the full text of the papers at this time.',
    },
  ]
  for (const scenario of scenarios) {
    const question = {
      id: `${scenario.prefix}challenge`,
      header: scenario.header,
      question: '是否允许读取已展示文献的全文？',
      options: [{ label: '一键授权 (Recommended)' }, { label: '拒绝' }],
      papers: [{ id: 'paper:p1', label: 'Selected paper', description: 'Selected full text' }],
    }
    const original = structuredClone(question)
    const policies =
      scenario.prefix === 'precise-search-fulltext:'
        ? [literatureRetrievalAuthorization, preciseFulltextSubsetAuthorization]
        : [literatureRetrievalAuthorization]
    for (const policy of policies) {
      assert.equal(policy.matches([question]), true)
      for (const language of languages) {
        for (const answer of ['一键授权', '一键授权 (Recommended)']) {
          assert.equal(
            policy.replyText?.(question, answer, language.localization),
            language.granted
          )
          assert.equal(policy.replyTitle?.(question, answer, language.localization), language.title)
        }
        assert.equal(policy.replyText?.(question, '拒绝', language.localization), language.rejected)
        assert.equal(policy.replyText?.(question, '稍后', language.localization), undefined)
        assert.equal(policy.replyTitle?.(question, '拒绝', language.localization), undefined)
      }
    }
    assert.deepEqual(question, original)
  }
})

test('fulltext authorization localizes presentation without changing durable decision values', async () => {
  const scenarios = [
    [
      'precise-search-fulltext:',
      '精准检索授权',
      'Allow downloading, reading, and using the full text of the displayed papers as evidence?',
    ],
    [
      'literature-review-fulltext:',
      '综述检索授权',
      'Allow reading the full text of the displayed papers to continue the literature review?',
    ],
    [
      'research-idea-fulltext:',
      '想法原文授权',
      'Allow reading the full text of the displayed papers to generate evidence-grounded research ideas?',
    ],
  ]
  await engine.changeLanguage('en')
  try {
    for (const [prefix, header, expectedQuestion] of scenarios) {
      const question = {
        id: `${prefix}challenge`,
        header,
        question: '产品授权问题',
        options: [
          {
            label: '一键授权 (Recommended)',
            description: '允许在本次任务和已展示文献范围内读取全文。',
          },
          { label: '拒绝', description: '不读取全文，并停止本次全文处理。' },
        ],
      }
      const original = structuredClone(question)
      const presentation = literatureRetrievalAuthorization.presentQuestion?.(question, engine)
      assert.equal(presentation?.question, expectedQuestion)
      assert.deepEqual(
        presentation?.options.map((option) => option.label),
        ['Authorize', 'Deny']
      )
      assert.notEqual(presentation?.header, header)
      assert.deepEqual(
        presentation?.options.map((option) => option.description),
        [
          'Allow reading full text within this task and the displayed papers.',
          'Do not read full text, and stop full-text processing for this task.',
        ]
      )
      assert.equal(
        literatureRetrievalAuthorization.presentAnswer?.(question, '一键授权', engine),
        'Authorize'
      )
      assert.equal(
        literatureRetrievalAuthorization.presentAnswer?.(question, '拒绝', engine),
        'Deny'
      )
      assert.equal(
        literatureRetrievalAuthorization.presentAnswer?.(question, 'custom answer', engine),
        'custom answer'
      )
      assert.equal(literatureRetrievalAuthorization.optionLabel?.(question.options[0]), '一键授权')
      assert.equal(literatureRetrievalAuthorization.optionLabel?.(question.options[1]), '拒绝')
      assert.deepEqual(question, original)
      await engine.changeLanguage('zh')
      assert.equal(
        literatureRetrievalAuthorization.presentQuestion?.(question, engine).header,
        header
      )
      assert.equal(
        literatureRetrievalAuthorization.presentAnswer?.(question, '一键授权', engine),
        '一键授权'
      )
      assert.equal(
        literatureRetrievalAuthorization.presentAnswer?.(question, '拒绝', engine),
        '拒绝'
      )
      await engine.changeLanguage('en')
    }
  } finally {
    await engine.changeLanguage('zh')
  }
})

test('authorization presentation does not translate an unrelated question or user answer', () => {
  const question = {
    id: 'ordinary-question',
    header: '精准检索授权',
    question: '用户原文',
    options: [{ label: '一键授权' }, { label: '拒绝' }],
  }
  assert.deepEqual(literatureRetrievalAuthorization.presentQuestion?.(question, engine), question)
  assert.equal(
    literatureRetrievalAuthorization.presentAnswer?.(question, '一键授权', engine),
    '一键授权'
  )
})

test('review display translates snapshots, producer generation and verdicts without changing evidence', () => {
  const review = parseReview(snapshot)!
  const before = structuredClone(review)
  const zh = engine.getFixedT('zh', 'literature')
  const en = engine.getFixedT('en', 'literature')
  assert.equal(reviewStatus(review, en), 'Outline snapshot')
  for (const generation_status of ['SUCCESS', 'PARTIAL_SUCCESS', 'FAILED'] as const) {
    assert.notEqual(
      reviewStatus({ ...review, generation_status }, zh),
      reviewStatus({ ...review, generation_status }, en)
    )
  }
  for (const key of Object.values(REVIEW_VERDICTS)) {
    assert.notEqual(zh(key), en(key))
    assert.notEqual(en(key), key)
  }
  assert.deepEqual(review, before)
})

test('precise fulltext card with a paper subset uses the dedicated subset policy', () => {
  const papers = [
    { id: 'paper:p1', label: 'A-MEM', description: 'dynamic notes' },
    { id: 'paper:p2', label: 'Mem0', description: 'extract then merge' },
  ]
  const withSubset = [
    {
      id: 'precise-search-fulltext:abc',
      header: '精准检索授权',
      question: '是否允许下载、读取并使用已展示文献的全文作为证据？',
      options: [
        {
          label: '一键授权 (Recommended)',
          description: '允许在本次任务和已展示文献范围内读取全文。',
        },
        { label: '拒绝', description: '不读取全文，并停止本次全文处理。' },
      ],
      papers,
    },
  ] as const
  const withoutSubset = withSubset.map((question) => ({ ...question, papers: undefined }))
  assert.equal(preciseFulltextSubsetAuthorization.matches(withSubset as never), true)
  assert.equal(preciseFulltextSubsetAuthorization.matches(withoutSubset as never), false)
  // 无子集的旧形态仍走通用授权 policy，不被子集 policy 抢占。
  assert.equal(literatureRetrievalAuthorization.matches(withoutSubset as never), true)
  assert.equal(
    preciseFulltextSubsetAuthorization.directDecision?.(
      withSubset[0] as never,
      withSubset[0].options[0] as never
    ),
    'respond'
  )
  assert.equal(preciseFulltextSubsetAuthorization.directPresentation, 'primary-secondary')
  assert.equal(
    preciseFulltextSubsetAuthorization.directSelectionRequired?.(withSubset[0].options[0]),
    true
  )
  assert.equal(
    preciseFulltextSubsetAuthorization.directSelectionRequired?.(withSubset[0].options[1]),
    false
  )
  const presented = preciseFulltextSubsetAuthorization.presentQuestion?.(
    withSubset[0] as never,
    engine
  )
  assert.equal(
    presented?.header,
    engine.t('review.authorization.preciseHeader', { ns: 'literature' })
  )
  // 组合顺序：子集 policy 必须先于通用授权 policy 命中。
  const featureSource = readFileSync(new URL('./feature.tsx', import.meta.url), 'utf8')
  assert.match(
    featureSource,
    /interactionPolicies: \[\s*preciseFulltextSubsetAuthorization,\s*literatureRetrievalAuthorization/
  )
})
