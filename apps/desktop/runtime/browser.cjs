// Desktop-owned browser runtime paths, shared by startup and artifact verification.
const fs = require('node:fs')
const path = require('node:path')

const BROWSER_NODE_RELATIVE = 'backend/browser/node'
const BUNDLED_PYTHON_RELATIVE = 'backend/python/bin/python3'
const BROWSER_NODE_ENV = 'PLAYWRIGHT_NODEJS_PATH'
const NODE_CONFIGURATION_ENV = ['NODE_OPTIONS', 'NODE_PATH']

function browserEnvironment(environment, resourcesRoot, python, packaged = true) {
  const result = { ...environment }
  const bundledPython = path.resolve(resourcesRoot, BUNDLED_PYTHON_RELATIVE)
  if (!packaged) return result
  const sameBin = fs.existsSync(python) && fs.existsSync(bundledPython)
    && fs.realpathSync(path.dirname(python)) === fs.realpathSync(path.dirname(bundledPython))
    && fs.realpathSync(python) === fs.realpathSync(bundledPython)
  if (path.resolve(python) !== bundledPython && !sameBin) return result
  const node = path.resolve(resourcesRoot, BROWSER_NODE_RELATIVE)
  const root = fs.realpathSync(resourcesRoot) + path.sep
  if (!fs.lstatSync(node).isFile() || !fs.realpathSync(node).startsWith(root)) {
    throw new Error('bundled browser Node is not a regular product file')
  }
  fs.accessSync(node, fs.constants.X_OK)
  for (const key of NODE_CONFIGURATION_ENV) delete result[key]
  result[BROWSER_NODE_ENV] = node
  return result
}

module.exports = { BROWSER_NODE_RELATIVE, BUNDLED_PYTHON_RELATIVE, BROWSER_NODE_ENV, browserEnvironment }
