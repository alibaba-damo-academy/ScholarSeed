import React from 'react'
import { Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../src/renderer/src/components/ui'
import { PDFE_ITERATION_SCOPES, pdfeIterations, type PdfeIterationFilter } from './iterations.ts'
import type { PdfeTranslate } from './collaboration.ts'

export function PdfeIterationFilter({ value, pending, translate, onChange }: {
  value: PdfeIterationFilter
  pending: boolean
  translate: PdfeTranslate
  onChange: (value: PdfeIterationFilter) => void
}): React.JSX.Element {
  return <section aria-label={translate('iterationFilter')} className="grid min-w-0 grid-cols-1 gap-[var(--vds-space-1)]">
    <div className="grid min-w-0 grid-cols-2 gap-[var(--vds-space-2)]">
      <div className="grid min-w-0 gap-[var(--vds-space-1)]">
        <Label htmlFor="preview-iteration">{translate('iteration')}</Label>
        <Select value={value.version} onValueChange={version => onChange({ version, scope: 'any' })} disabled={pending} size="standard">
          <SelectTrigger id="preview-iteration"><SelectValue /></SelectTrigger>
          <SelectContent className="!z-[var(--vds-z-modal-nested-flyout)]">
            <SelectItem value="all">{translate('iterationAll')}</SelectItem>
            <SelectItem value="unconfirmed">{translate('iterationPending')}</SelectItem>
            {pdfeIterations().map(version => <SelectItem key={version} value={version}>{'v' + version}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="grid min-w-0 gap-[var(--vds-space-1)]">
        <Label htmlFor="preview-iteration-scope">{translate('iterationScope')}</Label>
        <Select value={value.scope} onValueChange={scope => { if (PDFE_ITERATION_SCOPES.includes(scope as PdfeIterationFilter['scope'])) onChange({ ...value, scope: scope as PdfeIterationFilter['scope'] }) }} disabled={pending || ['all', 'unconfirmed'].includes(value.version)} size="standard">
          <SelectTrigger id="preview-iteration-scope"><SelectValue /></SelectTrigger>
          <SelectContent className="!z-[var(--vds-z-modal-nested-flyout)]">
            <SelectItem value="any">{translate('iterationAny')}</SelectItem>
            <SelectItem value="added">{translate('iterationAdded')}</SelectItem>
            <SelectItem value="updated">{translate('iterationUpdated')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
    <p className="text-[length:var(--vds-font-body-lv3)] leading-[var(--vds-lh-body-lv3)] text-[var(--vds-text-secondary)]">{translate('iterationPilot')}</p>
  </section>
}
