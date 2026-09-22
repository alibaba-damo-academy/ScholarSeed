import assert from 'node:assert/strict'
import test from 'node:test'
import { scanSource, newFindings } from './source.mjs'

const scan = (text) => scanSource(text, 'page.tsx')
test('both English and Chinese visible strings are found while protocol and log strings are ignored', () => {
  const rows = scan(`const MODE='ready'; console.log('hello'); const A=()=> <div title="标题">Hello</div>`)
  assert.deepEqual(rows.map((r) => r.text).sort(), ['Hello', '标题'].sort())
})
test('line moves preserve identity but replacing/deleting-old-adding-new cannot spend old debt', () => {
  const old = scan(`const A=()=> <div title="标题">Hello</div>`)
  assert.deepEqual(newFindings(scan(`\n\nconst A = () => <div title="标题">Hello</div>`), old, old), [])
  assert.equal(newFindings(scan(`const A=()=> <div title="新标题">Hello</div>`), old, old).length, 1)
  assert.equal(newFindings(old, [], old).length, 2)
})
test('duplicate new occurrences, dynamic keys and legacy imports are detected', () => {
  const old = scan(`const A=()=> <div>Hello</div>`)
  assert.equal(newFindings(scan(`const A=()=> <div>Hello<span>Hello</span></div>`), old, old).length, 1)
  assert.equal(scan("t('items.' + mode); import { I18N } from './i18n'").length, 2)
})

test('visible references follow local declarations, aliases and const maps without confusing shadowed user data', () => {
  const rows = scan(`
    const LABEL = 'Submit'; const ALIAS = LABEL;
    const COPY = { ready: 'Ready', failed: 'Failed' } as const;
    declare const status: 'ready' | 'failed';
    const A = () => <div title={ALIAS}>{COPY[status]}<span>{COPY.ready}</span></div>;
    const B = (LABEL: string) => <span>{LABEL}</span>;
    const PROTOCOL = 'ready'; console.info(PROTOCOL);
  `)
  assert.deepEqual(rows.map((row) => row.text).sort(), ['Submit', 'Ready', 'Failed', 'Ready'].sort())
  assert.ok(rows.every((row) => row.owner === 'A'))
  const before = scan(`const LABEL='Old'; const A=()=> <span>{LABEL}</span>`)
  assert.equal(newFindings(scan(`const LABEL='New'; const A=()=> <span>{LABEL}</span>`), before, before).length, 1)
  assert.deepEqual(newFindings(scan(`\nconst LABEL='Old';\nconst A=()=> <span>{LABEL}</span>`), before, before), [])
})

test('cyclic aliases do not recurse forever and opaque content is not guessed to be a message', () => {
  assert.deepEqual(scan(`const A=B; const B=A; const View=({content})=><div>{A}{content.text}</div>`), [])
  assert.deepEqual(scan('const View=({path,revision})=><div>{`${path} · ${revision}`}<span>https://example.com/docs</span><span>mail@example.com</span></div>'), [])
  assert.equal(scan('const View=({path})=><div>{`Open ${path}`}</div>').length, 1)
  assert.deepEqual(scan('const View=({name})=><div>{`${name || "Unknown"}`}</div>').map(row=>row.text), ['Unknown'])
})

test('legacy references cannot grow behind an existing import and namespace imports are checked', () => {
  const old = scan(`import { I18N as copy } from './i18n'; const A=()=> <span>{copy.en.placeholder}</span>`)
  const next = scan(`import { I18N as copy } from './i18n'; const A=()=> <span>{copy.en.placeholder}{copy.zh.placeholder}</span>`)
  assert.equal(newFindings(next, old, old).filter((row)=>row.kind==='legacy-reference').length, 1)
  assert.equal(scan(`import * as messages from './i18n'; const A=()=> <span>{messages.I18N.en.placeholder}</span>`).filter((row)=>row.kind==='legacy-reference').length, 1)
  assert.deepEqual(scan(`import * as data from './i18n'; console.log(data.DEFAULT_WORKDIR)`), [])
})

test('Tooltip content is a visible sink, including aliases, without treating arbitrary content as UI copy', () => {
  const rows = scan(`import { Tooltip as Hint } from './components/ui'; import * as UI from './components/ui';
    const COPY='提示'; const View=()=> <><Hint content="New tooltip"/><UI.Tooltip content={COPY}/><Document content="user data"/></>`)
  assert.deepEqual(rows.map(row=>row.text), ['New tooltip', '提示'])
})
