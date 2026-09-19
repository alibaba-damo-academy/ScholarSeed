/* SPDX-License-Identifier: MIT */

(function exposeLocalFontHelpers(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.ZetaLocalFonts = api
})(typeof globalThis === 'undefined' ? undefined : globalThis, function createLocalFontHelpers() {
  'use strict'

  const LIBREOFFICE_FONT_DIRECTORY = '/instdir/share/fonts/truetype'

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

  async function readAllFontEntries(fonts, onProgress, onUnavailable = (font, error) => console.warn('Office system font unavailable', font.postscriptName || font.family, String(error))) {
    if (!fonts.length) return []
    const entries = []
    let loadedBytes = 0
    for (const [index, font] of fonts.entries()) {
      try {
        const entry = await readFontEntry(font, index)
        entries.push(entry)
        loadedBytes += entry.bytes.byteLength
      } catch (error) {
        onUnavailable(font, error)
      }
      if (onProgress) onProgress(index + 1, fonts.length, loadedBytes)
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

  function registerFontsInPreRun(moduleConfig, fonts, getFs) {
    moduleConfig.preRun = moduleConfig.preRun || []
    moduleConfig.preRun.push(function installLocalFonts() {
      const fs = getFs ? getFs() : globalThis.FS
      fs.mkdirTree(LIBREOFFICE_FONT_DIRECTORY)
      for (const font of fonts) {
        const filename = sanitizeFontName(font.filename.replace(/\.(ttf|otf|ttc|font)$/i, ''))
          + (font.filename.match(/\.(ttf|otf|ttc|font)$/i)?.[0].toLowerCase() || '.font')
        fs.writeFile(`${LIBREOFFICE_FONT_DIRECTORY}/${filename}`, font.bytes)
      }
    })
  }

  return {
    dedupeFontEntries,
    detectFontExtension,
    normalizeFontIdentity,
    readAllFontEntries,
    readFontAssets,
    readFontEntry,
    registerFontsInPreRun,
    sanitizeFontName,
    selectFontEntries,
  }
})
