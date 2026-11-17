import React from 'react'
import { createRoot } from 'react-dom/client'
import { Providers } from '../localization'
import { ready } from './localization'
import { Preview } from './page'
import { ExportProvider } from './exporting'
import '../ui.css'

const root = createRoot(document.getElementById('root'))
await ready
root.render(
  <Providers>
    <ExportProvider><Preview /></ExportProvider>
  </Providers>
)
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
