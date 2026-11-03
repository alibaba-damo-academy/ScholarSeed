import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import '@fontsource/noto-serif-sc/600.css'
import '../../styles.css'
import { createRoot } from 'react-dom/client'
import { Vault } from './Vault'

const root = document.getElementById('root')
if (root && window.vault) createRoot(root).render(<Vault bridge={window.vault} />)
