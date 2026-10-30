import { createRoot } from 'react-dom/client'
import type { BrowserOverlayEvent, BrowserOverlayModel, SuggestionsBridge } from '../../../../overlay'
import { Suggestions } from './Suggestions'
import '../../styles.css'

const listeners = new Set<(model: BrowserOverlayModel) => void>()
const focusListeners = new Set<(revision: number) => void>()
const fixture = window.parent as unknown as { suggestionsReady(callback: (model: BrowserOverlayModel) => void): void; suggestionsFocusReady(callback: (revision: number) => void): void; suggestionEvent(event: BrowserOverlayEvent): void }
const bridge: SuggestionsBridge = {
  subscribe(callback) { listeners.add(callback); fixture.suggestionsReady(model => listeners.forEach(listener => listener(model))); return () => { listeners.delete(callback) } },
  subscribeFocus(callback) { focusListeners.add(callback); fixture.suggestionsFocusReady(revision => focusListeners.forEach(listener => listener(revision))); return () => { focusListeners.delete(callback) } },
  async send(event) { fixture.suggestionEvent(event); return { ok: true } }
}
Object.assign(window, { fixtureWindowFocusEvents: 0 })
window.addEventListener('focus', () => { (window as unknown as { fixtureWindowFocusEvents: number }).fixtureWindowFocusEvents += 1 })
createRoot(document.getElementById('root')!).render(<Suggestions bridge={bridge} />)
