import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../localization/engine'
import { resources } from '../../../localization/resources'
import { applyTheme } from '../theme'
import { ImageAttachments } from './primitive/Images'
import { Button, ImageStrip } from './ui'
import previewFirst from '../assets/banner2.webp'
import '../styles.css'

const localization = createLocalization('zh', resources, { escapeValue: false })
const images = Array.from({ length: 10 }, (_, index) => ({
  id: String(index),
  name: `Image ${index + 1}`,
  src: previewFirst,
  sourceLabel: index === 1 ? '资料' : index === 2 ? '文献' : undefined,
}))
const failedName =
  '20261028141906-图片引用失效后完整名称仍应可以通过键盘及悬停查看-long-image-name.jpg'

function Fixture(): React.JSX.Element {
  const [count, setCount] = useState(10)
  const [narrow, setNarrow] = useState(false)
  const [selected, setSelected] = useState(-1)
  const [failed, setFailed] = useState(false)
  const [imageErrors, setImageErrors] = useState(0)
  const [removed, setRemoved] = useState(-1)
  const displayed = failed
    ? [
        { ...images[0], name: failedName, error: true },
        { ...images[1], src: undefined },
        { ...images[2], src: '/missing-strip-image.png' },
        images[3],
      ]
    : images.slice(0, count)
  return (
    <I18nextProvider i18n={localization}>
      <div style={{ width: narrow ? 240 : 600, maxWidth: '100%' }} data-testid="strip-container">
        <ImageStrip
          images={displayed}
          onOpen={setSelected}
          onImageError={() => setImageErrors((current) => current + 1)}
        />
      </div>
      <div style={{ width: 240 }} data-testid="draft">
        <ImageAttachments
          images={failed ? displayed : images}
          onOpen={setSelected}
          onRemove={setRemoved}
        />
      </div>
      <Button onClick={() => setNarrow((current) => !current)}>Resize</Button>
      <Button onClick={() => setCount(1)}>Single</Button>
      <Button onClick={() => setCount(3)}>Triple</Button>
      <Button onClick={() => setCount(0)}>Empty</Button>
      <Button onClick={() => setFailed(true)}>Failures</Button>
      <Button onClick={() => applyTheme('dark')}>Dark</Button>
      <Button onClick={() => localization.changeLanguage('en')}>English</Button>
      <output data-testid="selected">{selected}</output>
      <output data-testid="image-errors">{imageErrors}</output>
      <output data-testid="removed">{removed}</output>
    </I18nextProvider>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
