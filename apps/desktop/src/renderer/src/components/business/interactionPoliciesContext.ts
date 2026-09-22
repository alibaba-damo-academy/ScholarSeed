import { createContext } from 'react'

import type { InteractionPolicyContribution } from '../../contracts/features'

// 必须独立于 Interactions.tsx 创建：Interactions.tsx 同时导出组件(InteractionPolicyProvider)与
// 非组件(useInteractionPolicies)，成不了稳定的 Fast Refresh 边界；dev 下热更只换 Provider 实现而
// 不重执行跨模块消费者(Stream.tsx)，context 若随 Interactions.tsx 重建就会让 provider 与 consumer
// 分属两个实例，消费者读到默认空数组，交互策略静默失效。
export const InteractionPoliciesContext = createContext<readonly InteractionPolicyContribution[]>([])
