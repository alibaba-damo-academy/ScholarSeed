/* SPDX-License-Identifier: MIT */
;(function expose(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.ScholarSeedFontCache = api
})(typeof globalThis === 'undefined' ? undefined : globalThis, function createFontCache() {
  'use strict'
  const DEPENDENCY = 'office-fontconfig-cache'
  const CONFIG_DIRECTORY = '/instdir/share/fontconfig'
  const CONFIG_FILE = CONFIG_DIRECTORY + '/fonts.conf'
  const CACHE_DIRECTORY = CONFIG_DIRECTORY + '/cache'

  function register(module, options) {
    let entered = false,
      preparing = false,
      pending = 0,
      resolve
    const done = new Promise((value) => {
      resolve = value
    })
    const monitor = module.monitorRunDependencies
    const prepare = () => {
      if (!entered || preparing || pending !== 1) return
      preparing = true
      queueMicrotask(async () => {
        if (pending !== 1) {
          preparing = false
          return
        }
        if (options.isDisposed()) {
          resolve()
          return
        }
        try {
          await options.prepare(options.getFs())
        } catch (error) {
          options.onError?.(error)
        } finally {
          if (!options.isDisposed()) module.removeRunDependency(DEPENDENCY)
          resolve()
        }
      })
    }
    module.monitorRunDependencies = (count) => {
      pending = count
      monitor?.(count)
      prepare()
    }
    function enter() {
      if (entered || options.isDisposed()) return
      // The loader schedules runWithFS after asynchronous metadata. Holding a
      // dependency before that callback runs would deadlock package installation.
      if (!options.getFs().analyzePath(CONFIG_FILE).exists) {
        module.preRun.push(enter)
        return
      }
      entered = true
      module.addRunDependency(DEPENDENCY)
      prepare()
    }
    module.preRun = module.preRun || []
    module.preRun.push(enter)
    return done
  }

  function restore(fs, cache) {
    fs.mkdirTree(CACHE_DIRECTORY)
    for (const file of cache.files) fs.writeFile(CACHE_DIRECTORY + '/' + file.name, file.bytes)
    // Only restore directory times after every font and package file is installed.
    for (const directory of cache.directories)
      fs.utime(directory.path, directory.mtime, directory.mtime)
  }

  async function generate(fs, entries, createGenerator, isDisposed) {
    const generator = await createGenerator()
    if (isDisposed()) return null
    const stamps = []
    const directories = entries.map((entry) => ({
      path: entry.path,
      mtime: fs.stat(entry.path).mtime.getTime(),
    }))
    function copy(path) {
      const stat = fs.stat(path)
      if (fs.isDir(stat.mode)) {
        generator.FS.mkdirTree(path)
        stamps.push({ path, mtime: stat.mtime.getTime() })
        for (const name of fs.readdir(path))
          if (name !== '.' && name !== '..') copy(path + '/' + name)
      } else {
        // Pinned Emscripten MEMFS adapter: share existing byte views, never copy
        // the full system font inventory or transfer ownership away from Office.
        const node = fs.lookupPath(path).node
        if (
          !(node.contents instanceof Uint8Array) ||
          !Number.isInteger(node.usedBytes) ||
          node.usedBytes < 0 ||
          node.usedBytes > node.contents.length
        )
          throw new Error('Unsupported Office MEMFS font storage')
        generator.FS.writeFile(path, node.contents.subarray(0, node.usedBytes), { canOwn: true })
      }
    }
    for (const entry of entries) copy(entry.path)
    copy(CONFIG_DIRECTORY)
    for (const entry of stamps) generator.FS.utime(entry.path, entry.mtime, entry.mtime)
    generator.FS.mkdirTree(CACHE_DIRECTORY)
    const count = generator._generate()
    if (count <= 0) throw new Error('Fontconfig cache generation failed')
    const files = entries.map((entry) => ({
      name: entry.name,
      bytes: generator.FS.readFile(CACHE_DIRECTORY + '/' + entry.name),
    }))
    return { files, directories }
  }
  return { register, restore, generate }
})
