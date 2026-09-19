/* SPDX-License-Identifier: MIT */

'use strict'

globalThis.ScholarSeedOfficeClipboard = (() => {
  let installedClipboard

  function install(clipboard, rejected) {
    if (!clipboard || typeof clipboard.writeText !== 'function' || clipboard === installedClipboard) return
    const writeText = clipboard.writeText.bind(clipboard)
    Object.defineProperty(clipboard, 'writeText', {
      configurable: true,
      value(text) {
        return Promise.resolve(writeText(text)).catch((error) => {
          rejected(error)
        })
      }
    })
    installedClipboard = clipboard
  }

  return Object.freeze({ install })
})()
