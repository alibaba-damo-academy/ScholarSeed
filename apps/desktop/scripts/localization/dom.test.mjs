import assert from 'node:assert/strict'
import test from 'node:test'

import { transformAsync } from '@babel/core'

import localizationDom, { developmentLocalization } from './dom.mjs'

async function transform(source) {
  const result = await transformAsync(source, {
    babelrc: false,
    configFile: false,
    filename: 'fixture.tsx',
    parserOpts: { plugins: ['jsx', 'typescript'] },
    plugins: [localizationDom]
  })
  assert.ok(result?.code)
  return result
}

test('marks direct translated children and standard slots', async () => {
  const result = await transform(`
    import { useTranslation } from 'react-i18next'
    function View() {
      const { t: project } = useTranslation('project')
      return <><Button>{project('create')}</Button><Input placeholder={project('name.placeholder')} aria-label={project('name.label')} /></>
    }
  `)
  assert.match(result.code, /data-i18n-text="project:create"/)
  assert.match(result.code, /data-i18n-placeholder="project:name\.placeholder"/)
  assert.match(result.code, /data-i18n-aria-label="project:name\.label"/)
})

test('resolves namespace arrays and static call overrides', async () => {
  const result = await transform(`
    import { useTranslation } from 'react-i18next'
    function View() {
      const { t } = useTranslation(['literature', 'pdf'])
      return <><span>{t('title')}</span><span>{t('reading.summary', { ns: 'pdf' })}</span></>
    }
  `)
  assert.match(result.code, /data-i18n-text="literature:title"/)
  assert.match(result.code, /data-i18n-text="pdf:reading\.summary"/)
})

test('marks the parent that directly contains Trans', async () => {
  const result = await transform(`
    import { Trans } from 'react-i18next'
    const View = () => <p><Trans ns="project" i18nKey="remove.confirm" components={{ b: <b /> }} /></p>
  `)
  assert.match(result.code, /<p data-i18n-text="project:remove\.confirm">/)
  assert.doesNotMatch(result.code, /<Trans[^>]+data-i18n/)
})

test('reports dynamic, indirect, composed and multiple-source gaps without guessing', async () => {
  const result = await transform(`
    import { useTranslation } from 'react-i18next'
    function View({ keyName }) {
      const { t } = useTranslation('project')
      const label = t('indirect')
      return <><span>{t(keyName)}</span><span>{t('first')}{t('second')}</span><span>{label}</span><span>{t('composed') + '!'}</span></>
    }
  `)
  assert.deepEqual(result.metadata.localizationDomGaps.map(({ reason, slot }) => ({ reason, slot })).sort((left, right) => left.reason.localeCompare(right.reason)), [
    { reason: 'composed-value', slot: 'unknown' },
    { reason: 'dynamic-key', slot: 'text' },
    { reason: 'indirect-usage', slot: 'unknown' },
    { reason: 'multiple-sources', slot: 'text' }
  ].sort((left, right) => left.reason.localeCompare(right.reason)))
  assert.doesNotMatch(result.code, /data-i18n/)
})

test('rejects explicit metadata that conflicts with the inferred source', async () => {
  await assert.rejects(
    transform(`
      import { useTranslation } from 'react-i18next'
      function View() {
        const { t } = useTranslation('project')
        return <Button data-i18n-text="project:other">{t('create')}</Button>
      }
    `),
    /data-i18n-text conflicts/
  )
})

test('enables instrumentation only for development servers', () => {
  assert.equal(developmentLocalization('build'), undefined)
  assert.ok(developmentLocalization('serve')?.plugins.length)
})

test('does not confuse shadowed translator bindings', async () => {
  const result = await transform(`
    import { useTranslation } from 'react-i18next'
    function View() {
      const { t } = useTranslation('project')
      const nested = (t) => <span>{t('not-a-translation')}</span>
      return <div>{t('title')}{nested((value) => value)}</div>
    }
  `)
  assert.match(result.code, /data-i18n-text="project:title"/)
  assert.doesNotMatch(result.code, /<span data-i18n/)
})
