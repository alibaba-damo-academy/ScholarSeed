import { createContext } from 'react'
import type { ConvItem } from '../../model'
import { answerCopyText } from './copying'

export const CopySessionContext = createContext('')
export const CopyItemsContext = createContext<readonly ConvItem[]>([])
export const AnswerCopyContext = createContext<
  (item: Extract<ConvItem, { kind: 'agent' }>, sessionId: string) => string | Promise<string>
>((item) => answerCopyText(item.text, item.answerSources))
