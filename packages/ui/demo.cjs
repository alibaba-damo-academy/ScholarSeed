const fs = require('node:fs/promises')
const path = require('node:path')
const { buildComponents } = require('../../apps/desktop/scripts/cd/components.cjs')
const manifest = require('./manifest.json')
const narrative = require('./example/narrative.json')
const REPRESENTATIVES = require('./example/representatives.json')

const NAME = 'conversation-design-lab'
const VERSION = '1.1.1'
const COMPONENT = 'sample'
const SLOT = 'display.mock-dialogue'
const samples = [...REPRESENTATIVES, ...Object.keys(narrative).filter(name => !REPRESENTATIVES.includes(name))]

async function buildLaboratory(output) {
  await fs.mkdir(output, { recursive: true })
  const source = await fs.readFile(path.join(__dirname, 'example/laboratory.js'), 'utf8')
  const exports = [...new Set(['React', 'mount', 'Conversation', 'createLiteraturePorts', ...Array.from(source.matchAll(/\bUI\.([A-Z]\w*)/g), match => match[1])])]
  for (const name of exports) if (!manifest.exports.includes(name)) throw new Error(`demo_export_missing:${name}`)
  const descriptor = {
    schema: 2, id: NAME, version: VERSION, host: '>=0.2.0,<0.3.0', skill: 'SKILL.md',
    ui: { compatibility: manifest.compatibility, exports }, capabilities: [],
    components: [{ id: COMPONENT, slot: SLOT, entry: 'cards.js', preview: 'preview.json', input_schema: { type: 'object', properties: { sample: { enum: samples } }, required: ['sample'], additionalProperties: false }, output_schema: { type: 'object' }, actions: [] }],
  }
  await buildComponents(output, '../../packages/ui/example/entry.js')
  await fs.writeFile(path.join(output, '.scholarseed-plugin.json'), JSON.stringify(descriptor, null, 2) + '\n')
  await fs.writeFile(path.join(output, 'preview.json'), JSON.stringify({ data: { sample: 'BarChart' }, responses: {} }, null, 2) + '\n')
  await fs.writeFile(path.join(output, 'samples.json'), JSON.stringify(samples, null, 2) + '\n')
  await fs.writeFile(path.join(output, 'SKILL.md'), `---\nname: ${NAME}\nversion: ${VERSION}\ndescription: Synthetic conversation-card design samples; no real model or business actions.\n---\n\n# Conversation design laboratory\n\nMOCK only. Each sample is a separate conversation card with narrative, shared official components and explanation. Debug information is collapsed by default. All actions are local synthetic feedback; do not search, download, save, execute or modify business data. This is not Agent acceptance evidence.\n`)
  return { descriptor, samples }
}

if (require.main === module) {
  const output = process.argv[2]
  if (!output) throw new Error('demo output directory is required')
  buildLaboratory(path.resolve(output)).then(result => process.stdout.write(JSON.stringify({ output: path.resolve(output), components: result.samples.length }) + '\n')).catch(error => { console.error(error); process.exitCode = 1 })
}

module.exports = { buildLaboratory, samples }
