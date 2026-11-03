import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { classifyPdfLoadFailure, EncryptedPdfError, PDF_LOAD_FAILURE_KIND } from './loading.ts'

const encryptedReaderContract =
  /\bencrypted\s*\?\s*(?:\(\s*)?<EncryptedPdfState[\s\S]*?(?:\)\s*)?:\s*(?:\(\s*)?<>[\s\S]*?className="vds-pdf-tools/

test('encrypted reader contract accepts JSX formatting but rejects a different gate', () => {
  for (const source of [
    'encrypted ? <EncryptedPdfState /> : <><header className="vds-pdf-tools" /></>',
    'encrypted ? (\n<EncryptedPdfState />\n) : (\n<><header className="vds-pdf-tools" /></>\n)',
  ]) {
    assert.match(source, encryptedReaderContract)
    assert.doesNotMatch(source.replace('encrypted', 'loading'), encryptedReaderContract)
    assert.doesNotMatch(source.replace('encrypted', 'unencrypted'), encryptedReaderContract)
  }
})

test('PDF load failure classification distinguishes encrypted documents from generic failures', () => {
  assert.deepEqual(classifyPdfLoadFailure(new EncryptedPdfError()), {
    kind: PDF_LOAD_FAILURE_KIND.encrypted,
  })
  const passwordError = new Error('Password required')
  passwordError.name = 'PasswordException'
  assert.deepEqual(classifyPdfLoadFailure(passwordError), {
    kind: PDF_LOAD_FAILURE_KIND.encrypted,
  })
  assert.deepEqual(classifyPdfLoadFailure(new Error('broken PDF')), {
    kind: PDF_LOAD_FAILURE_KIND.unknown,
    detail: 'broken PDF',
  })
  assert.deepEqual(classifyPdfLoadFailure('invalid bytes'), {
    kind: PDF_LOAD_FAILURE_KIND.unknown,
    detail: 'invalid bytes',
  })
})

test('encrypted PDF state replaces the reader toolbar with an external-open empty state', () => {
  const viewer = readFileSync(new URL('../PdfDocument.tsx', import.meta.url), 'utf8')
  const restoration = readFileSync(new URL('./export.ts', import.meta.url), 'utf8')
  const zh = JSON.parse(
    readFileSync(
      new URL('../../../../../localization/locales/zh/pdf.json', import.meta.url),
      'utf8'
    )
  )
  const en = JSON.parse(
    readFileSync(
      new URL('../../../../../localization/locales/en/pdf.json', import.meta.url),
      'utf8'
    )
  )

  assert.match(viewer, /loadError\?\.kind === PDF_LOAD_FAILURE_KIND\.encrypted/)
  assert.match(viewer, /<EmptyState/)
  assert.match(viewer, /resolveDocumentLocation\(session\.source\)/)
  assert.match(viewer, /openSystemPath\(resolved\.absolute\)/)
  assert.match(viewer, /\bencrypted\s*\?\s*(?:\(\s*)?<EncryptedPdfState/)
  assert.match(viewer, encryptedReaderContract)
  assert.match(restoration, /PDFLibDocument\.load\(bytes, \{ ignoreEncryption: true \}\)/)
  assert.match(restoration, /if \(pdf\.isEncrypted\) throw new EncryptedPdfError\(\)/)
  assert.deepEqual(zh.encrypted, {
    title: '该 PDF 已加密',
    description: '书深暂时无法预览加密文档，请使用外部应用打开并输入密码查看。',
    openExternal: '使用外部应用打开',
    opening: '正在打开…',
    openFailed: '无法使用外部应用打开此 PDF，请稍后重试。',
  })
  assert.deepEqual(en.encrypted, {
    title: 'This PDF is encrypted',
    description:
      'ScholarSeed cannot preview encrypted documents yet. Open this PDF in an external application and enter its password to view it.',
    openExternal: 'Open in external application',
    opening: 'Opening…',
    openFailed: 'This PDF could not be opened in an external application. Try again.',
  })
})
