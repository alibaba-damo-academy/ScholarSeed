import { createContext } from 'react'

import type { Store } from './store'

// 必须独立于 store.tsx 创建：store.tsx 同时导出组件与非组件，成不了 Fast Refresh 边界，失效时只换 StoreProvider 的实现而不重执行消费者模块，context 若随它重建就会让 provider 与 consumer 分属两个实例。
export const StoreContext = createContext<Store | null>(null)
