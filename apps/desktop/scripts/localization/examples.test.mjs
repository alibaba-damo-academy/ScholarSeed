import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { DESKTOP, GENERATED_TYPES, generateTypes, loadResources, validateResources } from './resources.mjs'
import { checkMessageCalls } from './calls.mjs'

const fixture = JSON.parse(readFileSync(new URL('./examples.fixture.json', import.meta.url), 'utf8'))
const source = fixture.source
const resources = loadResources()
for (const language of ['zh', 'en']) resources[language].example = fixture.resources[language]

function check(code) {
  const filename = resolve(DESKTOP, 'src/localization/documentation.tsx')
  const configuration = ts.readConfigFile(resolve(DESKTOP, 'tsconfig.web.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(configuration.config, ts.sys, DESKTOP)
  const options = { ...parsed.options, composite: false }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile
  host.getSourceFile = (name, version, ...rest) => {
    if (name === filename) return ts.createSourceFile(name, code, version, true, ts.ScriptKind.TSX)
    if (name === GENERATED_TYPES) return ts.createSourceFile(name, generateTypes(resources), version, true)
    return original(name, version, ...rest)
  }
  const program = ts.createProgram([filename, GENERATED_TYPES], options, host)
  return {
    types: ts.getPreEmitDiagnostics(program).map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')),
    calls: checkMessageCalls(program, resources)
  }
}

test('documented React, Trans, plain TS, main and formatter examples use actual shipped APIs', () => {
  assert.deepEqual(validateResources(resources), [])
  assert.deepEqual(check(source), { types: [], calls: [] })
})

test('actual-library documentation check rejects missing parameters and unknown keys', () => {
  const missing = check(source.replace("t('welcome', { name })", "t('welcome')"))
  assert.match(missing.calls.join(), /parameter name/)
  const unknown = check(source.replace("t('welcome', { name })", "t('unknown', { name })"))
  assert.ok(unknown.types.length)
  assert.match(unknown.calls.join(), /Unknown message/)
  const optional = check(source.replace('name: string; count: number', 'name: string | undefined; count: number | undefined'))
  assert.match(optional.calls.join(), /parameter name/)
  assert.match(optional.calls.join(), /parameter count/)
  const plural = source.replace('i18nKey="rich" values={{ name }}', 'i18nKey="files" count={undefined}')
  assert.match(check(plural).calls.join(), /Trans parameter count/)
  assert.match(check(plural.replace('count={undefined}', 'count="one"')).calls.join(), /Trans parameter count/)
})
