import React from 'react'

import type { FeatureModule } from '../../contracts/features'
import { Recorder } from './Recorder'

export function feedbackRecorderFeature(): FeatureModule {
  return {
    id: 'feedback-recorder',
    globalSurfaces: [{ id: 'feedback-recorder', render: () => <Recorder /> }]
  }
}
