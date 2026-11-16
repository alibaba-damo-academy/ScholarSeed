import { createContext } from 'react'
import { availabilityPolicy } from '../../app/policy'
import { isTerminalHil, pendingHilItems, type HilItem } from '../../hil'
import type { ConvItem, Thread } from '../../model'

export function isDockedInstallation(item: ConvItem): item is HilItem {
  return (
    item.kind === 'hil' &&
    item.blocking === false &&
    !item.installationHandled &&
    !isTerminalHil(item) &&
    item.questions?.length === 1 &&
    Boolean(item.questions[0].installation)
  )
}

export function pendingConversationConfirmations(
  thread: Pick<Thread, 'readOnly' | 'conversation'>
) {
  return thread.readOnly
    ? []
    : pendingHilItems(thread.conversation).filter((item) =>
        availabilityPolicy.hilAvailable(item.hilKind ?? '')
      )
}

export const ComposerConfirmationContext = createContext<{
  pending: boolean
}>({ pending: false })
