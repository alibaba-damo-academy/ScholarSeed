// Font transport microbenchmarks; not Desktop/WASM acceptance.
// Browser: electron scripts/cd/fonts.cjs HELPER.js OUTPUT.json [FAMILY|'*'] [REPEATS]
// Native: electron scripts/cd/fonts.cjs --native-files FONTFILES.ts OUTPUT.json FONTS.node [REPEATS]
const { app, BrowserWindow, ipcMain, session } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')

const NATIVE_MODE = process.argv[2] === '--native-files'
const SOURCE = process.argv[NATIVE_MODE ? 3 : 2]
const OUTPUT = process.argv[NATIVE_MODE ? 4 : 3]
const NATIVE_LIBRARY = NATIVE_MODE ? process.argv[5] : null
const FAMILY = process.argv[4] || 'PingFang SC'
const REPEATS = Number(process.argv[NATIVE_MODE ? 6 : 5] || 5)
const MULTIPLIERS = [1, 2, 3]
const CATALOG_CHANNEL = 'office-font-benchmark:catalog'
const READ_CHANNEL = 'office-font-benchmark:read'
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'office-font-benchmark-'))
app.setPath('userData', PROFILE)
const server = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html')
  response.end('<!doctype html><title>Office font benchmark</title>')
})
let window

