import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createInstance } from 'i18next'

import { backendFailureMessage, updateInstallFailure, type BackendFailure } from './failure.ts'

const localization = createInstance()
await localization.init({
  lng: 'zh', fallbackLng: false, interpolation: { escapeValue: false },
  resources: Object.fromEntries(['zh', 'en'].map(language => [language, {
    foundation: JSON.parse(readFileSync(new URL(`../localization/locales/${language}/foundation.json`, import.meta.url), 'utf8'))
  }]))
})

const zh = localization.getFixedT('zh', 'foundation')
const en = localization.getFixedT('en', 'foundation')

test('startup reasons translate at delivery while raw diagnostics and exit metadata survive unchanged', () => {
  const detail = 'Traceback: <raw & diagnostic>\n错误: connection refused\r\n'
  const failures: BackendFailure[] = [
    { kind: 'pythonInvalid', detail },
    { kind: 'startupFailed', detail },
    { kind: 'exited', code: 17, signal: null, detail },
    { kind: 'exited', code: null, signal: 'SIGTERM', detail }
  ]
  for (const failure of failures) {
    const snapshot = structuredClone(failure)
    const chinese = backendFailureMessage(zh, failure, 'notReady')
    const english = backendFailureMessage(en, failure, 'notReady')
    assert.notEqual(chinese, english)
    assert.ok(chinese.endsWith(`\n\n${detail}`))
    assert.ok(english.endsWith(`\n\n${detail}`))
    assert.equal(chinese.includes('backendFailure.'), false)
    assert.equal(english.includes('backendFailure.'), false)
    assert.deepEqual(failure, snapshot)
    if (failure.kind === 'exited') {
      assert.match(english, new RegExp(`exit code: ${failure.code}; signal: ${failure.signal}`))
    }
  }
})

test('missing Python messages preserve both macOS and Windows paths verbatim', () => {
  for (const path of ['/Applications/My App/Resources/bin/python', 'C:\\Program Files\\My App\\python.exe']) {
    const failure: BackendFailure = { kind: 'pythonMissing', path }
    assert.ok(backendFailureMessage(zh, failure, 'notReady').endsWith(path))
    assert.ok(backendFailureMessage(en, failure, 'notReady').endsWith(path))
    assert.equal(failure.path, path)
  }
})

test('health timeout and startup versus recovery fallbacks use distinct localized reasons', () => {
  assert.equal(backendFailureMessage(zh, { kind: 'healthTimeout' }, 'notReady'), '本地服务健康检查超时。')
  assert.equal(backendFailureMessage(en, { kind: 'healthTimeout' }, 'recovering'), 'The local service health check timed out.')
  assert.equal(backendFailureMessage(zh, null, 'notReady'), '本地服务未能就绪。')
  assert.equal(backendFailureMessage(en, undefined, 'notReady'), 'The local service did not become ready.')
  assert.equal(backendFailureMessage(zh, undefined, 'recovering'), '本地服务正在恢复，请稍后重试。')
  assert.equal(backendFailureMessage(en, null, 'recovering'), 'The local service is recovering. Try again shortly.')
  assert.equal(backendFailureMessage(en, { kind: 'startupFailed', detail: '' }, 'notReady'), 'The local service failed to start.')
})


test('install fallback provenance preserves the canonical error and never marks a matching upstream diagnostic', () => {
  for (const empty of [undefined, '']) {
    assert.deepEqual(updateInstallFailure(empty), {
      error: 'update failed',
      errorFallback: 'install_failed',
      errorOrigin: 'install'
    })
  }
  for (const detail of ['update failed', '原始诊断 <error> & message']) {
    assert.deepEqual(updateInstallFailure(detail), {
      error: detail,
      errorFallback: undefined,
      errorOrigin: 'install'
    })
    const prior = { error: 'update failed', errorFallback: 'install_failed', phase: 'failed' }
    assert.equal({ ...prior, ...updateInstallFailure(detail) }.errorFallback, undefined)
  }
})

test('install failures are always attributed to the install action', () => {
  // 展示侧按 errorOrigin 选「安装失败」还是「下载失败」的文案。安装路径拿不到详情时
  // 会走 fallback，那条分支同样必须带上来源，否则界面会把安装失败报成下载失败。
  for (const error of [undefined, '', 'installer exited with 1603']) {
    assert.equal(updateInstallFailure(error).errorOrigin, 'install')
  }
})
