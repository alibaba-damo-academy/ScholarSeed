import React, { type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../../localization/engine'
import { resources } from '../../../../localization/resources'
import { Images, ImageThumbnail } from './Images'
import { ImageView } from './Image'
import { Button } from '../ui'
import { ArtifactGroup } from '../business/Artifact'
import '../../styles.css'

const localization = createLocalization('zh', resources, { escapeValue: false })
const root = createRoot(document.getElementById('root')!)
type Snapshot = Record<string, unknown>
let current: ((state: Snapshot) => ReactNode) | undefined
const fixture = { state: {} as Snapshot, publish: () => render() }

function render(): void {
  if (!current) return
  root.render(
    <I18nextProvider i18n={localization}>
      <React.StrictMode>{React.createElement(current, { ...fixture.state })}</React.StrictMode>
    </I18nextProvider>
  )
}

Object.assign(window, {
  fixture,
  nativeImages: {
    React,
    Button,
    Conversation: { Images, ImageThumbnail, ImageView, ArtifactGroup },
    mount: (view: (state: Snapshot) => ReactNode) => {
      current = view
      render()
    },
  },
})
