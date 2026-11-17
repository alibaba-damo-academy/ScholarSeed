import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../../localization/engine'
import { resources } from '../../../../localization/resources'
import { cardPorts } from './ports'
import { LiteratureResults } from './Summary'
import '../../styles.css'

const count = Number(new URLSearchParams(location.search).get('papers'))
const localization = createLocalization('en', resources)
const ports = cardPorts(async () => {
  throw new Error('Card actions are outside this preview fixture')
}, {})
const content = {
  schema_version: '1.0',
  session_id: 'literature-preview',
  status: 'success',
  retained: count,
  criteria: [],
  sources: [],
  warnings: [],
  papers: Array.from({ length: count }, (_, index) => ({
    id: String(index),
    title: `Paper ${index + 1}`,
  })),
}

createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={localization}>
    <LiteratureResults content={content} ports={ports} />
  </I18nextProvider>
)