async function nativeBenchmark() {
  const source = fs.readFileSync(SOURCE, 'utf8')
  const collectionPath = path.join(path.dirname(SOURCE), 'fontcollection.ts')
  const collectionSource = fs.readFileSync(collectionPath, 'utf8')
  const compile = (filename, content) => {
    const compiled = ts.transpileModule(content, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
      fileName: filename,
    })
    const errors = compiled.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error)
    if (errors.length) throw new Error(ts.formatDiagnostics(errors, {
      getCanonicalFileName: value => value, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
    }))
    return compiled.outputText
  }
  const compiledPath = path.join(PROFILE, 'fontfiles.cjs')
  fs.writeFileSync(path.join(PROFILE, 'fontcollection.cjs'), compile(collectionPath, collectionSource))
  fs.writeFileSync(compiledPath, compile(SOURCE, source).replace('require("./fontcollection.ts")', 'require("./fontcollection.cjs")'))
  const { OfficeFontFiles } = require(compiledPath)
  const native = require(path.resolve(NATIVE_LIBRARY))
  const preload = path.join(PROFILE, 'preload.cjs')
  fs.writeFileSync(preload, `const { contextBridge, ipcRenderer } = require('electron');
    contextBridge.exposeInMainWorld('fontBenchmark', {
      catalog: () => ipcRenderer.invoke(${JSON.stringify(CATALOG_CHANNEL)}),
      read: id => ipcRenderer.invoke(${JSON.stringify(READ_CHANNEL)}, id),
    });`)
  window = new BrowserWindow({ show: false, webPreferences: { preload, nodeIntegration: false, contextIsolation: true } })
  let files, metrics
  ipcMain.handle(CATALOG_CHANNEL, async event => {
    if (event.sender !== window.webContents) throw new Error('Unexpected benchmark sender')
    const started = performance.now()
    const catalog = await files.catalog()
    metrics.catalogMs = performance.now() - started
    return catalog
  })
  ipcMain.handle(READ_CHANNEL, async (event, id) => {
    if (event.sender !== window.webContents) throw new Error('Unexpected benchmark sender')
    const started = performance.now()
    const bytes = await files.read(id)
    metrics.fileReadMs += performance.now() - started
    metrics.readCalls += 1
    metrics.readBytes += bytes.byteLength
    return bytes
  })
  await window.loadURL(`http://127.0.0.1:${server.address().port}`)
  const matrix = []
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    for (const multiplier of MULTIPLIERS.slice(repeat % MULTIPLIERS.length).concat(MULTIPLIERS.slice(0, repeat % MULTIPLIERS.length))) {
      metrics = { enumerationMs: 0, catalogMs: 0, fileReadMs: 0, readCalls: 0, readBytes: 0, nativeEntries: 0, inputEntries: 0 }
      files = new OfficeFontFiles(async () => {
        const started = performance.now()
        const faces = await native.enumerateFonts()
        metrics.enumerationMs = performance.now() - started
        metrics.nativeEntries = faces.length
        metrics.inputEntries = faces.length * multiplier
        // Match the browser workload: distinct catalog aliases share real source
        // files. Native name-table/index identity still selects the original face.
        return Array.from({ length: multiplier }, (_, copy) => faces.map(face => ({
          ...face, postscriptName: face.postscriptName + '-benchmark-' + copy,
        }))).flat()
      })
      const measured = await window.webContents.executeJavaScript(`(async () => {
        const started = performance.now();
        const catalog = await fontBenchmark.catalog();
        const catalogRoundTripMs = performance.now() - started;
        const readStarted = performance.now();
        const entries = [];
        for (const font of catalog.fonts) entries.push(await fontBenchmark.read(font.id));
        return { faceCount: catalog.faceCount, retainedEntries: entries.length,
          retainedBytes: entries.reduce((sum, bytes) => sum + bytes.byteLength, 0),
          catalogRoundTripMs, readRoundTripMs: performance.now() - readStarted,
          totalMs: performance.now() - started };
      })()`)
      const result = { repeat, multiplier, ...measured, ...metrics }
      if (result.readCalls !== result.retainedEntries || result.readBytes !== result.retainedBytes) {
        throw new Error('Native font benchmark read accounting differs')
      }
      matrix.push(result)
      console.log(JSON.stringify(result))
    }
  }
  fs.writeFileSync(OUTPUT, JSON.stringify({
    mode: 'native-files', source: path.resolve(SOURCE), native: path.resolve(NATIVE_LIBRARY),
    sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
    collectionSourceSha256: crypto.createHash('sha256').update(collectionSource).digest('hex'),
    nativeSha256: crypto.createHash('sha256').update(fs.readFileSync(NATIVE_LIBRARY)).digest('hex'),
    repeats: REPEATS, platform: process.platform, versions: process.versions,
    scope: 'real native enumeration, production OfficeFontFiles and Electron IPC; repeated metadata references; excludes WASM FS, initialization and document layout', matrix,
  }, null, 2))
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'local-fonts')
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'local-fonts'))
  server.listen(0, '127.0.0.1', async () => {
    try {
      if (NATIVE_MODE) {
        await nativeBenchmark()
        server.close()
        app.exit(0)
        return
      }
      window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } })
      await window.loadURL(`http://127.0.0.1:${server.address().port}`)
      // Instrument the real helper without changing its equality or loading behavior.
      const source = fs.readFileSync(SOURCE, 'utf8').replace(
        'function sameFontBytes(left, right) {',
        'function sameFontBytes(left, right) { const started = performance.now(); try {'
      )
      const instrumented = source.replace(
        /return true\n  }\n\n  async function readAllFontEntries/,
        'return true\n    } finally { globalThis.fontBenchmark.comparisonMs += performance.now() - started }\n  }\n\n  async function readAllFontEntries'
      )
      await window.webContents.executeJavaScript(instrumented)
      const matrix = []
      for (let repeat = 0; repeat < REPEATS; repeat += 1) {
        for (const multiplier of [...MULTIPLIERS].slice(repeat % MULTIPLIERS.length).concat(MULTIPLIERS.slice(0, repeat % MULTIPLIERS.length))) {
          const result = await window.webContents.executeJavaScript(`(async () => {
            const metrics = { blobMs: 0, arrayBufferMs: 0, digestMs: 0, comparisonMs: 0, readBytes: 0 };
            globalThis.fontBenchmark = metrics;
            const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
            crypto.subtle.digest = async (...args) => { const started = performance.now(); try { return await nativeDigest(...args) } finally { metrics.digestMs += performance.now() - started } };
            try {
              const nativeFonts = (await queryLocalFonts()).filter(font => ${JSON.stringify(FAMILY)} === '*' || font.family === ${JSON.stringify(FAMILY)});
              if (!nativeFonts.length) throw new Error('Required font family unavailable');
              const fonts = Array.from({ length: ${multiplier} }, (_, copy) => nativeFonts.map(font => ({
                postscriptName: font.postscriptName + '-benchmark-' + copy,
                fullName: font.fullName,
                blob: async () => {
                  let started = performance.now();
                  const blob = await font.blob(); metrics.blobMs += performance.now() - started;
                  return { arrayBuffer: async () => { started = performance.now(); const bytes = await blob.arrayBuffer(); metrics.arrayBufferMs += performance.now() - started; metrics.readBytes += bytes.byteLength; return bytes } };
                }
              }))).flat();
              const selected = ZetaLocalFonts.dedupeFontEntries(fonts);
              const started = performance.now();
              const entries = await ZetaLocalFonts.readAllFontEntries(selected);
              return { repeat: ${repeat}, multiplier: ${multiplier}, nativeEntries: nativeFonts.length, inputEntries: selected.length, retainedEntries: entries.length, retainedBytes: entries.reduce((sum, font) => sum + font.bytes.byteLength, 0), totalMs: performance.now() - started, ...metrics };
            } finally { crypto.subtle.digest = nativeDigest }
          })()`, true)
          matrix.push(result)
          console.log(JSON.stringify(result))
        }
      }
      fs.writeFileSync(OUTPUT, JSON.stringify({ source: SOURCE, family: FAMILY, repeats: REPEATS, platform: process.platform, versions: process.versions, scope: 'real Local Font Access and helper; excludes WASM FS, initialization and document layout', matrix }, null, 2))
      server.close()
      app.exit(0)
    } catch (error) {
      console.error(error)
      server.close()
      app.exit(1)
    }
  })
})
