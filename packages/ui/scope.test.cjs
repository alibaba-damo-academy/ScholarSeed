const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs/promises')
const path = require('node:path')
const { buildOfficialUI } = require('./build.cjs')

const removed = [
  'Message', 'Attachments', 'ComposerRefChip', 'ConversationReference', 'SelectionReference',
  'ExecutionProcess', 'ExecutionBatch', 'ToolExecution', 'ExecutionStatus', 'ExecutionIO',
  'WebSearchRecord', 'Plan', 'Choices', 'Suggestions', 'Failure', 'EmptyAnswer',
  'Images', 'ImageThumbnail', 'ImageView',
  'EvidenceSelection', 'ArtifactPreview', 'WebCitationLink', 'Lean',
  'Code', 'Diagram', 'Content',
]
const retained = [
  'Markdown', 'Formula', 'Tabulation', 'DataTable',
  'Artifact', 'ArtifactGroup',
  'ArtifactDestination', 'FileFormatIcon', 'FileMenuItems', 'Canvas',
  'CitationLink', 'CitationSources',
  'Results', 'Details', 'Review',
]

test('published independent Plot contracts retain chart export metadata', async () => {
  const directory = path.resolve(__dirname, '../../skills/community/scholarseed-product-operations')
  const plugin = JSON.parse(await fs.readFile(path.join(directory, '.scholarseed-plugin.json'), 'utf8'))
  const reference = JSON.parse(await fs.readFile(path.join(directory, 'references/scholarseed-chat-ui/guides/plot/schema.json'), 'utf8'))
  const published = plugin.components.find(component => component.id === 'plot').input_schema
  assert.deepEqual(published, reference)
  for (const field of ['notes', 'version']) assert.equal(published.properties[field]?.type, 'string', field)
})

test('official resources exclude native-only UI and retain answer and artifact capabilities', async () => {
  const work = path.resolve(__dirname, '../../work/ui-scope')
  await fs.mkdir(work, { recursive: true })
  const output = await fs.mkdtemp(path.join(work, 'resources-'))
  try {
    await buildOfficialUI(output)
    const catalog = JSON.parse(await fs.readFile(path.join(output, 'catalog.json'), 'utf8'))
    const manifest = JSON.parse(await fs.readFile(path.join(output, '.scholarseed-ui.json'), 'utf8'))
    const inventory = JSON.parse(await fs.readFile(path.join(output, '.scholarseed-package.json'), 'utf8'))
    const exports = Object.keys(catalog.composition.Conversation)
    for (const name of removed) assert.ok(!exports.includes(name), `${name} remains public`)
    for (const name of retained) assert.ok(exports.includes(name), `${name} was removed`)
    assert.equal(exports.length, 29)
    assert.ok(!exports.includes('References'))
    const citationInputs = catalog.composition.Conversation.CitationLink.inputs
    for (const input of ['resolve', 'source', 'openWebSource']) assert.ok(citationInputs.includes(input))
    for (const name of ['EvidenceSelection', 'ArtifactPreview'])
      assert.ok(!manifest.exports.includes(name), `${name} remains at runtime root`)
    for (const slot of ['interaction.question', 'literature.authorization'])
      assert.ok(!manifest.components.some(component => component.slot === slot), `${slot} still uses an iframe`)
    assert.ok(!inventory.files.some(resource => resource.path === 'choices.js'))
    assert.ok(!manifest.components.some(component => component.slot === 'literature.selection'))
    assert.ok(!inventory.files.some(file => file.path === 'selection.js'))
    const nativeLean = await fs.readFile(path.resolve(__dirname, '../../apps/desktop/src/renderer/src/features/workbench/lean.ts'), 'utf8')
    assert.match(nativeLean, /LEAN_LANGUAGE_ID = 'lean'/)
    const nativeSyntax = await fs.readFile(path.resolve(__dirname, '../../apps/desktop/src/renderer/src/features/workbench/syntax.ts'), 'utf8')
    assert.match(nativeSyntax, /id: LEAN_LANGUAGE_ID, configuration: LEAN_CONFIGURATION, language: LEAN_LANGUAGE/)
    const nativeEditor = await fs.readFile(path.resolve(__dirname, '../../apps/desktop/src/renderer/src/features/workbench/MonacoDocument.tsx'), 'utf8')
    assert.match(nativeEditor, /languageFor\(session\.source\.path\)/)
    assert.doesNotMatch(nativeEditor, /<Lean/)
    const plugin = JSON.parse(await fs.readFile(path.resolve(__dirname, '../../skills/community/scholarseed-product-operations/.scholarseed-plugin.json'), 'utf8'))
    assert.ok(!plugin.components.some(component => ['research-evidence.select', 'artifacts-workbench.preview'].includes(component.slot)))
    for (const id of ['results', 'details']) assert.ok(plugin.components.some(component => component.id === id && component.public), id)
    assert.ok(!plugin.components.some(component => ['references', 'downloads', 'delivery'].includes(component.id)))
  } finally {
    await fs.rm(output, { recursive: true, force: true })
  }
})
