import { LOCALES } from '../src/localization/catalog.ts'
import { createLocalization } from '../src/localization/engine.ts'
import { resources } from '../src/localization/resources.ts'
import { officeFrameDocument } from '../src/renderer/src/features/workbench/office/frame'
import { attachPreviewOfficeCleanup, previewOfficeFrameParameters } from './frames.ts'

const parameters = previewOfficeFrameParameters(new URL(window.location.href))
if (window.parent === window) throw new Error('Preview Office frame requires its parent renderer')
const localization = createLocalization(parameters.locale, resources, { escapeValue: false })
const frame = officeFrameDocument(localization.getFixedT(parameters.locale, 'workbench'), LOCALES[parameters.locale].office, parameters.token)
let dispose = frame.dispose

try {
  document.open()
  document.write(frame.html)
  document.close()
  dispose = attachPreviewOfficeCleanup(window, window.parent, frame.token, frame.dispose)
} catch (error) {
  dispose()
  throw error
}
