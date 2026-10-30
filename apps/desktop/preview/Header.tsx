import React from 'react'
import { CircleHelp, PanelRight, PanelsTopLeft, RefreshCw, RotateCcw, X } from 'lucide-react'
import { DialogDescription, DialogHeader, DialogTitle, IconButton, Tabs, TabsList, TabsTrigger } from '../src/renderer/src/components/ui'
import type { PdfeDock } from '../src/pdfe.ts'
import type zh from './locales/zh.json'

const ICON_CLASS = 'size-[var(--vds-icon-8)]'

export function PdfeHeader({ materials, dock, pending, translate, onSection, onHelp, onDock, onReset, onReload, onClose }: {
  materials: boolean
  dock: PdfeDock
  pending: boolean
  translate: (key: keyof typeof zh) => string
  onSection: (section: string) => void
  onHelp: () => void
  onDock: () => void
  onReset: () => void
  onReload: () => void
  onClose: () => void
}): React.JSX.Element {
  return <div className="grid min-w-0 gap-[var(--vds-space-4)]">
    <div className="flex min-w-0 items-center justify-between gap-[var(--vds-space-2)]">
      <DialogHeader className="min-w-0 flex-1">
        <DialogTitle className="truncate">{translate('title')}</DialogTitle>
        <DialogDescription className="sr-only">{translate('description')}</DialogDescription>
      </DialogHeader>
      <div role="group" aria-label={translate('workbenchActions')} className="flex shrink-0 items-center gap-[var(--vds-space-1)]">
        <IconButton variant="ghost" size="sm" label={translate('guide')} icon={<CircleHelp className={ICON_CLASS} />} onClick={onHelp} />
        <IconButton variant="ghost" size="sm" data-testid="preview-dock" label={translate(dock === 'docked' ? 'detachWorkbench' : 'dockWorkbench')} icon={dock === 'docked' ? <PanelsTopLeft className={ICON_CLASS} /> : <PanelRight className={ICON_CLASS} />} disabled={pending} onClick={onDock} />
        <IconButton variant="ghost" size="sm" label={translate('reset')} icon={<RotateCcw className={ICON_CLASS} />} disabled={pending} onClick={onReset} />
        <IconButton variant="ghost" size="sm" label={translate('reload')} icon={<RefreshCw className={ICON_CLASS} />} disabled={pending} onClick={onReload} />
        <IconButton variant="ghost" size="sm" label={translate('close')} icon={<X className={ICON_CLASS} />} onClick={onClose} />
      </div>
    </div>
    <Tabs value={materials ? 'materials' : 'features'} onValueChange={onSection}>
      <TabsList aria-label={translate('workbenchSections')} className="w-full">
        <TabsTrigger value="features" disabled={pending} className="flex-1">{translate('featureSection')}</TabsTrigger>
        <TabsTrigger value="materials" disabled={pending} data-testid="preview-components" className="flex-1">{translate('componentsEntry')}</TabsTrigger>
      </TabsList>
    </Tabs>
  </div>
}
