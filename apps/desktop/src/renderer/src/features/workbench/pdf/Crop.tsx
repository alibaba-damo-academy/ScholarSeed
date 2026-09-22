import { useTranslation } from 'react-i18next'
import React, { useRef, useState } from 'react'
import { Button } from '../../../components/ui'

const ZOOM_STEP = 25
const MIN_ZOOM = 25
const MAX_ZOOM = 300

export function Crop({ image, page }: { image: string; page: number }): React.JSX.Element {
  const { t } = useTranslation('pdf')
  const [zoom, setZoom] = useState(100)
  const host = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; left: number; top: number }>()
  return <div className="flex-none px-4 pt-3">
    <div className="mb-2 flex items-center gap-2 text-xs text-[var(--vds-text-tertiary)]"><span>{t('crop.region')}</span><span>{t('page', { page })}</span><div className="ml-auto flex gap-1"><Button size="sm" variant="outline" aria-label={t('crop.zoomOut')} disabled={zoom <= MIN_ZOOM} onClick={() => setZoom(value => value - ZOOM_STEP)}>−</Button><Button size="sm" variant="outline" aria-label={t('crop.fit')} onClick={() => setZoom(100)}>{zoom}%</Button><Button size="sm" variant="outline" aria-label={t('crop.zoomIn')} disabled={zoom >= MAX_ZOOM} onClick={() => setZoom(value => value + ZOOM_STEP)}>+</Button></div></div>
    <div ref={host} role="region" aria-label={t('crop.preview')} className="h-40 cursor-grab overflow-auto rounded-lg border border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)]" onPointerDown={event => { if (!host.current) return; drag.current = { x: event.clientX, y: event.clientY, left: host.current.scrollLeft, top: host.current.scrollTop }; event.currentTarget.setPointerCapture(event.pointerId) }} onPointerMove={event => { if (drag.current && host.current) { host.current.scrollLeft = drag.current.left + drag.current.x - event.clientX; host.current.scrollTop = drag.current.top + drag.current.y - event.clientY } }} onPointerUp={() => { drag.current = undefined }}>
      {/* Geometry reflects the user's preview zoom; never modifies source pixels. */}
      <img src={image} alt={t('crop.image')} draggable={false} className="mx-auto max-w-none object-contain" style={{ width: `${zoom}%`, height: `${zoom}%` }} />
    </div>
  </div>
}
