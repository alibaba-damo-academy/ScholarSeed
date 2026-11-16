const path = require('node:path')
const crypto = require('node:crypto')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const ui = path.resolve(__dirname, '..')
const desktop = path.resolve(ui, '../../apps/desktop')
const dependency = createRequire(path.join(desktop, 'package.json'))
const { createServer, normalizePath } = dependency('vite')
const react = dependency('@vitejs/plugin-react').default
const { closedOpenUI, OPENUI_PRIMITIVES } = require('../../../apps/desktop/scripts/shared/openui.mjs')
const tailwind = dependency('@tailwindcss/postcss')
const HOST = '127.0.0.1'
const NONCE_BYTES = 18
const OPENUI_PACKAGES = ['@openuidev/react-ui', '@openuidev/react-lang', '@openuidev/lang-core']

function browserEntry(specifier) {
  const packageName = OPENUI_PACKAGES.find(name => specifier === name || specifier.startsWith(`${name}/`))
  if (!packageName) throw new Error(`Unknown OpenUI package: ${specifier}`)
  const entry = dependency.resolve(packageName)
  const root = path.resolve(path.dirname(entry), '..')
  const declaration = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const subpath = specifier.slice(packageName.length + 1)
  const exported = declaration.exports[subpath ? './*' : '.'].import
  const target = typeof exported === 'string' ? exported : exported.default
  return path.join(root, target.replace('*', subpath))
}

async function createPreview({ port }) {
  const nonce = crypto.randomBytes(NONCE_BYTES).toString('base64')
  const server = await createServer({
    configFile: false,
    root: __dirname,
    cacheDir: path.join(ui, 'node_modules/.vite-preview'),
    html: { cspNonce: nonce },
    plugins: [
      react(),
      {
        name: 'official-ui-preview',
        enforce: 'pre',
        transform(source, filename) {
          if (
            normalizePath(filename.split('?')[0]) === normalizePath(path.join(ui, 'ui.css'))
          )
            return source.replace(
              /(['"])tailwindcss\1/,
              JSON.stringify(dependency.resolve('tailwindcss/index.css'))
            )
        },
        configureServer(instance) {
          instance.middlewares.use((_request, response, next) => {
            const address = instance.httpServer.address()
            response.setHeader(
              'Content-Security-Policy',
              `default-src 'none'; script-src 'self' 'nonce-${nonce}'; worker-src 'self'; frame-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://${HOST}:${address.port}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
            )
            next()
          })
        },
      },
    ],
    resolve: {
      alias: [
        { find: '@openuidev/react-ui/components.css', replacement: dependency.resolve('@openuidev/react-ui/components.css') },
        ...[...OPENUI_PACKAGES, ...OPENUI_PRIMITIVES].map(specifier => ({ find: new RegExp(`^${specifier}$`), replacement: browserEntry(specifier) })),
        { find: /^zod\/v4$/, replacement: path.join(path.dirname(dependency.resolve('zod/package.json')), 'v4/index.js') },
        ...Object.entries({
          react: path.dirname(dependency.resolve('react/package.json')),
          'react-dom': path.dirname(dependency.resolve('react-dom/package.json')),
          'react-i18next': path.dirname(dependency.resolve('react-i18next/package.json')),
          i18next: path.dirname(dependency.resolve('i18next/package.json')),
          '/src': path.join(desktop, 'src/renderer/src'),
        }).map(([find, replacement]) => ({ find, replacement })),
      ],
      dedupe: ['react', 'react-dom', 'react-i18next', 'i18next'],
    },
    optimizeDeps: { include: [...OPENUI_PACKAGES, ...OPENUI_PRIMITIVES], esbuildOptions: { plugins: [closedOpenUI()] } },
    css: { postcss: { plugins: [tailwind({ base: desktop })] } },
    server: {
      host: HOST,
      port,
      strictPort: true,
      fs: {
        strict: true,
        allow: [
          ui,
          path.join(desktop, 'src'),
          fs.realpathSync(path.join(desktop, 'node_modules')),
        ],
        deny: ['**/.env', '**/.env.*', '**/*.{crt,pem,key}', '**/.git/**'],
      },
    },
  })
  try {
    await server.listen()
  } catch (error) {
    await server.close()
    throw error
  }
  return server
}

module.exports = { createPreview }
