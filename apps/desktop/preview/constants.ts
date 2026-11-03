export const PREVIEW_DEV_PORT = 5175
export const PREVIEW_ORIGIN = `http://127.0.0.1:${PREVIEW_DEV_PORT}`
export const PREVIEW_CACHE_DIRECTORY = 'node_modules/.vite-scholarseed-preview'
export const PREVIEW_PROJECT_ID = 'preview-project'
export const PREVIEW_TOOLBAR_ACTIONS_ID = 'scholarseed-preview-actions'
export const PREVIEW_INSTANCE_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/
export const PREVIEW_RUNTIME_RECONFIGURATION = {
  path: '/api/serve/runtime/reconfiguration',
  sessionAction: 'runtime/reconfigure',
} as const
