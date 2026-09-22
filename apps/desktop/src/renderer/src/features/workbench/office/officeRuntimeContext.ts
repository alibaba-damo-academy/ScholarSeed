import { createContext } from 'react'

import type { OfficeRuntimeContextValue } from './runtime'

// 必须独立于 runtime.tsx 创建：runtime.tsx 同时导出组件(OfficeRuntimeProvider)与非组件
// (useOfficeRuntime)，成不了稳定的 Fast Refresh 边界；dev 下热更只换 Provider 实现而不重执行
// 跨模块消费者(Dock.tsx / OfficeDocument.tsx)，context 若随 runtime.tsx 重建就会让 provider 与
// consumer 分属两个实例，useOfficeRuntime 读到 null 抛 "Office runtime provider is missing"。
export const OfficeRuntimeContext = createContext<OfficeRuntimeContextValue | null>(null)
