import * as Conversation from '../conversation'
import { createDirectory } from './directory.mjs'
import { conversationLibrary, CONVERSATION_AUXILIARY_COMPONENTS, CONVERSATION_COMPONENT_ALIASES } from '../library'
import { contracts } from './catalog.mjs'
import { nativeEntries } from './native.mjs'

const native = nativeEntries(conversationLibrary, CONVERSATION_AUXILIARY_COMPONENTS, contracts, CONVERSATION_COMPONENT_ALIASES)
export const { entries, sections, internal } = createDirectory(Conversation, native)
