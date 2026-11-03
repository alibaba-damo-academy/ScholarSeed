// Vite owns emission; seal owns compilation, signatures and the frozen bytes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sealing = require('../cd/seal.cjs')
const { LIBRARIES } = require('../../native/libraries.cjs')

const CONTEXT_ENV = 'SCHOLARSEED_BUILD_CONTEXT'

export function nativeLease({ command } = {}) {
  let prepared
  const development = command === 'serve'
  return {
    name: 'scholarseed-native-lease',
    async buildStart() {
      const contextPath = process.env[CONTEXT_ENV]
      if (contextPath) {
        const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'))
        if (context.schema !== 3 || context.file !== contextPath || !context.native)
          throw new Error('native lease requires the frozen packaging context')
        const files = sealing.readNative(path.join(context.runDirectory, 'native'), context.native)
        for (const name of LIBRARIES) this.emitFile({ type: 'asset', fileName: name, source: files.get(name) })
        return
      }
      // A dev process compiles once. Watch rebuilds emit the same verified bytes;
      // restarting the builder selects new C sources or toolchain policy.
      if (!prepared) {
        prepared = (async () => {
          const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-vite-native-'))
          try {
            const directory = path.join(temporary, 'native')
            const frozen = await sealing.prepareNative({
              directory,
              signing: { mode: process.platform === 'darwin' ? 'ad-hoc-local-only' : 'unsigned-dev' },
              runContract: !development || process.env.SCHOLARSEED_NATIVE_CONTRACT_TEST === '1',
              artifacts: JSON.parse(process.env.SCHOLARSEED_NATIVE_ARTIFACTS || '{}'),
            })
            return sealing.readNative(directory, frozen)
          } finally {
            fs.rmSync(temporary, { recursive: true, force: true })
          }
        })()
      }
      const files = await prepared
      for (const name of LIBRARIES) this.emitFile({ type: 'asset', fileName: name, source: files.get(name) })
    },
  }
}
