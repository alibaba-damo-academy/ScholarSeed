import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const exploratoryRoot = fileURLToPath(new URL('./eval-scenarios/exploratory/', import.meta.url))
const registry = readFileSync(new URL('./eval-scenarios/README.md', import.meta.url), 'utf8')
const pages = new Set(
  [...registry.matchAll(/\]\(exploratory\/([^/]+)\/requirements\.md(?:#[^)]*)?\)/g)].map(
    (match) => match[1]
  )
)
const aboutRoot = resolve(exploratoryRoot, 'about')
const requirements = readFileSync(resolve(aboutRoot, 'requirements.md'), 'utf8')

test('current page assets match the maintained page registry', () => {
  assert.ok(pages.size > 0)
  const documented = readdirSync(exploratoryRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        ['requirements.md', 'build.md'].some((filename) =>
          existsSync(resolve(exploratoryRoot, entry.name, filename))
        )
    )
    .map((entry) => entry.name)
  assert.deepEqual(documented.sort(), [...pages].sort())
  for (const page of pages) {
    const pageRoot = resolve(exploratoryRoot, page)
    assert.ok(existsSync(resolve(pageRoot, 'build.md')))
    const content = readFileSync(resolve(pageRoot, 'requirements.md'), 'utf8')
    const versioned = [...content.matchAll(/^### .*（([A-Z-]+-\d{3}) · v`([^`]+)`）$/gm)]
    const candidates = [...content.matchAll(/^(?:### |\*\*)[^\n]*（`?([A-Z-]+-CAND-\d{3})`?[；，][^\n]+/gm)]
    const ids = [...versioned, ...candidates].map((match) => match[1])
    assert.ok(ids.length > 0, page)
    assert.equal(new Set(ids).size, ids.length, page)
  }
})

test('About preserves its fourteen stable requirements and reference asset', () => {
  assert.deepEqual(readdirSync(aboutRoot).sort(), ['build.md', 'reference.png', 'requirements.md'])
  const identities = [...requirements.matchAll(/^### .*（(ABOUT-OBS-\d{3}) · v\`([^\`]+)\`）$/gm)]
  assert.deepEqual(
    identities.map((match) => match[1]).sort(),
    Array.from({ length: 14 }, (_, index) => `ABOUT-OBS-${String(index + 1).padStart(3, '0')}`)
  )
  assert.ok(identities.every((match) => match[2].length > 0))
  assert.equal([...requirements.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].length, 1)
})

test('project workflow preserves eight requirements and both reference images', () => {
  const content = readFileSync(resolve(exploratoryRoot, 'project-center/requirements.md'), 'utf8')
  const identities = [...content.matchAll(/^### .*（(PROJECT-OBS-\d{3}) · v\`([^\`]+)\`）$/gm)]
  assert.deepEqual(
    identities.map((match) => match[1]),
    Array.from({ length: 8 }, (_, index) => `PROJECT-OBS-${String(index + 1).padStart(3, '0')}`)
  )
  assert.ok(identities.every((match) => /^\d+\.\d+$/.test(match[2])))
  const references = [...content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
  assert.deepEqual(references.map((match) => match[1]).sort(), ['./form.png', './reference.png'])
})

test('page references stay portable and point to real PNG assets', () => {
  for (const page of pages) {
    const pageRoot = resolve(exploratoryRoot, page)
    const content = readFileSync(resolve(pageRoot, 'requirements.md'), 'utf8')
    const references = [...content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
    for (const reference of references) {
      assert.equal(isAbsolute(reference[1]), false)
      assert.equal(reference[1].startsWith('./'), true)
      const target = resolve(pageRoot, reference[1])
      assert.equal(dirname(target), pageRoot)
      assert.equal(existsSync(target), true)
      assert.deepEqual(
        readFileSync(target).subarray(0, 8),
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      )
    }
  }
})
