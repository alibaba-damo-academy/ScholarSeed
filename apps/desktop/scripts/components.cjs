const path = require('node:path')
const { build } = require('esbuild')

const ROOT = path.resolve(__dirname, '..')
const ENTRY = '../../packages/ui/review.tsx'
const FORBIDDEN_INPUTS = [/\/store\//, /\/store\.tsx?$/, /\/api\.tsx?$/, /\/literature\/catalog\.ts$/, /\/fileOpen\.ts$/]

async function buildComponents(output) {
  const result = await build({
    absWorkingDir: ROOT, entryPoints: { cards: ENTRY }, outdir: output,
    bundle: true, minify: true, format: 'iife', platform: 'browser', jsx: 'transform',
    tsconfigRaw: { compilerOptions: { jsx: 'react' } },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' }, metafile: true,
  })
  const emitted = Object.values(result.metafile.outputs).flatMap(output => Object.entries(output.inputs).filter(([, contribution]) => contribution.bytesInOutput > 0).map(([input]) => input))
  const forbidden = emitted.filter(input => FORBIDDEN_INPUTS.some(pattern => pattern.test(`/${input}`)))
  if (forbidden.length) throw new Error(`component includes host implementation: ${forbidden.join(', ')}`)
  const duplicated = emitted.filter(input => /node_modules|\/Review\.|\/Choices\.|\/components\/ui\//.test(input))
  if (duplicated.length) throw new Error(`component duplicates official UI: ${duplicated.join(', ')}`)
  return result.metafile
}

if (require.main === module) {
  const output = process.argv[2]
  if (!output) throw new Error('component output directory is required')
  buildComponents(path.resolve(output)).then(() => console.log('Component bundle built without host implementation')).catch(error => { console.error(error); process.exitCode = 1 })
}
module.exports = { buildComponents }
