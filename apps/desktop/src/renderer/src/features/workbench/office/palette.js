/* SPDX-License-Identifier: MIT */

'use strict'

var ScholarSeedOfficePalette = (() => {
  const CONFIGURATION_PROVIDER = 'com.sun.star.configuration.ConfigurationProvider'
  const CONFIGURATION_UPDATE_ACCESS = 'com.sun.star.configuration.ConfigurationUpdateAccess'
  const APPEARANCE_PATH = '/org.openoffice.Office.Common/Misc'
  const COLOR_SCHEME_PATH = '/org.openoffice.Office.UI/ColorScheme/ColorSchemes/COLOR_SCHEME_LIBREOFFICE_AUTOMATIC'
  const LIGHT_APPEARANCE = 1
  const DARK_APPEARANCE = 2

  function update(provider, css, path, values) {
    const access = provider.createInstanceWithArguments(CONFIGURATION_UPDATE_ACCESS, [
      new css.beans.PropertyValue({ Name: 'nodepath', Value: path })
    ])
    for (const [name, value] of Object.entries(values)) access.setPropertyValue(name, value)
    access.commitChanges()
  }

  function apply(zetajs, css, palette) {
    const context = zetajs.getUnoComponentContext()
    const provider = context.getServiceManager().createInstanceWithContext(CONFIGURATION_PROVIDER, context)
    const appearance = palette.mode === 'dark' ? DARK_APPEARANCE : LIGHT_APPEARANCE
    update(provider, css, APPEARANCE_PATH, {
      Appearance: new zetajs.Any(zetajs.type.short, appearance),
      ApplicationAppearance: new zetajs.Any(zetajs.type.short, appearance)
    })
    update(provider, css, `${COLOR_SCHEME_PATH}/AppBackground`, {
      Color: new zetajs.Any(zetajs.type.long, palette.appBackground)
    })
    update(provider, css, `${COLOR_SCHEME_PATH}/CalcGrid`, {
      Color: new zetajs.Any(zetajs.type.long, palette.calcGrid)
    })
  }

  return Object.freeze({ apply })
})()
