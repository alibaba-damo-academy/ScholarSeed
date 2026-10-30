const { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const PRODUCT_APP_ROOT_DIRECTORY = 'app-root'
const PRODUCT_CONFIG_FILE = 'product.json'
const PRODUCT_DIRECTORIES = ['out', 'resources', 'runtime']

function createProductAppRoot(artifacts, desktopRoot, browserEnabled) {
  const repository = join(artifacts, PRODUCT_APP_ROOT_DIRECTORY)
  const directory = join(repository, 'apps', 'desktop')
  mkdirSync(directory, { recursive: true })
  const scripts = join(repository, 'scripts')
  if (!existsSync(scripts)) symlinkSync(resolve(desktopRoot, '..', '..', 'scripts'), scripts,
    process.platform === 'win32' ? 'junction' : 'dir')
  for (const entry of PRODUCT_DIRECTORIES) {
    cpSync(join(desktopRoot, entry), join(directory, entry), { recursive: true })
  }
  cpSync(join(desktopRoot, 'package.json'), join(directory, 'package.json'))
  mkdirSync(join(directory, 'node_modules'), { recursive: true })
  const manifestPath = join(directory, 'resources', PRODUCT_CONFIG_FILE)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, features: { ...manifest.features, browser: browserEnabled } }, null, 2))
  return directory
}

module.exports = { createProductAppRoot }
