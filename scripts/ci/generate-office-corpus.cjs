const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '../..')
const CORPUS = path.join(ROOT, 'apps', 'desktop', 'e2e', 'fixtures', 'office-corpus')
const DOCUMENT_PARAGRAPHS = 120
const LARGE_DOCUMENT_PARAGRAPHS = 180
const SPREADSHEET_ROWS = 120
const DOCUMENT_LINE = 'Normal + Courier New, 12pt. This paragraph is indented. Here is an example of text that helps the reader’s eye find the start of the next line.'

function convert(soffice, profile, source, target, filter) {
  const result = spawnSync(soffice, [
    `-env:UserInstallation=${pathToFileURL(profile).href}`,
    '--headless', '--convert-to', filter, '--outdir', path.dirname(target), source
  ], { encoding: 'utf8', timeout: 120_000 })
  if (result.status !== 0 || !fs.existsSync(target)) {
    throw new Error(`Office conversion failed: ${result.stderr || result.stdout || result.error}`)
  }
}

function main() {
  const soffice = process.env.SOFFICE || 'soffice'
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-office-corpus-'))
  try {
    const doc = path.join(CORPUS, 'doc', 'selection-multipage.doc')
    const docx = path.join(CORPUS, 'docx', 'selection-large.docx')
    const xls = path.join(CORPUS, 'xls', 'selection-100-rows.xls')
    for (const filename of [doc, docx, xls]) fs.mkdirSync(path.dirname(filename), { recursive: true })

    const docSource = path.join(temporary, 'selection-multipage.html')
    const docxSource = path.join(temporary, 'selection-large.html')
    const xlsSource = path.join(temporary, 'selection-100-rows.csv')
    const html = count => `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Courier New;font-size:12pt}p{margin:0 0 12pt;text-indent:18pt}</style></head><body>${Array.from({ length: count }, (_, index) => `<p>${index + 1}. ${DOCUMENT_LINE}</p>`).join('')}</body></html>`
    fs.writeFileSync(docSource, html(DOCUMENT_PARAGRAPHS))
    fs.writeFileSync(docxSource, html(LARGE_DOCUMENT_PARAGRAPHS))
    fs.writeFileSync(xlsSource, ['Label,Value', ...Array.from({ length: SPREADSHEET_ROWS }, (_, index) => `Selection row ${index + 1},${index + 1}`)].join('\n') + '\n')

    convert(soffice, path.join(temporary, 'profile-doc'), docSource, doc, 'doc:MS Word 97')
    convert(soffice, path.join(temporary, 'profile-docx'), docxSource, docx, 'docx:Office Open XML Text')
    convert(soffice, path.join(temporary, 'profile-xls'), xlsSource, xls, 'xls:MS Excel 97')

    const files = {}
    for (const relative of ['doc/selection-multipage.doc', 'docx/selection-large.docx',
      'xls/selection-100-rows.xls']) {
      files[relative] = crypto.createHash('sha256').update(fs.readFileSync(path.join(CORPUS, relative))).digest('hex')
    }
    fs.writeFileSync(path.join(CORPUS, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, version: 'selection-v1', files
    }, null, 2) + '\n')
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

if (require.main === module) main()

module.exports = { main }
