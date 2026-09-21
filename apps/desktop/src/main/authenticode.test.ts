import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  classifyAuthenticodeStatus,
  parseAuthenticodeReport,
  publisherSubjectsMatch
} from './authenticode.ts'

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

// ---- 报告解析：发布者身份的传输契约（bug 87108457） ----

// 现场真实证书 DN，与构建期冻结进 product.json 的期望串逐字一致（事实源：scholarseed-distribution
// build/const.py 的 WINDOWS_PUBLISHER）。刻意用真实的 .NET 渲染形态而不是好看的样例：CN/O 值带
// 引号且内部逗号不转义，L/S/OID 属地属性是中文。
const FIELD_SUBJECT =
  'CN="Alibaba Cloud Computing Co., Ltd.", O="Alibaba Cloud Computing Co., Ltd.", L=杭州市, ' +
  'S=浙江省, C=CN, SERIALNUMBER=91330106673959654P, OID.2.5.4.15=Private Organization, ' +
  'OID.1.3.6.1.4.1.311.60.2.1.1=西湖区, OID.1.3.6.1.4.1.311.60.2.1.2=浙江省, ' +
  'OID.1.3.6.1.4.1.311.60.2.1.3=CN'

function jsonReport(subject: string): string {
  return JSON.stringify({ LanguageMode: 'FullLanguage', Status: 'Valid', Subject: subject })
}

/** 修复后的传输面：PS 5.1 `Set-Content -Encoding UTF8` 写出的文件 —— BOM + 一行压缩 JSON + CRLF。 */
const reportFile = (subject: string): string => `\uFEFF${jsonReport(subject)}\r\n`

/** PS 7 的 `-Encoding utf8` 不带 BOM：解析器必须两种都吃。 */
const reportFileWithoutBom = (subject: string): string => `${jsonReport(subject)}\n`

/** 把 GBK 字节按 UTF-8 非致命解码 —— 复现现场「PowerShell 输出 936、Node 按 UTF-8 解」的破坏。 */
const gbkAsUtf8 = (...bytes: number[]): string =>
  new TextDecoder('utf-8').decode(Uint8Array.from(bytes))

// GBK 双字节：杭州市=ba bc d6 dd ca d0、浙江省=d5 e3 bd ad ca a1、西湖区=ce f7 ba fe c7 f8。
const FIELD_SUBJECT_BROKEN_ON_THE_WIRE = FIELD_SUBJECT
  .replace('L=杭州市', `L=${gbkAsUtf8(0xba, 0xbc, 0xd6, 0xdd, 0xca, 0xd0)}`)
  .replace('S=浙江省', `S=${gbkAsUtf8(0xd5, 0xe3, 0xbd, 0xad, 0xca, 0xa1)}`)
  .replace('OID.1.3.6.1.4.1.311.60.2.1.1=西湖区', `OID.1.3.6.1.4.1.311.60.2.1.1=${gbkAsUtf8(0xce, 0xf7, 0xba, 0xfe, 0xc7, 0xf8)}`)

test('GBK 字节按 UTF-8 解码正是日志里的乱码形态', () => {
  // update.log 里 L= 后是 6 个 U+FFFD，S= 后是 FFFD + 一个 CJK + ʡ —— 逐字节对上才算复现。
  assert.equal(gbkAsUtf8(0xba, 0xbc, 0xd6, 0xdd, 0xca, 0xd0), '\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD')
  assert.equal(gbkAsUtf8(0xd5, 0xe3, 0xbd, 0xad, 0xca, 0xa1), '\uFFFD\u3F6D\u02A1')
  assert.notEqual(FIELD_SUBJECT_BROKEN_ON_THE_WIRE, FIELD_SUBJECT)
})

test('真实证书 DN 经 UTF-8 报告文件完整送达，并判定为同一发布者', () => {
  for (const document of [reportFile(FIELD_SUBJECT), reportFileWithoutBom(FIELD_SUBJECT)]) {
    const parsed = parseAuthenticodeReport(document)
    assert.ok(parsed)
    assert.equal(parsed.status, 'Valid')
    assert.equal(parsed.languageMode, 'FullLanguage')
    assert.equal(parsed.subject, FIELD_SUBJECT)
    // 这条就是本次 bug 的 GREEN：同一张证书在中文 Windows 上必须被判为发布者一致。
    assert.equal(publisherSubjectsMatch(parsed.subject, FIELD_SUBJECT), true)
  }
})

test('报告里出现 U+FFFD 即判定输入不可信，不得降级成发布者不符', () => {
  // 现场形态：GBK 字节被按 UTF-8 解码。真机 repro 已证 PS 5.1 的 ConvertTo-Json 不转义非 ASCII，
  // 所以只要 DN 经过 stdout 这条降级就可能发生 —— 解析器必须拒绝它，而不是拿去做比对。
  assert.equal(parseAuthenticodeReport(reportFile(FIELD_SUBJECT_BROKEN_ON_THE_WIRE)), null)
  // 对照旧传输面的结局：同一条 DN 被判成「发布者不符」的安全拦截，更新永久阻断。
  assert.equal(publisherSubjectsMatch(FIELD_SUBJECT_BROKEN_ON_THE_WIRE, FIELD_SUBJECT), false)
})

test('报告文件读不到或不是合法 JSON 文档时返回 null', () => {
  assert.equal(parseAuthenticodeReport(''), null)
  assert.equal(parseAuthenticodeReport('\uFEFF'), null)
  assert.equal(parseAuthenticodeReport('{not json'), null)
  assert.equal(parseAuthenticodeReport('[1,2,3]'), null)
  assert.equal(parseAuthenticodeReport('"Valid"'), null)
  assert.equal(parseAuthenticodeReport('{"Status":"Valid","Subject":"CN=X"}'), null)
  assert.equal(parseAuthenticodeReport('{"LanguageMode":"FullLanguage","Status":1,"Subject":"CN=X"}'), null)
  // 旧传输面的形状（按行前缀解析）不再被接受：判定输入只能来自报告文件。
  assert.equal(
    parseAuthenticodeReport('REPORT={"LanguageMode":"FullLanguage","Status":"Valid","Subject":"CN=X"}'),
    null
  )
})

test('空签名者照样送达，由发布者判定拒绝', () => {
  const parsed = parseAuthenticodeReport(reportFile(''))
  assert.ok(parsed)
  assert.equal(parsed.subject, '')
  assert.equal(publisherSubjectsMatch(parsed.subject, FIELD_SUBJECT), false)
})
