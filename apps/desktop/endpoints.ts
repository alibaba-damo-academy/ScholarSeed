// 开发期地址单一来源 —— Electron 壳、纯前端 Vite 配置、主进程默认后端地址共用这一份，
// 免得端口散落在三处各写一遍。

// renderer 开发端口。必须与后端 CORS 白名单一致
// (service/app.py 默认放行 http://localhost:5173 + http://127.0.0.1:5173)。
export const RENDERER_DEV_HOST = '127.0.0.1'
export const RENDERER_DEV_PORT = 5173

// Electron 开发链由 electron-vite 读取最终监听端口并注入 ELECTRON_RENDERER_URL；
// 允许 Vite 在首选端口被占用时继续尝试，避免残留开发进程阻断启动。
export const RENDERER_DEV_STRICT_PORT = false

// Electron、纯 Web 开发和渲染测试可以同时启动 Vite；独立目录避免其他实例
// 重新优化默认 node_modules/.vite 时移除 Electron 仍在引用的 chunk。
export const RENDERER_DEV_CACHE_DIRECTORY = 'node_modules/.vite-scholarseed-desktop'

// `scholarseed serve` 的默认地址 (service/cli/serve.py 的 --port 默认 8770)。
export const DEFAULT_SERVE_URL = 'http://127.0.0.1:8770'
