import type { Session } from 'electron'
import type { PluginReference } from '../plugins.ts'
import { skillRequest } from '../skills.ts'

const PLUGIN_BINDING_TIMEOUT_MS = 10_000
const PLUGIN_BINDING_TIMEOUT_ERROR = 'plugin_binding_timeout'

export async function validatePluginBinding(
  session: Pick<Session, 'fetch'>,
  base: string,
  reference: PluginReference,
  hostHeaders: Record<string, string>
): Promise<number> {
  const validation = skillRequest({ operation: 'plugin-open', reference })
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error(PLUGIN_BINDING_TIMEOUT_ERROR)),
    PLUGIN_BINDING_TIMEOUT_MS
  )
  try {
    const response = await session.fetch(`${base}${validation.path}`, {
      ...validation.init,
      redirect: 'error',
      headers: { ...validation.init.headers, ...hostHeaders },
      signal: controller.signal,
    })
    const reader = response.body?.getReader()
    if (reader) {
      try {
        for (;;) {
          if ((await reader.read()).done) break
        }
      } finally {
        reader.releaseLock()
      }
    }
    return response.status
  } catch (error) {
    controller.abort()
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
