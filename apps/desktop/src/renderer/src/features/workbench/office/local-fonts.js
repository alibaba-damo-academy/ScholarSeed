/* SPDX-License-Identifier: MIT */

(function exposeLocalFontHelpers(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.ZetaLocalFonts = api
})(typeof globalThis === 'undefined' ? undefined : globalThis, function createLocalFontHelpers() {
  'use strict'

  const FONT_DIGEST_ALGORITHM = 'SHA-256'
  const FONT_COMPARISON_WORD_BYTES = Uint32Array.BYTES_PER_ELEMENT
  const LIBREOFFICE_FONT_DIRECTORY = '/instdir/share/fonts/truetype'
  const FONT_RUN_DEPENDENCY = 'office-system-fonts'
  const FONT_ERROR_NAMES = new Set(['Error', 'ErrnoError', 'TypeError', 'RangeError', 'DOMException', 'AbortError'])
  const FONT_ERROR_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOMEM', 'ENOSPC', 'EIO'])

  function fontErrorDiagnostic(error) {
    return {
      errorName: FONT_ERROR_NAMES.has(error?.name) ? error.name : 'unknown',
      ...(Number.isSafeInteger(error?.errno) ? { errno: error.errno } : {}),
      ...(FONT_ERROR_CODES.has(error?.code) ? { errorCode: error.code } : {}),
    }
  }

  function reportFontFailure(report, operation, error, counts) {
    try { report?.({ operation, ...fontErrorDiagnostic(error), ...counts }) }
    catch { /* Diagnostics must not change font preparation. */ }
  }

  function normalizeFontIdentity(value) {
    return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
  }

  function dedupeFontEntries(fonts) {
    const seen = new Set()
    return fonts.filter((font) => {
      const key = font.postscriptName || [font.family, font.fullName, font.style].join('\u0000')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  function sanitizeFontName(name) {
    const ascii = String(name || '').normalize('NFKD').replace(/[^\x20-\x7e]/g, '')
    const safe = ascii.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '').slice(0, 96)
    return safe || 'local-font'
  }

  function selectFontEntries(fonts, requiredFamilies) {
    const uniqueFonts = dedupeFontEntries(fonts)
    const required = []
    const requiredByIdentity = new Map()
    for (const family of requiredFamilies) {
      const identity = normalizeFontIdentity(family)
      if (!identity || requiredByIdentity.has(identity)) continue
      requiredByIdentity.set(identity, family)
      required.push(identity)
    }

    const matchedIdentities = new Set()
    const selected = uniqueFonts.filter((font) => {
      const identities = [font.family, font.fullName, font.postscriptName]
        .map(normalizeFontIdentity)
        .filter(Boolean)
      const matches = required.filter((identity) => identities.includes(identity))
      for (const identity of matches) matchedIdentities.add(identity)
      return matches.length > 0
    })

    return {
      fonts: selected,
      matched: required.filter((identity) => matchedIdentities.has(identity)).map((identity) => requiredByIdentity.get(identity)),
      missing: required.filter((identity) => !matchedIdentities.has(identity)).map((identity) => requiredByIdentity.get(identity)),
    }
  }

  function detectFontExtension(bytes) {
    const signature = String.fromCharCode(...bytes.slice(0, 4))
    if (signature === 'OTTO') return '.otf'
    if (signature === 'ttcf') return '.ttc'
    if (signature === 'true' || signature === 'typ1') return '.ttf'
    if (bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return '.ttf'
    return '.font'
  }

  async function readFontEntry(font, index = 0) {
    const blob = font.sourceBlob || await font.blob()
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const baseName = sanitizeFontName(font.postscriptName || font.fullName || font.family || blob.name || `local-font-${index}`)
    return { bytes, filename: baseName + detectFontExtension(bytes), label: font.fullName || font.family || blob.name || baseName }
  }

  function sameFontBytes(left, right) {
    if (left.byteLength !== right.byteLength) return false
    // readFontEntry creates full, aligned Uint8Arrays from Blob.arrayBuffer().
    const wordCount = Math.floor(left.byteLength / FONT_COMPARISON_WORD_BYTES)
    const leftWords = new Uint32Array(left.buffer, left.byteOffset, wordCount)
    const rightWords = new Uint32Array(right.buffer, right.byteOffset, wordCount)
    for (let index = 0; index < wordCount; index += 1) {
      if (leftWords[index] !== rightWords[index]) return false
    }
    for (let offset = wordCount * FONT_COMPARISON_WORD_BYTES; offset < left.byteLength; offset += 1) {
      if (left[offset] !== right[offset]) return false
    }
    return true
  }

  async function readAllFontEntries(fonts, onProgress, onUnavailable = (font, error) => console.warn('Office system font unavailable', font.postscriptName || font.family, String(error))) {
    if (!fonts.length) return []
    const entries = []
    let loadedBytes = 0
    const containers = new Map()
    for (const [index, font] of fonts.entries()) {
      let entry
      try {
        entry = await readFontEntry(font, index)
      } catch (error) {
        onUnavailable(font, error)
      }
      if (entry) {
        loadedBytes += entry.bytes.byteLength
        const digest = new Uint8Array(await globalThis.crypto.subtle.digest(FONT_DIGEST_ALGORITHM, entry.bytes))
        const key = `${entry.bytes.byteLength}:${Array.from(digest).join(',')}`
        const candidates = containers.get(key) || []
        // A digest only narrows candidates: byte equality preserves all distinct fonts.
        if (!candidates.some(candidate => sameFontBytes(candidate.bytes, entry.bytes))) {
          candidates.push(entry)
          containers.set(key, candidates)
          entries.push(entry)
        }
      }
      if (onProgress) onProgress(index + 1, fonts.length, loadedBytes)
    }
    return entries
  }

  async function readFontFiles(files, readFile, onProgress, onDiagnostic) {
    const entries = []
    let loadedBytes = 0
    for (const file of files) {
      let bytes
      try { bytes = await readFile(file.id) }
      catch (error) {
        reportFontFailure(onDiagnostic, 'source-read', error, {
          completedFonts: entries.length, totalFonts: files.length, completedBytes: loadedBytes
        })
        throw error
      }
      if (!bytes.byteLength) throw new Error('Office font file is empty')
      entries.push({ bytes, filename: file.filename, label: file.filename })
      loadedBytes += bytes.byteLength
      if (onProgress) onProgress(entries.length, files.length, loadedBytes)
    }
    return entries
  }

  async function readFontAssets(assets, fetchAsset = fetch) {
    const entries = []
    for (const asset of assets) {
      const response = await fetchAsset(asset.url)
      if (!response.ok) throw new Error(`Office runtime font ${asset.filename} unavailable (${response.status})`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (!bytes.byteLength) throw new Error(`Office runtime font ${asset.filename} is empty`)
      entries.push({ bytes, filename: asset.filename, label: asset.filename })
    }
    return entries
  }

  function registerFontsInPreRun(moduleConfig, fontsReady, options = {}) {
    let resolveInstalled, rejectInstalled, entered = false
    const installed = new Promise((resolve, reject) => { resolveInstalled = resolve; rejectInstalled = reject })
    // Observe preparation failures immediately, even if WASM has not reached preRun.
    const prepared = Promise.resolve(fontsReady).catch(error => { rejectInstalled(error); return null })
    moduleConfig.preRun = moduleConfig.preRun || []
    moduleConfig.preRun.push(function waitForLocalFonts() {
      if (entered) return
      entered = true
      // preRun is synchronous: acquire the gate before attaching asynchronous work.
      moduleConfig.addRunDependency(FONT_RUN_DEPENDENCY)
      void prepared.then(fonts => {
        if (options.isDisposed?.()) { resolveInstalled(); return }
        if (!fonts) return
        try {
          installFonts(fonts, options.getFs ? options.getFs() : globalThis.FS, options.onDiagnostic)
          options.onInstalled?.()
          moduleConfig.removeRunDependency(FONT_RUN_DEPENDENCY)
          resolveInstalled()
        } catch (error) { rejectInstalled(error) }
      })
    })
    return installed
  }

  function installFonts(fonts, fs, onDiagnostic) {
    let completedFonts = 0, completedBytes = 0
    try { fs.mkdirTree(LIBREOFFICE_FONT_DIRECTORY) }
    catch (error) {
      reportFontFailure(onDiagnostic, 'wasm-directory', error, {
        completedFonts, completedBytes, totalFonts: fonts.length
      })
      throw error
    }
    const filenames = new Set()
    for (const font of fonts) {
      const preferredName = sanitizeFontName(font.filename.replace(/\.(ttf|otf|ttc|font)$/i, ''))
        + (font.filename.match(/\.(ttf|otf|ttc|font)$/i)?.[0].toLowerCase() || '.font')
      let filename = preferredName
      let collision = 0
      while (filenames.has(filename)) {
        collision += 1
        filename = `${collision}-${preferredName}`
      }
      filenames.add(filename)
      try { fs.writeFile(`${LIBREOFFICE_FONT_DIRECTORY}/${filename}`, font.bytes, { canOwn: true }) }
      catch (error) {
        reportFontFailure(onDiagnostic, 'wasm-write', error, {
          completedFonts, completedBytes, totalFonts: fonts.length, attemptedBytes: font.bytes.byteLength
        })
        throw error
      }
      completedFonts++
      completedBytes += font.bytes.byteLength
    }
  }

  return {
    fontErrorDiagnostic,
    dedupeFontEntries,
    detectFontExtension,
    normalizeFontIdentity,
    readAllFontEntries,
    readFontAssets,
    readFontFiles,
    readFontEntry,
    registerFontsInPreRun,
    sanitizeFontName,
    selectFontEntries,
  }
})
