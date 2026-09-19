import { createContext } from 'react'

import type { DisplayCardContribution } from '../../contracts/features'

// 必须独立于 Cards.tsx 创建：Cards.tsx 同时导出组件(DisplayCardProvider/DisplayCardView)与
// 非组件(useCardArtifacts/useLatestDisplayCards)，成不了稳定的 Fast Refresh 边界；dev 下热更只换
// Provider 实现而不重执行跨模块消费者(Stream.tsx)，context 若随 Cards.tsx 重建就会让 provider 与
// consumer 分属两个实例，消费者读到默认空 Map，卡片 artifacts / supersession 静默失效。
export const DisplayCardsContext = createContext<ReadonlyMap<string, DisplayCardContribution>>(new Map())
