/** Narrow Assistant integration hook consumed by other renderer Features. */

import { useMemo } from 'react'

import type { AssistantIngress } from '../../contracts/assistant'
import { useApp } from '../../store'

export function useAssistantIngress(): AssistantIngress {
  const { act } = useApp()
  return useMemo(
    () => ({
      addContext: act.addContext,
      addContexts: act.addContexts,
      invokeOnce: act.invokeOnce,
      translate: act.translate,
      invokeSelection: act.invokeSelection,
      stopSelection: act.stopSelection,
      openPanel: act.openPanel
    }),
    [act]
  )
}
