import React from 'react'
import type { FeatureModule } from '../../contracts/features'
import type { PublicComponentProps } from '../../contracts/components'
import { Canvas } from '../../../../../../../packages/ui/painter'
import { CANVAS_SLOT, type CanvasDocument } from '../../../../../../../packages/ui/canvas'
import { CanvasTarget, useCanvasLocation } from './Scope'

function CanvasContent(props: PublicComponentProps): React.JSX.Element {
  const location = useCanvasLocation()
  return (
    <Canvas
      document={props.data as unknown as CanvasDocument}
      draft={props.draft}
      status={props.status}
      full={location.full}
      onOpen={location.open}
      onDraft={props.onDraft}
      onAction={props.onAction}
    />
  )
}

export function canvasFeature(): FeatureModule {
  return {
    id: 'canvas',
    publicComponents: [{ slot: CANVAS_SLOT, render: (props) => <CanvasContent {...props} /> }],
    viewerPlugins: [
      { kind: 'canvas', render: ({ tabId, path }) => <CanvasTarget tabId={tabId ?? path} /> },
    ],
  }
}
