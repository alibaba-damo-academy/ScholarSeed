import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Crepe } from '@milkdown/crepe'
import { I18nextProvider } from 'react-i18next'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import '../../styles.css'
import { createLocalization } from '../../../../localization/engine'
import { resources } from '../../../../localization/resources'
import { Formula } from '../../components/primitive/Formula'
import { writeClipboard, writeClipboardContent } from '../../components/primitive/clipboard'
import {
  configureMathClipboard,
  literalLatexSchema,
  mathClipboardHtml,
  mathCompatibilityPlugin,
} from './mathematics'

const localization = createLocalization('zh', resources, { report: () => undefined })
Object.assign(window, { mathClipboardHtml })

function Fixture(): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const [markdown, setMarkdown] = useState('')
  useEffect(() => {
    const editor = new Crepe({ root: host.current!, defaultValue: '' })
    editor.editor.use(mathCompatibilityPlugin).use(literalLatexSchema)
    editor.editor.config(configureMathClipboard)
    editor.on((listener) => listener.markdownUpdated((_ctx, source) => setMarkdown(source)))
    void editor.create()
    return () => {
      void editor.destroy()
    }
  }, [])
  return (
    <>
      <Formula
        source={'\\frac{F}{k}=x'}
        onCopy={(text, html) =>
          html === undefined ? writeClipboard(text) : writeClipboardContent(text, html)
        }
      />
      <div ref={host} />
      <output data-testid="serialized-math">{markdown}</output>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={localization}>
    <Fixture />
  </I18nextProvider>
)
