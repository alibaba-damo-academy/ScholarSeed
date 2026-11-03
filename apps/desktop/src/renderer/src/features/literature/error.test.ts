import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fulltextFailureMessageKey,
  literatureErrorMessage,
  literatureTaskErrorMessage,
  literatureTaskStatusMessage,
  searchFailureMessageKey,
} from './error.ts'
import { readFileSync } from 'node:fs'
import { createInstance } from 'i18next'

test('search artifact and target failures have distinct bilingual explanations', async () => {
  const engine = createInstance()
  await engine.init({
    lng: 'zh',
    fallbackLng: false,
    resources: {
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
    },
  })
  for (const code of [
    'literature_search_result_missing',
    'literature_search_result_invalid',
    'literature_search_result_ambiguous',
    'fast_search_target_unresolved',
    'fast_search_target_not_found',
  ]) {
    const key = searchFailureMessageKey(code)
    assert.ok(key)
    const zh = engine.getFixedT('zh', 'literature')(key)
    const en = engine.getFixedT('en', 'literature')(key)
    assert.notEqual(zh, en)
    assert.notEqual(en, key)
  }
})

test('known Zotero failures retain a language-neutral message identity', () => {
  assert.deepEqual(
    literatureErrorMessage('ZOTERO_UNAVAILABLE', '服务端中文提示', 'zotero.connectionFailed'),
    {
      key: 'operationError.ZOTERO_UNAVAILABLE',
    }
  )
})

test('unknown errors and prototype-like codes use the localized fallback', () => {
  for (const code of ['VENDOR_NEW_ERROR', '__proto__', 'toString', undefined]) {
    assert.deepEqual(
      literatureErrorMessage(code, 'Original 原始 diagnostic', 'zotero.importFailed'),
      {
        key: 'zotero.importFailed',
        detail: undefined,
      }
    )
  }
  assert.deepEqual(literatureErrorMessage(undefined, undefined, 'zotero.connectionFailed'), {
    key: 'zotero.connectionFailed',
    detail: undefined,
  })
})

// Missing server diagnostics must use the localized operation message.
test('empty transport diagnostics do not replace the localized fallback', () => {
  assert.deepEqual(literatureErrorMessage('REQUEST_FAILED', '', 'pdfImport.parseFailed'), {
    key: 'pdfImport.parseFailed',
    detail: undefined,
  })
})

test('import task status and application errors translate without rewriting task data', async () => {
  const engine = createInstance()
  await engine.init({
    lng: 'zh',
    fallbackLng: false,
    resources: {
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
    },
  })
  for (const status of ['queued', 'running', 'completed', 'failed', 'cancelled', 'vendor_state']) {
    const key = literatureTaskStatusMessage(status)
    const zh = engine.getFixedT('zh', 'literature')(key)
    const en = engine.getFixedT('en', 'literature')(key)
    assert.notEqual(zh, en)
    assert.notEqual(en, key)
  }
  assert.equal(literatureTaskStatusMessage('__proto__'), 'importTask.status.unknown')
  const task = { status: 'failed', error_code: 'ZOTERO_UNAVAILABLE', error: '原始中文诊断' }
  const before = structuredClone(task)
  const message = literatureTaskErrorMessage(task)
  assert.deepEqual(message, { key: 'operationError.ZOTERO_UNAVAILABLE' })
  assert.notEqual(
    engine.getFixedT('zh', 'literature')(message.key),
    engine.getFixedT('en', 'literature')(message.key)
  )
  assert.deepEqual(task, before)
  assert.deepEqual(literatureTaskErrorMessage({ error_code: 'NEW_CODE', error: '原始诊断' }), {
    key: 'importTask.failed',
    detail: undefined,
  })
  assert.deepEqual(literatureTaskErrorMessage({ error_code: 'NEW_CODE' }), {
    key: 'importTask.failed',
    detail: undefined,
  })
  assert.deepEqual(literatureTaskErrorMessage({ error: '旧诊断' }), {
    key: 'importTask.failed',
    detail: undefined,
  })
  assert.deepEqual(
    literatureTaskErrorMessage({ error_code: 'ZOTERO_IMPORT_FAILED', error: 'Zotero 导入失败' }),
    { key: 'importTask.failed' }
  )
})

/** 全文结果的中英文文案必须与产品口径一致。 */
const FULLTEXT_OUTCOMES = [
  ['FULLTEXT_NOT_FOUND', 'detail.fulltextNotFound', '未找到全文', 'Not found'],
  ['FULLTEXT_NO_ACCESS', 'detail.fulltextNoAccess', '无法访问', 'Unable to access'],
  ['FULLTEXT_RATE_LIMITED', 'detail.fulltextRateLimited', '请求被限流', 'Rate limited'],
  ['FULLTEXT_TIMEOUT', 'detail.fulltextTimeout', '下载超时，请稍后重试', 'Download timed out. Please try again.'],
] as const

test('a full-text failure reports exactly one of four localized outcomes', async () => {
  const engine = createInstance()
  await engine.init({
    lng: 'zh',
    fallbackLng: false,
    resources: {
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
    },
  })
  const zh = engine.getFixedT('zh', 'literature')
  const en = engine.getFixedT('en', 'literature')

  for (const [code, key, zhText, enText] of FULLTEXT_OUTCOMES) {
    assert.equal(fulltextFailureMessageKey(code), key)
    assert.equal(zh(key), zhText)
    assert.equal(en(key), enText)
  }
})

test('anything outside the known outcomes still reports not found', () => {
  // 前置校验码、渲染层自己的网络错误、原型链上的假码、以后新增的服务端码: 全部收敛成
  // 「未找到全文」, 绝不能把原始 code 或单语诊断甩给用户。
  const codes = [
    'ARXIV_INVALID',
    'DOI_INVALID',
    'FULLTEXT_IDENTIFIER_MISSING',
    'ARXIV_ALREADY_ATTACHED',
    'REQUEST_FAILED',
    'SOME_FUTURE_CODE',
    '__proto__',
    'toString',
    '',
    null,
    undefined,
  ]
  for (const code of codes) {
    assert.equal(fulltextFailureMessageKey(code), 'detail.fulltextNotFound')
  }
})

test('the detail panel routes full-text failures through the mapping only', () => {
  const source = readFileSync(new URL('./LiteratureDetail.tsx', import.meta.url), 'utf8')
  const reject = source.slice(
    source.indexOf('const rejectFulltext'),
    source.indexOf('const fetchArxiv')
  )

  assert.match(reject, /fulltextFailureMessageKey\(/)
  // 服务端诊断回到这张卡就等于报错不止三种、也不再双语。
  assert.doesNotMatch(reject, /literatureErrorMessage/)
  assert.doesNotMatch(reject, /reason\.message/)
  assert.match(source, /failure \? literature\(failure\.key\) : undefined/)
})
