import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../../localization/engine'
import { resources } from '../../../../localization/resources'
import type { AssistantContextCandidate } from '../../contracts/assistant'
import { ReferencePicker } from './References'
import '../../styles.css'

const sourceId = new URLSearchParams(location.search).get('source') ?? 'literature'
const localization = createLocalization('en', resources)
const candidates = ['Alpha', 'Beta', 'Unavailable'].map((label) => ({
  kind: sourceId === 'resource' ? 'file' : 'literature',
  source_id: label,
  label,
  unavailable_reason: label === 'Unavailable' ? 'Unavailable' : undefined,
})) as AssistantContextCandidate[]

function Fixture(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [confirmed, setConfirmed] = useState('')
  return (
    <I18nextProvider i18n={localization}>
      <div className="flex h-screen flex-col">
        <ReferencePicker
          candidates={candidates.filter((item) => item.label.includes(query))}
          emptyLabel="Empty"
          loading={false}
          onQueryChange={setQuery}
          onConfirm={async (items) => setConfirmed(items.map((item) => item.source_id).join(','))}
          projectId={null}
          query={query}
          sourceId={sourceId}
          sourceLabel="Library"
          onCancel={() => undefined}
        />
        <output data-testid="confirmed">{confirmed}</output>
      </div>
    </I18nextProvider>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
