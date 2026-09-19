/* SPDX-License-Identifier: MIT */
'use strict';

globalThis.ScholarSeedOfficeLocale = (() => {
  const DEFAULT_LOCALE = 'en-US'
  const CJK_LOCALE = 'zh-CN'
  const MANIFEST = 'locales.json'
  const RESOURCE_ROOT = '/instdir/'
  function resolve(locale) {
    return locale === CJK_LOCALE ? CJK_LOCALE : DEFAULT_LOCALE
  }
  function install(module, manifest, data, locale, filesystem) {
    module.arguments = [...(module.arguments || []), '--language=' + resolve(locale)]
    module.preRun = module.preRun || []
    module.preRun.push(() => {
      const fs = filesystem || globalThis.FS
      for (const file of manifest.files) {
        if (!file.path.startsWith(RESOURCE_ROOT) || file.path.includes('..') || file.start < 0 || file.end > data.length || file.end <= file.start) {
          throw new Error('Invalid native locale resource: ' + file.path)
        }
        fs.mkdirTree(file.path.slice(0, file.path.lastIndexOf('/')))
        fs.writeFile(file.path, data.subarray(file.start, file.end))
      }
    })
  }
  async function prepare(module, baseUrl, locale = DEFAULT_LOCALE) {
    const resolvedLocale = resolve(locale)
    if (resolvedLocale === DEFAULT_LOCALE) {
      module.arguments = [...(module.arguments || []), '--language=' + DEFAULT_LOCALE]
      console.info('[office-locale] using English UI for the frozen runtime')
      return
    }
    try {
      const response = await fetch(baseUrl + MANIFEST)
      if (!response.ok) throw new Error('Missing locale manifest: ' + response.status)
      const manifest = await response.json()
      const payload = await fetch(baseUrl + manifest.data.file)
      if (!payload.ok) throw new Error('Missing native language data: ' + payload.status)
      const data = new Uint8Array(await payload.arrayBuffer())
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('')
      if (data.length !== manifest.data.bytes || digest !== manifest.data.sha256) throw new Error('Native language data integrity mismatch')
      install(module, manifest, data, resolvedLocale)
      console.info('[office-locale] native resources loaded', resolvedLocale, 'English fallback inventory:', baseUrl + manifest.residuals)
    } catch (error) {
      module.arguments = [...(module.arguments || []), '--language=' + DEFAULT_LOCALE]
      console.error('[office-locale] falling back to English', { requested: resolvedLocale, missing: baseUrl + MANIFEST, error: String(error) })
    }
  }
  return Object.freeze({ resolve, install, prepare })
})();
