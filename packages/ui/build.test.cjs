const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')
const desktopRequire = createRequire(path.resolve(__dirname, '../../apps/desktop/package.json'))
const { unzipSync } = desktopRequire('fflate')
const yaml = desktopRequire('yaml')
const { buildOfficialUI, buildExample, buildArchive } = require('./build.cjs')
const { buildComponents } = require('../../apps/desktop/scripts/components.cjs')

test('review composition consumes the official runtime without copying React, styles or cards', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-composition-'))
  try {
    const metadata = await buildComponents(directory)
    const emitted = Object.values(metadata.outputs).flatMap(output => Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([name]) => name))
    assert.ok(emitted.every(name => !/node_modules|\/Review\.|\/Choices\.|\/components\/ui\//.test(name)), emitted.join('\n'))
    const entry = await fs.readFile(path.join(directory, 'cards.js'), 'utf8')
    assert.match(entry, /window\.scholarseedUI/)
    assert.doesNotMatch(entry, /createRoot|cards\.css|window\.scholarseed\b/)
    const descriptor = JSON.parse(await fs.readFile(path.resolve(__dirname, '../../skills/community/literature-review/.scholarseed-plugin.json'), 'utf8'))
    assert.equal(descriptor.ui.compatibility, '1.0')
    assert.ok(descriptor.ui.exports.includes('Conversation'))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('official UI has a complete independent resource manifest; consumers do not bundle its runtime', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'official-ui-build-'))
  const output = path.join(temporary, 'official')
  try {
    const result = await buildOfficialUI(output)
    const example = await buildExample(path.join(temporary, 'example'))
    const manifest = JSON.parse(await fs.readFile(path.join(output, '.scholarseed-ui.json'), 'utf8'))
    assert.equal(manifest.compatibility, '1.0')
    assert.equal(manifest.runtime, 'ui.js')
    assert.deepEqual(manifest.components.map(component => component.slot), ['interaction.question', 'literature.authorization', 'literature.selection', 'display.literature-search', 'preview.literature-results', 'display.literature-references', 'display.literature-downloads', 'display.literature-delivery'])
    const inventory = JSON.parse(await fs.readFile(path.join(output, '.scholarseed-package.json'), 'utf8'))
    for (const entry of inventory.files) {
      const bytes = await fs.readFile(path.join(output, entry.path))
      assert.equal(bytes.length, entry.size)
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256)
    }
    assert.ok(inventory.files.some(entry => entry.path.endsWith('.woff2')))
    const stylesheet = await fs.readFile(path.join(output, 'ui.css'), 'utf8')
    assert.match(stylesheet, /--tw-content:\s*attr\(data-icon-glyph\)/)
    assert.ok(inventory.files.some(entry => entry.path.startsWith('iconfont-') && entry.path.endsWith('.woff2')))
    const runtime = await fs.readFile(path.join(output, 'ui.js'), 'utf8')
    assert.doesNotMatch(runtime, /window\.scholarseed\b|window\.open\(/)
    for (const [entry, bundle] of [['selection.js', result], ['choices.js', result], ['research.js', result], ['custom.js', example]]) {
      const emitted = Object.entries(bundle.metafile.outputs).find(([name]) => name.endsWith(entry))[1].inputs
      assert.ok(Object.entries(emitted).every(([name, input]) => !input.bytesInOutput || !/node_modules|components\/ui/.test(name)))
    }
    const hostRegistry = await fs.readFile(path.resolve(__dirname, '../../apps/desktop/src/renderer/src/features/literature/Component.tsx'), 'utf8')
    assert.match(hostRegistry, /slot:\s*LEGACY_SELECTION,\s*legacyOnly:\s*true/)
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
})

test('official and example archives preserve the exact complete inventory and deterministic bytes', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'official-ui-archive-'))
  try {
    for (const example of [false, true]) {
      const first = path.join(temporary, `${example}.zip`)
      const second = path.join(temporary, `${example}-repeat.zip`)
      await buildArchive(first, { example })
      await buildArchive(second, { example })
      const bytes = await fs.readFile(first)
      assert.deepEqual(bytes, await fs.readFile(second))
      const files = unzipSync(bytes)
      const inventory = JSON.parse(Buffer.from(files['.scholarseed-package.json']).toString())
      assert.deepEqual(Object.keys(files).sort(), [...inventory.files.map(entry => entry.path), '.scholarseed-package.json'].sort())
      assert.ok(files[example ? '.scholarseed-plugin.json' : '.scholarseed-ui.json'])
      assert.equal(Boolean(files['ui.js']), !example)
      if (example) {
        const skill = Buffer.from(files['SKILL.md']).toString()
        const frontmatter = yaml.parse(skill.split('---')[1])
        const descriptor = JSON.parse(Buffer.from(files['.scholarseed-plugin.json']).toString())
        assert.equal(frontmatter.name, inventory.name)
        assert.equal(frontmatter.version, inventory.version)
        assert.equal(descriptor.id, inventory.name)
        assert.equal(descriptor.version, inventory.version)
      }
      for (const entry of inventory.files) assert.equal(crypto.createHash('sha256').update(files[entry.path]).digest('hex'), entry.sha256)
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }) }
})
