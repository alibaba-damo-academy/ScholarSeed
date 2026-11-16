export const PREVIEW_DEV_PORT = 5175
export const PREVIEW_ORIGIN = `http://127.0.0.1:${PREVIEW_DEV_PORT}`
export const PREVIEW_CACHE_DIRECTORY = 'node_modules/.vite-scholarseed-preview'
export const PREVIEW_PROJECT_ID = 'preview-project'
export const PREVIEW_INSTANCE_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/
export const PREVIEW_RUNTIME_RECONFIGURATION = {
  path: '/api/serve/runtime/reconfiguration',
  sessionAction: 'runtime/reconfigure',
  preparationPath: '/api/serve/runtime/prepare',
  requestPattern: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
  invalid: 'runtime_reconfiguration_invalid',
  stale: 'runtime_reconfiguration_stale',
  notFound: 'runtime_reconfiguration_not_found',
  preparationInvalid: 'runtime_preparation_invalid',
  instanceChanged: 'runtime_preparation_instance_changed',
  preparationState: { applied: 'applied', rejected: 'rejected' },
} as const
