import { StrictMode, useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'

import { createLocalization } from '../../../../localization/engine'
import zhLayout from '../../../../localization/locales/zh/layout.json'
import enLayout from '../../../../localization/locales/en/layout.json'
import zhUi from '../../../../localization/locales/zh/ui.json'
import enUi from '../../../../localization/locales/en/ui.json'
import { Button } from '../../components/ui'
import { Directory } from './Explorer'
import '../../styles.css'

const localization = createLocalization(
  'zh',
  { zh: { layout: zhLayout, ui: zhUi }, en: { layout: enLayout, ui: enUi } },
  { report: () => undefined }
)
Object.assign(window, { scholarseed: { getApiBase: () => window.location.origin } })

export function Fixture(): React.JSX.Element {
  const [project, setProject] = useState('first')
  const [path, setPath] = useState('')
  const [revision, setRevision] = useState(0)
  const [mounted, setMounted] = useState(true)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [menuPath, setMenuPath] = useState<string | null>(null)
  const [draft, setDraft] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const onLoadingChange = useCallback((_path: string, value: boolean) => setLoading(value), [])
  return (
    <>
      <Button
        data-testid="fixture-refresh"
        aria-busy={loading}
        onClick={() => setRevision((value) => value + 1)}
      >
        Refresh
      </Button>
      <Button
        data-testid="fixture-project"
        onClick={() => setProject((value) => (value === 'first' ? 'second' : 'first'))}
      >
        Project
      </Button>
      <Button data-testid="fixture-path" onClick={() => setPath((value) => (value ? '' : 'root'))}>
        Path
      </Button>
      <Button data-testid="fixture-mount" onClick={() => setMounted((value) => !value)}>
        Mount
      </Button>
      <Button data-testid="fixture-english" onClick={() => void localization.changeLanguage('en')}>
        English
      </Button>
      <Button data-testid="fixture-draft" onClick={() => setDraft((value) => !value)}>
        Draft
      </Button>
      {mounted && (
        <Directory
          project={project}
          path={path}
          revision={revision}
          expanded={expanded}
          selected={selected}
          dragTarget={null}
          menuPath={menuPath}
          creation={
            draft
              ? { parent: path, row: <span data-testid="fixture-draft-row">Draft</span> }
              : undefined
          }
          onToggle={(target) =>
            setExpanded((current) => {
              const next = new Set(current)
              if (next.has(target)) next.delete(target)
              else next.add(target)
              return next
            })
          }
          onSelect={(node) => setSelected(node.path)}
          onMenu={(node) => setMenuPath(node.path)}
          onDrop={() => undefined}
          onDragTarget={() => undefined}
          onLoadingChange={onLoadingChange}
        />
      )}
      {menuPath !== null && (
        <Button data-testid="fixture-close-menu" onClick={() => setMenuPath(null)}>
          Close menu
        </Button>
      )}
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nextProvider i18n={localization}>
      <Fixture />
    </I18nextProvider>
  </StrictMode>
)
