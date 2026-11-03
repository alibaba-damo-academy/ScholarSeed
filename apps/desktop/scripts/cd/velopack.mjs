// Bundle the official SDK JS; the sealed native inventory owns the Windows addon.
// macOS imports the inert JS facade and never loads or invokes a Velopack addon.
export function velopackLoader(platform = process.platform) {
  return {
    name: 'scholarseed-velopack-loader',
    enforce: 'pre',
    resolveId(source) {
      if (source === './velopack.node') return { id: source, external: true }
    },
    load(id) {
      if (id.replaceAll('\\', '/').endsWith('/node_modules/velopack/lib/load.js')) {
        return platform === 'win32'
          ? `module.exports = require('./velopack.node');`
          : `module.exports = {};`
      }
    },
  }
}
