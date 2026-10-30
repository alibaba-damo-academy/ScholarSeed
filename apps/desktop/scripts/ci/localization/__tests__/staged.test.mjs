import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { DESKTOP, generateTypes, generateRegistration, checkResourceFiles } from '../resources.mjs'
import { checkStaged } from '../staged.mjs'

test('index calls, resources and generated types cannot borrow unstaged fixes', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'scholarseed-i18n-staged-fixture-'))
  const desktop = resolve(root, 'apps/desktop')
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  const write = (path, text) => { const file = resolve(desktop, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
  const options = { root, dependencies: resolve(DESKTOP, 'node_modules') }
  const resources = { zh: { foundation: { hello: '你好 {{name}}' } }, en: { foundation: { hello: 'Hello {{name}}' } } }
  const code = `import { sharedName } from '../../../../scripts/shared'; import { createInstance } from 'i18next'; const t=createInstance().getFixedT('en','foundation'); export const text=t('hello', {name:'Ada'});`
  const types = generateTypes(resources)
  const config = JSON.stringify({ compilerOptions: { module: 'ESNext', target: 'ES2022', moduleResolution: 'Bundler', strict: true, skipLibCheck: true, noEmit: true, types: ['node'] }, include: ['src/**/*.ts'] })
  try {
    git('init', '-q'); git('config', 'user.name', 'Contract Fixture'); git('config', 'user.email', 'fixture@example.invalid')
    write('package.json', JSON.stringify({ private: true, type: 'module' }))
    write('tsconfig.web.json', config); write('tsconfig.node.json', config)
    write('tsconfig.json', JSON.stringify({ references: [{ path: './tsconfig.web.json' }, { path: './tsconfig.node.json' }] }))
    write('src/main/messages.ts', code)
    write('../../scripts/shared.ts', "export const sharedName: string = 'Ada'\n")
    write('src/localization/catalog.ts', 'export const LOCALES={zh:{},en:{}} as const')
    write('src/localization/types.d.ts', types)
    write('src/localization/resources.ts', generateRegistration(resources))
    for (const language of ['zh', 'en']) write(`src/localization/locales/${language}/foundation.json`, JSON.stringify(resources[language].foundation))
    git('add', 'apps', 'scripts'); git('commit', '-qm', 'fixture baseline')
    assert.deepEqual(checkStaged(options), { checked: false, errors: [] })

    write('src/main/messages.ts', code.replace(", {name:'Ada'}", ''))
    git('add', 'apps')
    write('src/main/messages.ts', code)
    assert.match(checkStaged(options).errors.join(), /\[index\].*parameter name/)

    git('add', 'apps')
    write('src/localization/locales/en/foundation.json', '{}')
    git('add', 'apps')
    write('src/localization/locales/en/foundation.json', JSON.stringify(resources.en.foundation))
    assert.deepEqual(checkResourceFiles({ desktop }), resources)
    assert.match(checkStaged(options).errors.join(), /\[index\].*missing message/)

    git('add', 'apps')
    write('src/localization/types.d.ts', types.replace('{{name}}', '{{wrong}}'))
    git('add', 'apps')
    write('src/localization/types.d.ts', types)
    assert.match(checkStaged(options).errors.join(), /\[index\].*artifact drifted/)

    git('add', 'apps')
    write('src/main/messages.ts', code + '\n')
    git('add', 'apps')
    assert.deepEqual(checkStaged(options), { checked: true, errors: [] })
    write('../../scripts/shared.ts', "export const sharedName: string = 42\n")
    assert.deepEqual(checkStaged(options), { checked: true, errors: [] }, 'shared source must come from the index, not the worktree')
    git('add', 'scripts')
    assert.match(checkStaged(options).errors.join(), /\[index\].*not assignable to type 'string'/)
    write('../../scripts/shared.ts', "export const sharedName: string = 'Ada'\n")
    git('add', 'scripts')
    write('src/main/messages.ts', code.replace("'hello'", "'absent'"))
    assert.deepEqual(checkStaged(options), { checked: true, errors: [] }, 'unstaged call errors belong to worktree checks, not the coherent index')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
