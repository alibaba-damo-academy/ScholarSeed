// 固定版本 osx-sign 的递归扫描在检查 ignore 之前读取所有资源。
// 逐个读取文件头，保留原有二进制判定并限制同时打开的文件数量。
const { createRequire } = require('node:module')
const signingRequire = createRequire(require.resolve('@electron/osx-sign'))
const binary = signingRequire('isbinaryfile')
binary.isBinaryFile = async (...args) => binary.isBinaryFileSync(...args)

module.exports = {
  ...require('@electron/osx-sign'),
  ...require('@electron/osx-sign/dist/cjs/util'),
}
