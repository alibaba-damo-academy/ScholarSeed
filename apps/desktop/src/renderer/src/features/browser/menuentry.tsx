import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import '@fontsource/noto-serif-sc/600.css'
import '../../styles.css'
import { createRoot } from 'react-dom/client'
import { Menu } from './Menu'

const root = document.getElementById('root')
if (!root || !window.menu) throw new Error('desktop_bridge_unavailable')
createRoot(root).render(<Menu bridge={window.menu} />)
