import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../localization/engine'
import { resources } from '../../../localization/resources'
import { UpdateOverlay } from '../components/business/UpdateOverlay'
import '../styles.css'

const localization = createLocalization('zh', resources, { escapeValue: false })
createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={localization}>
    <main>MOCK update lifecycle — isolated native composition test</main>
    <UpdateOverlay />
  </I18nextProvider>
)
