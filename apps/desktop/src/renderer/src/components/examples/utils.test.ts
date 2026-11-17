import assert from 'node:assert/strict'
import test from 'node:test'
import { exampleSectionCode, materialSessionRead } from './utils.ts'

test('material sessions provide idle runtime and empty finalizations only inside their own read scope', async () => {
  const project = { id: 'sample', path: '/sample' }
  const read = (path: string, method = 'GET') =>
    materialSessionRead(new URL(path, 'http://localhost'), method, project, 'material')
  assert.equal(read('/api/serve/sessions/material/runtime/reconfigure')?.status, 204)
  assert.equal(read('/api/serve/sessions/material/runtime/reconfigure', 'POST'), null)
  assert.equal(read('/api/serve/sessions/other/runtime/reconfigure'), null)
  for (const value of [project.id, project.path]) {
    const response = read(
      `/api/resource/finalizations?session_id=material&project=${encodeURIComponent(value)}`
    )
    assert.deepEqual(await response?.json(), { entries: [], next_cursor: null })
  }
  assert.equal(read('/api/resource/finalizations?session_id=material&project=other'), null)
  assert.equal(read('/api/resource/finalizations?session_id=other&project=sample'), null)
})

test('example source extraction follows the section indentation and preserves multiline headings', () => {
  const source = `
            <section className={exampleSectionClass('link', activeExample)} id="link">
              <h2 className="title">
                {t('link.title')}
              </h2>
              <Link href="#destination">Example</Link>
            </section>
            <section>Other example</section>`
  assert.equal(
    exampleSectionCode(source, 'link'),
    `<h2 className="title">
  {t('link.title')}
</h2>
<Link href="#destination">Example</Link>`
  )
})

test('nested sections do not terminate the containing example', () => {
  const source = `
  <section className={exampleSectionClass('nested', activeExample)} id="nested">
    <section>
      <Link href="#nested">Nested</Link>
    </section>
    <Link href="#tail">Tail</Link>
  </section>`
  assert.equal(
    exampleSectionCode(source, 'nested'),
    `<section>
  <Link href="#nested">Nested</Link>
</section>
<Link href="#tail">Tail</Link>`
  )
  assert.equal(exampleSectionCode(source, 'missing'), '')
  assert.equal(exampleSectionCode(source.replace('\n  </section>', ''), 'nested'), '')
})
