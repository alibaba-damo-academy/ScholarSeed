import { createContext } from 'react'

import type { ToastContextValue } from './Toast'

// 必须独立于 Toast.tsx 创建：Toast.tsx 同时导出组件(ToastProvider/Toaster/Toast)与非组件
// (useToast)，成不了稳定的 Fast Refresh 边界，失效时只换组件实现而不重执行消费者模块；context
// 若随 Toast.tsx 重建就会让 provider 与 consumer 分属两个实例，useToast 读到 null 抛
// "useToast must be used inside ToastProvider"。context 身份放这里即可跨 HMR 保持稳定。
export const ToastContext = createContext<ToastContextValue | null>(null)
