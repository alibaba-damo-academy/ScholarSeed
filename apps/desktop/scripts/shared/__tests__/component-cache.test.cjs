const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const cache = require('../component-cache.cjs')
const state = require('../build-state.cjs')
const { developmentPython } = require('../../../../../scripts/shared/python.cjs')
const REPO = path.resolve(__dirname, '../../../../..')
const PYTHON = process.env.TEST_PYTHON || developmentPython(REPO, process.env.VENV, { context: process.env.CI ? 'ci' : 'local' })
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cache-contract-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const archive = path.join(root, 'source.zip')
  const python = PYTHON
  execFileSync(python, ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],"w");z.writestr("python/Lib/example.py","value=42\\n");z.close()', archive])
  const inputs = {kind:'python',target:'win32-x86_64',contentId:'a'.repeat(64),recipe:{tool:'locked'},skillWheels:[]}
  return {root,archive,python,inputs,measured:cache.measure(python,archive,process.env)}
}
test('cache miss, atomic publish and exact input hit exercise real ZIP inventory', t => {
  const f=fixture(t), root=path.join(f.root,'cache')
  assert.equal(cache.lookup(root,f.inputs,f.python,process.env),null)
  cache.publish(root,f.inputs,f.archive,f.measured,{bytecode:{sources:1}})
  const entry=cache.lookup(root,f.inputs,f.python,process.env)
  assert.equal(entry.inventory.archiveSha256,f.measured.archiveSha256)
  assert.equal(entry.evidence.bytecode.sources,1)
  for (const field of ['target','contentId','recipe','skillWheels']) {
    assert.equal(cache.lookup(root,{...f.inputs,[field]:field==='recipe'?{tool:'changed'}:'changed'},f.python,process.env),null)
  }
  cache.publish(root,f.inputs,f.archive,f.measured,{bytecode:{sources:1}})
  assert.equal(fs.readdirSync(root).length,1)
})
test('corrupt archive is refused instead of producing a hit',t=>{
  const f=fixture(t),root=path.join(f.root,'cache');cache.publish(root,f.inputs,f.archive,f.measured,{})
  fs.appendFileSync(path.join(root,cache.key(f.inputs),'component.zip'),'changed')
  assert.throws(()=>cache.lookup(root,f.inputs,f.python,process.env),/digest mismatch/)
})
test('incomplete publication and changed receipt are refused',t=>{
  const f=fixture(t),root=state.ensurePrivateDirectory(path.join(f.root,'cache')),entry=path.join(root,cache.key(f.inputs))
  fs.mkdirSync(entry,{mode:0o700});fs.writeFileSync(path.join(entry,'receipt.json'),'{}')
  assert.throws(()=>cache.lookup(root,f.inputs,f.python,process.env),/incomplete/)
  fs.rmSync(entry,{recursive:true});cache.publish(root,f.inputs,f.archive,f.measured,{})
  const receipt=path.join(entry,'receipt.json'),value=JSON.parse(fs.readFileSync(receipt));value.inputs.recipe={tool:'foreign'};fs.writeFileSync(receipt,JSON.stringify(value))
  assert.throws(()=>cache.lookup(root,f.inputs,f.python,process.env),/input mismatch/)
})
test('linked state and paths escaping the frozen root are refused',t=>{
  const f=fixture(t);assert.throws(()=>state.inside(f.root,path.dirname(f.root)),/escapes/)
  const link=path.join(f.root,'alias');fs.symlinkSync(f.root,link,process.platform==='win32'?'junction':'dir')
  assert.throws(()=>state.ensurePrivateDirectory(link),/invalid build state/)
})
test('full inventory rejects foreign roots even with a rewritten digest',t=>{
  const f=fixture(t)
  execFileSync(f.python,['-c','import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],"a");z.writestr("foreign/injected.exe","bad");z.close()',f.archive])
  assert.throws(()=>cache.measure(f.python,f.archive,process.env,'python'),/component_archive_root/)
})
test('two actual publishers converge on one immutable complete entry',async t=>{
  const f=fixture(t),root=path.join(f.root,'cache')
  state.ensurePrivateDirectory(root)
  const {spawn}=require('node:child_process')
  const program='const c=require(process.argv[1]);c.publish(process.argv[2],JSON.parse(process.argv[3]),process.argv[4],JSON.parse(process.argv[5]),{})'
  const run=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['-e',program,require.resolve('../component-cache.cjs'),root,JSON.stringify(f.inputs),f.archive,JSON.stringify(f.measured)],{stdio:'ignore'});child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error('publisher failed '+code)))})
  await Promise.all([run(),run()])
  assert.equal(fs.readdirSync(root).length,1)
  assert.equal(cache.lookup(root,f.inputs,f.python,process.env).inventory.archiveSha256,f.measured.archiveSha256)
})

test('same input cannot publish different valid archive bytes', t => {
  const f = fixture(t), root = path.join(f.root, 'cache')
  cache.publish(root, f.inputs, f.archive, f.measured, {})
  execFileSync(f.python, ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],"a");z.writestr("python/changed.py","different");z.close()', f.archive])
  const changed = cache.measure(f.python, f.archive, process.env)
  assert.throws(() => cache.publish(root, f.inputs, f.archive, changed, {}), /reproducibility conflict/)
  assert.equal(cache.lookup(root, f.inputs, f.python, process.env).inventory.archiveSha256, f.measured.archiveSha256)
})

// The reusable member list is process-local; persisted schema-2 receipts stay compact.
test('full member inventory survives a verified copy and rejects later ZIP changes', t => {
  const f = fixture(t), root = path.join(f.root, 'cache')
  cache.publish(root, f.inputs, f.archive, f.measured, {})
  const entry = cache.lookup(root, f.inputs, f.python, process.env)
  assert.deepEqual(cache.summary(entry.fullInventory), entry.inventory)
  assert.deepEqual(entry.fullInventory.files.map(file => file.path), ['python/Lib/example.py'])
  const receipt = JSON.parse(fs.readFileSync(path.join(root, cache.key(f.inputs), 'receipt.json')))
  assert.equal(receipt.inventory.files, undefined)
  const copy = path.join(f.root, 'final.zip')
  fs.copyFileSync(entry.archive, copy)
  assert.equal(cache.reuse(copy, entry.fullInventory), entry.fullInventory)
  fs.appendFileSync(copy, 'changed')
  assert.throws(() => cache.reuse(copy, entry.fullInventory), /changed after inventory/)
})
