import React, { useContext } from 'react'

import type { InteractionPolicyContribution } from '../../contracts/features'
import { InteractionPoliciesContext } from './interactionPoliciesContext'

export function InteractionPolicyProvider({
  children,
  policies
}: {
  children: React.ReactNode
  policies: readonly InteractionPolicyContribution[]
}): React.JSX.Element {
  return <InteractionPoliciesContext.Provider value={policies}>{children}</InteractionPoliciesContext.Provider>
}

export function useInteractionPolicies(): readonly InteractionPolicyContribution[] {
  return useContext(InteractionPoliciesContext)
}
