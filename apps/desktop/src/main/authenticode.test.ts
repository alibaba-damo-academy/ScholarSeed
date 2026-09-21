import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifyAuthenticodeStatus, publisherSubjectsMatch } from './authenticode.ts'

test('Valid is the only passing Authenticode status', () => {
  assert.equal(classifyAuthenticodeStatus('Valid'), 'valid')
})

test('package-level facts are condemned', () => {
  for (const status of ['NotSigned', 'HashMismatch', 'NotSupportedFileFormat']) {
    assert.equal(classifyAuthenticodeStatus(status), 'condemned', status)
  }
})

test('machine-local and unrecognized statuses are indeterminate, never valid', () => {
  // NotTrusted / UnknownError / Incompatible 都可能是本机链/吊销/兼容状态；未来新增的
  // Status 值同样落这里 —— fail-closed，但文案不再谎称「签名不可信、请重新下载」。
  for (const status of ['NotTrusted', 'UnknownError', 'Incompatible', '', 'SomethingNew']) {
    assert.equal(classifyAuthenticodeStatus(status), 'indeterminate', status)
  }
})

// 线上 Windows 安装包真实签名者的 Subject 形态（含中文值与 jurisdiction* 属性）。
const ALIBABA_SUBJECT =
  'jurisdictionC=CN, jurisdictionST=浙江省, jurisdictionL=西湖区, businessCategory=Private Organization, ' +
  'serialNumber=91330106673959654P, C=CN, ST=浙江省, L=杭州市, O=Alibaba Cloud Computing Co., Ltd., ' +
  'CN=Alibaba Cloud Computing Co., Ltd.'

test('identical subjects match', () => {
  assert.equal(publisherSubjectsMatch(ALIBABA_SUBJECT, ALIBABA_SUBJECT), true)
})

test('attribute order does not matter', () => {
  const reordered = ALIBABA_SUBJECT.split(', ').reverse().join(', ')
  assert.notEqual(reordered, ALIBABA_SUBJECT)
  assert.equal(publisherSubjectsMatch(reordered, ALIBABA_SUBJECT), true)
})

test('spacing and key case do not matter', () => {
  const respaced = ALIBABA_SUBJECT.replaceAll(', ', ',').replaceAll('CN=', 'cn=')
  assert.equal(publisherSubjectsMatch(respaced, ALIBABA_SUBJECT), true)
})

test('a different attribute value is a different publisher', () => {
  const other = ALIBABA_SUBJECT.replace('O=Alibaba Cloud Computing Co., Ltd.', 'O=Someone Else Ltd.')
  assert.equal(publisherSubjectsMatch(other, ALIBABA_SUBJECT), false)
})

test('missing or extra attributes are a different publisher', () => {
  const [first, ...rest] = ALIBABA_SUBJECT.split(', ')
  assert.equal(publisherSubjectsMatch(rest.join(', '), ALIBABA_SUBJECT), false)
  assert.equal(publisherSubjectsMatch(`${ALIBABA_SUBJECT}, OU=Extra`, ALIBABA_SUBJECT), false)
  assert.equal(first.includes('='), true)
})

test('escaped commas stay inside one attribute value', () => {
  const escaped = 'CN=Foo\\, Bar, O=X'
  assert.equal(publisherSubjectsMatch(escaped, 'O=X, CN=Foo\\, Bar'), true)
  // 未转义的逗号会把值切断：CN=Foo 与 CN=Foo, Bar 不是同一个 CN。
  assert.equal(publisherSubjectsMatch('CN=Foo, Bar, O=X', escaped), false)
})

test('an empty subject never matches', () => {
  assert.equal(publisherSubjectsMatch('', ALIBABA_SUBJECT), false)
  assert.equal(publisherSubjectsMatch(ALIBABA_SUBJECT, ''), false)
  assert.equal(publisherSubjectsMatch('', ''), false)
})
