const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const vm = require('node:vm')
const { execFileSync, spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const desktopRequire = createRequire(path.resolve(__dirname, '../../apps/desktop/package.json'))
const { unzipSync } = desktopRequire('fflate')
const yaml = desktopRequire('yaml')
const { build } = desktopRequire('esbuild')
const postcss = desktopRequire('postcss')
const { buildOfficialUI, buildExample, buildArchive } = require('./build.cjs')
const { buildComponents } = require('../../apps/desktop/scripts/cd/components.cjs')
const { developmentPython } = require('../../scripts/shared/python.cjs')

test('isolated clipboard defaults reject all writes without using ambient host or browser capabilities', async () => {
  const bundle = await build({
    entryPoints: [path.join(__dirname, 'clipboard.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false,
  })
  for (const native of [true, false]) {
    const calls = []
    const record = name => async () => { calls.push(name); return { ok: true } }
    const context = {
      module: { exports: {} },
      window: native ? { scholarseed: {
        writeClipboard: record('native-text'),
        writeClipboardContent: record('native-rich'),
        writeClipboardImage: record('native-image'),
      } } : {},
      navigator: { clipboard: { writeText: record('browser-text'), write: record('browser-rich') } },
    }
    vm.runInNewContext(bundle.outputFiles[0].text, context)
    for (const operation of ['writeClipboard', 'writeClipboardContent', 'writeClipboardImage', 'copyImageElement'])
      await assert.rejects(context.module.exports[operation]('text', '<p>text</p>'), error => error.message === 'ui_clipboard_not_authorized')
    assert.deepEqual(calls, [])
  }
})

const ARCHIVE_TIMEZONES = ['UTC', 'America/Los_Angeles', 'Asia/Shanghai', 'Pacific/Kiritimati']
const ARCHIVE_BUILD_TIMEOUT_MS = 120000

test('chat UI reference generation and drift detection use the official registry', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-ui-reference-'))
  const run = mode => spawnSync(process.execPath, [path.join(__dirname, 'build.cjs'), mode, temporary], { encoding: 'utf8' })
  try {
    assert.equal(run('--write-skill-reference').status, 0)
    const reference = path.join(temporary, 'conversation.md')
    const generated = await fs.readFile(reference, 'utf8')
    assert.match(generated, /LineChart\(/)
    assert.doesNotMatch(generated, /(?:Citation|Artifact)\(/)
    assert.equal(run('--check-skill-reference').status, 0)
    await fs.writeFile(reference, generated.replace('LineChart(', 'UnknownChart('))
    const drifted = run('--check-skill-reference')
    assert.notEqual(drifted.status, 0)
    assert.match(drifted.stderr, /Chat UI reference drift: .*conversation\.md/)
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
})

test('review composition consumes the official runtime without copying React, styles or cards', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-composition-'))
  try {
    const metadata = await buildComponents(directory)
    const emitted = Object.values(metadata.outputs).flatMap(output => Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([name]) => name))
    assert.ok(emitted.every(name => !/node_modules|\/Review\.|\/Choices\.|\/components\/ui\//.test(name)), emitted.join('\n'))
    const entry = await fs.readFile(path.join(directory, 'cards.js'), 'utf8')
    assert.equal(entry, await fs.readFile(path.resolve(__dirname, '../../skills/community/literature-review/components/cards.js'), 'utf8'))
    assert.match(entry, /window\.scholarseedUI/)
    assert.doesNotMatch(entry, /createRoot|cards\.css|window\.scholarseed\b/)
    const descriptor = JSON.parse(await fs.readFile(path.resolve(__dirname, '../../skills/community/literature-review/.scholarseed-plugin.json'), 'utf8'))
    assert.equal(descriptor.ui.compatibility, '2.0')
    assert.ok(descriptor.ui.exports.includes('Conversation'))
    assert.ok(!descriptor.components.some(component => component.slot === 'literature.outline'))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('official UI compiles shared card interaction states and image gallery layout', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'official-ui-styles-'))
  try {
    await buildOfficialUI(temporary)
    const stylesheet = postcss.parse(await fs.readFile(path.join(temporary, 'ui.css'), 'utf8'))
    const rules = []
    stylesheet.walkRules(rule => rules.push(rule))
    const hasDeclaration = (selector, property, value, media) => rules.some(rule => {
      if (!rule.selector.replaceAll('\\', '').includes(selector)) return false
      if (!rule.nodes.some(node => node.type === 'decl' && node.prop === property && node.value === value)) return false
      if (!media) return true
      let parent = rule.parent
      while (parent) {
        if (parent.type === 'atrule' && parent.name === 'media' && parent.params.replaceAll(/\s/g, '').includes(media)) return true
        parent = parent.parent
      }
      return false
    })
    const expected = [
      ['group-hover/conversation-card:pointer-events-auto', 'pointer-events', 'auto'],
      ['group-hover/conversation-card:opacity-[var(--vds-opacity-full)]', 'opacity', 'var(--vds-opacity-full)'],
      ['group-focus-within/conversation-card:pointer-events-auto', 'pointer-events', 'auto'],
      ['group-focus-within/conversation-card:opacity-[var(--vds-opacity-full)]', 'opacity', 'var(--vds-opacity-full)'],
      ['[@media(hover:none)]:pointer-events-auto', 'pointer-events', 'auto', '(hover:none)'],
      ['[@media(hover:none)]:opacity-[var(--vds-opacity-full)]', 'opacity', 'var(--vds-opacity-full)', '(hover:none)'],
      ['top-[var(--vds-image-preview-stage-top)]', 'top', 'var(--vds-image-preview-stage-top)'],
      ['bottom-[var(--vds-image-preview-stage-bottom)]', 'bottom', 'var(--vds-image-preview-stage-bottom)'],
      ['inset-x-[var(--vds-image-preview-stage-inset)]', 'inset-inline', 'var(--vds-image-preview-stage-inset)'],
      ['!size-[var(--vds-image-preview-navigation-size)]', 'width', 'var(--vds-image-preview-navigation-size)'],
      ['!size-[var(--vds-image-preview-navigation-size)]', 'height', 'var(--vds-image-preview-navigation-size)'],
    ]
    assert.deepEqual(expected.filter(expectation => !hasDeclaration(...expectation)), [])
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
})

test('official UI has a complete independent resource manifest; consumers do not bundle its runtime', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'official-ui-build-'))
  const output = path.join(temporary, 'official')
  try {
    const result = await buildOfficialUI(output)
    const declarative = JSON.parse(await fs.readFile(path.join(output, 'conversation.json'), 'utf8'))
    assert.doesNotMatch(declarative.prompt, /Use Citation and Artifact|(?:CodeBlock|Separator|Citation|Artifact)\(/)
    for (const name of ['CodeBlock', 'Separator', 'Citation', 'Artifact'])
      assert.equal(Object.hasOwn(declarative.schema.properties, name), false)
    const example = await buildExample(path.join(temporary, 'example'))
    const manifest = JSON.parse(await fs.readFile(path.join(output, '.scholarseed-ui.json'), 'utf8'))
    assert.equal(manifest.compatibility, '2.0')
    assert.equal(manifest.runtime, 'ui.js')
    const canvas = JSON.parse(await fs.readFile(path.join(output, 'canvas.json'), 'utf8'))
    assert.match(canvas.prompt, /^Generate the OpenUI program for CanvasDocument.source only\./)
    for (const component of ['Stack', 'Input', 'CheckBoxGroup', 'SwitchGroup']) assert.match(canvas.prompt, new RegExp(`${component}\\(`))
    assert.doesNotMatch(canvas.prompt, /## Built-in Functions|Your ENTIRE response must/)
    assert.deepEqual(manifest.components.map(component => component.slot), ['display.literature-search', 'preview.literature-results'])
    for (const name of ['selection.js', 'choices.js']) assert.ok(!Object.keys(result.metafile.outputs).some(filename => filename.endsWith(name)))
    const inventory = JSON.parse(await fs.readFile(path.join(output, '.scholarseed-package.json'), 'utf8'))
    for (const entry of inventory.files) {
      const bytes = await fs.readFile(path.join(output, entry.path))
      assert.equal(bytes.length, entry.size)
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256)
    }
    assert.ok(inventory.files.some(entry => entry.path.endsWith('.woff2')))
    assert.ok(inventory.files.some(entry => /^iconfont-.*\.woff2$/.test(entry.path)))
    const stylesheet = await fs.readFile(path.join(output, 'ui.css'), 'utf8')
    assert.doesNotMatch(stylesheet, /url\(["']?\/src\//)
    assert.match(stylesheet, /data-icon-glyph/)
    assert.match(stylesheet, /--tw-content:\s*attr\(data-icon-glyph\)/)
    const runtime = await fs.readFile(path.join(output, 'ui.js'), 'utf8')
    assert.doesNotMatch(runtime, /window\.scholarseed\b|window\.open\(/)
    assert.ok(Object.values(result.metafile.outputs).some(entry => entry.inputs['clipboard.ts']?.bytesInOutput > 0))
    for (const [entry, bundle] of [['research.js', result], ['custom.js', example]]) {
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
      if (!example) execFileSync(developmentPython(path.resolve(__dirname, '../..')), ['-c', `
import json, sys
from pathlib import Path
from service.capabilities.service.components import ComponentRegistry
from service.capabilities.service.ui import read_ui
from service.platform.vocabulary import BRIDGE_MAX_RESPONSE_BYTES
archive = Path(sys.argv[1])
repository = Path(sys.argv[2])
registry = ComponentRegistry(archive.parent / "catalog.sqlite3")
registry.install_ui(read_ui(archive.read_bytes()))
components = registry.catalog(user_id="budget-test")
for manifest in (repository / "skills/community").glob("*/.scholarseed-plugin.json"):
    components.extend(json.loads(manifest.read_text())["components"])
summaries = [{key: value for key, value in item.items() if key not in {"input_schema", "output_schema"}} for item in components]
for mode in ("declarative", "canvas", "sandbox"):
    for detail in ("prompt", "schema"):
        selected = [item for item in components if item.get("slot") == "canvas.ui"] if mode == "canvas" else summaries
        result = {"ok": True, "components": selected, "ui": registry.ui_catalog(mode, detail)}
        assert result["ui"]["available"], (mode, detail)
        size = len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode())
        assert size <= BRIDGE_MAX_RESPONSE_BYTES, (mode, detail, size, BRIDGE_MAX_RESPONSE_BYTES)
`, first, path.resolve(__dirname, '../..')], { stdio: 'pipe' })
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

test('official and example archive CLI builds produce identical bytes across timezones', async context => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-archive-timezones-'))
  try {
    for (const mode of ['--archive', '--example']) {
      let expectedHash
      for (const [index, timezone] of ARCHIVE_TIMEZONES.entries()) {
        const output = path.join(temporary, `${mode.slice(2)}-${index}.zip`)
        const result = spawnSync(process.execPath, [path.join(__dirname, 'build.cjs'), mode, output], {
          cwd: path.resolve(__dirname, '../..'), env: { ...process.env, TZ: timezone },
          encoding: 'utf8', timeout: ARCHIVE_BUILD_TIMEOUT_MS,
        })
        assert.ifError(result.error)
        assert.equal(result.status, 0, `${mode} in ${timezone}: ${result.stderr}`)
        const bytes = await fs.readFile(output)
        const hash = crypto.createHash('sha256').update(bytes).digest('hex')
        expectedHash ??= hash
        assert.equal(hash, expectedHash, `${mode} changed in ${timezone}`)
        context.diagnostic(`${mode} ${timezone}: ${hash}`)
      }
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }) }
})
