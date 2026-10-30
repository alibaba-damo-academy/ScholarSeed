import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'vite'
import { runInNewContext } from 'node:vm'
import { velopackLoader } from '../velopack.mjs'

test('generated addon imports remain relative to the emitted bundle and explicitly external', () => {
  for (const platform of ['darwin', 'win32']) {
    const plugin = velopackLoader(platform)
    const requested = []
    runInNewContext(plugin.load('/fixture/node_modules/velopack/lib/load.js'), {
      module: { exports: {} },
      require(name) { requested.push(name); return {} }
    })
    assert.deepEqual(requested, platform === 'win32' ? ['./velopack.node'] : [])
    for (const name of requested) assert.deepEqual(plugin.resolveId(name), { id: name, external: true })
    assert.equal(plugin.resolveId('../velopack.node'), undefined)
  }
})

test('SDK is statically bundled and macOS never imports a native Velopack addon', async () => {
  for (const platform of ['darwin', 'win32']) {
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [velopackLoader(platform)],
      build: {
        write: false,
        minify: false,
        lib: { entry: 'node_modules/velopack/lib/index.js', formats: ['cjs'] },
      },
    })
    const code = (Array.isArray(result) ? result[0] : result).output.find(
      (item) => item.type === 'chunk'
    ).code
    const requested = []
    runInNewContext(code, {
      module: { exports: {} },
      exports: {},
      require: (name) => {
        requested.push(name)
        return {}
      },
    })
    assert.deepEqual(requested, platform === 'win32' ? ['./velopack.node'] : [])
    assert.ok(!code.includes('@neon-rs'))
  }
})
