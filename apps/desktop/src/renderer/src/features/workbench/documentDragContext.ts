import { createContext } from 'react'

import type { DocumentDragContextValue } from './Dragging'

// 必须独立于 Dragging.tsx 创建：Dragging.tsx 同时导出组件(DocumentDragProvider)与非组件
// (useDocumentDrag)，成不了稳定的 Fast Refresh 边界；dev 下热更只换 Provider 实现而不重执行
// 跨模块消费者(Dock.tsx)，context 若随 Dragging.tsx 重建就会让 provider 与 consumer 分属两个
// 实例，useDocumentDrag 读到 null 抛 document_drag_provider_missing。context 身份放这里保持稳定。
export const DocumentDragContext = createContext<DocumentDragContextValue | null>(null)
