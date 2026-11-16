import React from 'react'
import { mountRenderer } from './app/root'
import { App } from './App'
import { LiveTranslationProvider } from './features/translation/live'

mountRenderer(
  <LiveTranslationProvider>
    <App />
  </LiveTranslationProvider>
)
