#!/usr/bin/env node
// Package exact-version native language outputs; run with gettext installed.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const CORE_REVISION = 'efaf0670b4d055f838a2849becb10f08aa06a257'
const TRANSLATIONS_REVISION = '5acb9e94995b78727200faa5d89f2d8b72002e2e'
const LANGUAGE = 'zh-CN'
const FILESYSTEM_ROOT = '/instdir/'
const REGISTRY_OUTPUTS = {
  'Langpack-zh-CN.xcd': 'registry/Langpack-zh-CN.xcd',
  'registry_zh-CN.xcd': 'registry/res/registry_zh-CN.xcd',
  'fcfg_langpack_zh-CN.xcd': 'registry/res/fcfg_langpack_zh-CN.xcd'
}
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

function build(source, translations, output) {
  const chunks = []
  const files = []
  const residuals = {}
  let offset = 0
  function add(name, bytes) {
    files.push({ path: FILESYSTEM_ROOT + name, start: offset, end: offset + bytes.length, sha256: digest(bytes) })
    chunks.push(bytes)
    offset += bytes.length
  }
  for (const [name, destination] of Object.entries(REGISTRY_OUTPUTS)) {
    add('share/' + destination, fs.readFileSync(path.join(source, 'workdir', 'XcdTarget', name)))
  }
  for (const directory of fs.readdirSync(source).sort()) {
    const root = path.join(source, directory)
    if (!fs.statSync(root).isDirectory()) continue
    for (const name of fs.readdirSync(root).filter(name => /^AllLangMoTarget_.*\.mk$/.test(name)).sort()) {
      const makefile = fs.readFileSync(path.join(root, name), 'utf8')
      const domain = makefile.match(/gb_AllLangMoTarget_AllLangMoTarget,([^\s)]+)/)?.[1]
      if (!domain) throw new Error(`No catalog domain in ${name}`)
      const location = makefile.match(/gb_AllLangMoTarget_set_polocation,[^,]+,([^\s)]+)/)?.[1] || domain
      const catalog = path.join(translations, 'source', LANGUAGE, location, 'messages.po')
      const unique = execFileSync('msguniq', ['--force-po', catalog])
      const bytes = execFileSync('msgfmt', ['-', '-o', '-'], { input: unique })
      // Emscripten Translate::Create uses program/resource, unlike native desktop builds.
      add(`program/resource/zh_CN/LC_MESSAGES/${domain}.mo`, bytes)
      const untranslated = execFileSync('msgattrib', ['--untranslated', '--no-obsolete', '-'], { input: unique }).toString()
      const fuzzy = execFileSync('msgattrib', ['--only-fuzzy', '--no-obsolete', '-'], { input: unique }).toString()
      if (untranslated || fuzzy) residuals[domain] = { untranslated, fuzzy }
    }
  }
  const data = Buffer.concat(chunks)
  const manifest = {
    core_revision: CORE_REVISION, translations_revision: TRANSLATIONS_REVISION,
    locales: ['en-US', LANGUAGE], default_locale: LANGUAGE,
    english_source: 'Original frozen ZetaOffice soffice.data and WASM source messages',
    data: { file: 'locales.data', bytes: data.length, sha256: digest(data) },
    residuals: 'locales-residuals.json', files
  }
  fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(output, 'locales.data'), data)
  fs.writeFileSync(path.join(output, 'locales.json'), JSON.stringify(manifest, null, 2) + '\n')
  fs.writeFileSync(path.join(output, 'locales-residuals.json'), JSON.stringify(residuals, null, 2) + '\n')
  console.log(`Packaged ${files.length} native resources (${data.length} bytes); English base retained`)
}

if (require.main === module) {
  const [source, translations, output] = process.argv.slice(2)
  if (!source || !translations || !output) throw new Error('Usage: node locales.cjs <configured-core> <translations> <output>')
  build(source, translations, output)
}

module.exports = { build }
