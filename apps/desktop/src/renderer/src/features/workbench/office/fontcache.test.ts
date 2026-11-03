import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
const require = createRequire(import.meta.url)
const { register } = require('./fontcache.js')

test('cache gate waits for package installation and remaining font dependencies', async () => {
  let dependencies = 0,
    installed = false,
    prepared = 0
  const fs = { analyzePath: () => ({ exists: installed }) }
  const module = {
    preRun: [] as Array<() => void>,
    monitorRunDependencies: (_count: number) => {},
    addRunDependency: (_name: string) => {
      module.monitorRunDependencies(++dependencies)
    },
    removeRunDependency: (_name: string) => {
      module.monitorRunDependencies(--dependencies)
    },
  }
  const done = register(module, {
    getFs: () => fs,
    isDisposed: () => false,
    prepare: async () => {
      prepared++
    },
  })
  module.preRun.shift()!()
  assert.equal(dependencies, 0, 'do not block metadata from scheduling runWithFS')
  installed = true
  module.addRunDependency('fonts')
  module.preRun.shift()!()
  await Promise.resolve()
  assert.equal(prepared, 0)
  module.removeRunDependency('fonts')
  await done
  assert.equal(prepared, 1)
  assert.equal(dependencies, 0)
})

test('cache preparation failure releases the optional index gate and reports the error', async () => {
  let dependencies = 0,
    reported = ''
  const module = {
    preRun: [] as Array<() => void>,
    monitorRunDependencies: (_count: number) => {},
    addRunDependency: () => {
      module.monitorRunDependencies(++dependencies)
    },
    removeRunDependency: () => {
      module.monitorRunDependencies(--dependencies)
    },
  }
  const done = register(module, {
    getFs: () => ({ analyzePath: () => ({ exists: true }) }),
    isDisposed: () => false,
    prepare: async () => {
      throw new Error('unavailable')
    },
    onError: (error: Error) => {
      reported = error.message
    },
  })
  module.preRun.shift()!()
  await done
  assert.equal(reported, 'unavailable')
  assert.equal(dependencies, 0)
})

test('disposing during cache I/O never resumes the abandoned engine', async () => {
  let disposed = false,
    released = 0
  let finish!: () => void
  const waiting = new Promise<void>((resolve) => {
    finish = resolve
  })
  const module = {
    preRun: [] as Array<() => void>,
    monitorRunDependencies: (_count: number) => {},
    addRunDependency: () => {
      module.monitorRunDependencies(1)
    },
    removeRunDependency: () => {
      released++
    },
  }
  const done = register(module, {
    getFs: () => ({ analyzePath: () => ({ exists: true }) }),
    isDisposed: () => disposed,
    prepare: () => waiting,
  })
  module.preRun.shift()!()
  await Promise.resolve()
  disposed = true
  finish()
  await done
  assert.equal(released, 0)
})
