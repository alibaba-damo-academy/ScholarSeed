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
  const code = `import { sharedName } from '../../../../scripts/shared'; import { displayName } from '../../../../packages/ui/document'; import preview from '../../../../skills/community/literature-review/components/outline.json'; import { createInstance } from 'i18next'; const t=createInstance().getFixedT('en','foundation'); export const text=t('hello', {name:'Ada'}); export const label: string=displayName; export const previewLabel: string=preview.label;`
  const types = generateTypes(resources)
  const config = JSON.stringify({ compilerOptions: { module: 'ESNext', target: 'ES2022', moduleResolution: 'Bundler', resolveJsonModule: true, strict: true, skipLibCheck: true, noEmit: true, types: ['node'] }, include: ['src/**/*.ts'] })
  try {
    git('init', '-q'); git('config', 'user.name', 'Contract Fixture'); git('config', 'user.email', 'fixture@example.invalid')
    write('package.json', JSON.stringify({ private: true, type: 'module' }))
    write('tsconfig.web.json', config); write('tsconfig.node.json', config)
    write('tsconfig.json', JSON.stringify({ references: [{ path: './tsconfig.web.json' }, { path: './tsconfig.node.json' }] }))
    write('src/main/messages.ts', code)
    write('../../scripts/shared.ts', "export const sharedName: string = 'Ada'\n")
    write('../../packages/ui/document.ts', "export const displayName: string = 'Summary'\n")
    write('../../skills/community/literature-review/components/outline.json', '{"label":"Outline"}')
    write('src/localization/catalog.ts', 'export const LOCALES={zh:{},en:{}} as const')
    write('src/localization/types.d.ts', types)
    write('src/localization/resources.ts', generateRegistration(resources))
    for (const language of ['zh', 'en']) write(`src/localization/locales/${language}/foundation.json`, JSON.stringify(resources[language].foundation))
    git('add', 'apps', 'scripts', 'packages', 'skills'); git('commit', '-qm', 'fixture baseline')
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
    write('../../packages/ui/document.ts', 'export const displayName = 42\n')
    assert.deepEqual(checkStaged(options), { checked: true, errors: [] })
    git('add', 'packages')
    assert.match(checkStaged(options).errors.join(), /\[index\].*not assignable to type 'string'/)
    write('../../packages/ui/document.ts', "export const displayName: string = 'Summary'\n")
    git('add', 'packages')
    write('../../skills/community/literature-review/components/outline.json', '{"label":42}')
    assert.deepEqual(checkStaged(options), { checked: true, errors: [] })
    git('add', 'skills')
    assert.match(checkStaged(options).errors.join(), /\[index\].*not assignable to type 'string'/)
    write('../../skills/community/literature-review/components/outline.json', '{"label":"Outline"}')
    git('add', 'skills')
    write('src/main/messages.ts', code.replace("'hello'", "'absent'"))
    assert.deepEqual(checkStaged(options), { checked: true, errors: [] }, 'unstaged call errors belong to worktree checks, not the coherent index')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('index checks include the exact Review JSON dependency without borrowing unstaged types', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'scholarseed-i18n-review-fixture-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  const write = (path, text) => { const file = resolve(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
  const options = { root, dependencies: resolve(DESKTOP, 'node_modules') }
  const resources = { zh: { foundation: { title: '预览' } }, en: { foundation: { title: 'Preview' } } }
  const dependency = 'skills/community/literature-review/components/review.json'
  const code = `import review from '../../../../skills/community/literature-review/components/review.json'; export const title: string = review.title;`
  const config = JSON.stringify({ compilerOptions: { module: 'ESNext', target: 'ES2022', moduleResolution: 'Bundler', resolveJsonModule: true, strict: true, skipLibCheck: true, noEmit: true, types: ['node'] }, include: ['src/**/*.ts'] })
  try {
    git('init', '-q'); git('config', 'user.name', 'Contract Fixture'); git('config', 'user.email', 'fixture@example.invalid')
    write('apps/desktop/package.json', JSON.stringify({ private: true, type: 'module' }))
    write('apps/desktop/tsconfig.web.json', config); write('apps/desktop/tsconfig.node.json', config)
    write('apps/desktop/tsconfig.json', JSON.stringify({ references: [{ path: './tsconfig.web.json' }, { path: './tsconfig.node.json' }] }))
    write('apps/desktop/src/main/messages.ts', code)
    write(dependency, JSON.stringify({ title: 'Review snapshot' }))
    write('apps/desktop/src/localization/catalog.ts', 'export const LOCALES={zh:{},en:{}} as const')
    write('apps/desktop/src/localization/types.d.ts', generateTypes(resources))
    write('apps/desktop/src/localization/resources.ts', generateRegistration(resources))
    for (const language of ['zh', 'en']) write(`apps/desktop/src/localization/locales/${language}/foundation.json`, JSON.stringify(resources[language].foundation))
    git('add', 'apps', 'skills'); git('commit', '-qm', 'fixture baseline')
    write('apps/desktop/src/main/messages.ts', code + '\n')
    git('add', 'apps')
    assert.deepEqual(checkStaged(options), { checked: true, errors: [] })

    write(dependency, JSON.stringify({ title: 42 }))
    assert.deepEqual(checkStaged(options), { checked: true, errors: [] }, 'the JSON type must come from the index, not the worktree')
    git('add', dependency)
    assert.match(checkStaged(options).errors.join(), /\[index\].*Type 'number' is not assignable to type 'string'/)

    write(dependency, JSON.stringify({ title: 'Review snapshot' }))
    git('add', dependency)
    assert.deepEqual(checkStaged(options), { checked: true, errors: [] })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
