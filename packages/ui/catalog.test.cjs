const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs/promises')
const path = require('node:path')
const { buildOfficialUI } = require('./build.cjs')

test('independent resources publish a discoverable catalog matching the exact declared exports', async () => {
  const work = path.resolve(__dirname, '../../work/ui-catalog')
  await fs.mkdir(work, { recursive: true })
  const output = await fs.mkdtemp(path.join(work, 'build-'))
  try {
    await buildOfficialUI(output)
    const manifest = JSON.parse(await fs.readFile(path.join(output, '.scholarseed-ui.json'), 'utf8'))
    const catalog = JSON.parse(await fs.readFile(path.join(output, 'catalog.json'), 'utf8'))
    assert.equal(catalog.version, manifest.version)
    assert.equal(catalog.compatibility, manifest.compatibility)
    assert.equal(catalog.grantsPermissions, false)
    assert.deepEqual(catalog.exports, manifest.exports)
    const exports = catalog.families.flatMap(family => family.exports)
    assert.equal(new Set(exports).size, exports.length)
    for (const name of ['Card', 'Textarea', 'Dialog', 'DropdownMenuSub', 'Table', 'Select']) {
      assert.ok(exports.includes(name), `${name} is discoverable`)
    }
    for (const family of catalog.families) {
      assert.ok(family.intents.length)
      assert.ok(family.use)
      assert.ok(family.avoid)
      assert.ok(family.exports.every(name => manifest.exports.includes(name)))
    }
    assert.deepEqual(catalog.components, manifest.components)
    assert.deepEqual(Object.keys(catalog.composition.Conversation).sort(), ['Artifact', 'ArtifactDestination', 'ArtifactGroup', 'ArtifactMenuItems', 'Attachments', 'Choices', 'CitationLink', 'CitationSources', 'Code', 'ComposerRefChip', 'ConversationReference', 'Delivery', 'Details', 'Downloads', 'ExecutionBatch', 'ExecutionIO', 'ExecutionProcess', 'ExecutionStatus', 'Failure', 'FileFormatIcon', 'Formula', 'ImageThumbnail', 'ImageView', 'Images', 'Markdown', 'Message', 'Plan', 'References', 'Results', 'Review', 'Suggestions', 'Tabulation', 'ToolExecution', 'WebCitationLink', 'WebSearchRecord'])
    assert.deepEqual(catalog.composition.Conversation.Markdown.inputs, ['text', 'onOpenExternal', 'onCopy'])
    for (const slot of ['interaction.question', 'literature.authorization']) {
      assert.equal(catalog.components.find(component => component.slot === slot)?.entry, 'choices.js')
    }
    assert.equal(catalog.bridge.submit.completion, 'onState')
    assert.equal(catalog.bridge.save.advancesWorkflow, false)
    assert.equal(catalog.bridge.request.authorization, 'host')
    const inventory = JSON.parse(await fs.readFile(path.join(output, '.scholarseed-package.json'), 'utf8'))
    assert.ok(inventory.files.some(file => file.path === 'catalog.json'))
  } finally {
    await fs.rm(output, { recursive: true, force: true })
  }
})
