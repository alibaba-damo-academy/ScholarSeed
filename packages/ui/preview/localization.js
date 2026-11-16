import { translator, ready as initialized } from '../localization'
import zh from '../../../apps/desktop/src/localization/locales/zh/official.json'
import en from '../../../apps/desktop/src/localization/locales/en/official.json'

export const ready = initialized.then(() => {
  translator.addResourceBundle('zh', 'official', zh)
  translator.addResourceBundle('en', 'official', en)
})
