import { randomUUID } from 'node:crypto'
import type { PersonalApiProfile, PersonalApiProfilesResp, ModelProvidersResp } from '../src/renderer/src/api.ts'

export const PREVIEW_MODELS = {
  profilesPath: '/api/serve/model-profiles',
  providersPath: '/api/serve/model-providers',
  logicalPath: '/preview/model-profiles.json',
  delayMs: 2_000,
  readFailure: 'preview_model_profiles_unavailable',
  readOnly: 'preview_model_profiles_read_only',
  notFound: 'preview_model_profile_not_found',
  disposed: 'preview_model_profiles_disposed',
} as const

export const PREVIEW_MODEL_SAMPLE: Omit<PersonalApiProfile, 'id'> = {
  name: '模拟只读连接 · 不执行模型',
  preview_name: '模拟只读连接 · 不执行模型',
  preset_id: '',
  provider: 'openai',
  wire_api: 'chat_completions',
  base_url: 'https://example.invalid/v1',
  authentication: 'api_key',
  oauth_provider: '',
  enabled: false,
  small_model_name: 'preview-text',
  has_api_key: false,
  has_headers: false,
  header_names: [],
  image_input: false,
  pdf_input: false,
  selected_models: [
    { id: 'preview-text', label: '模拟文本模型', context_window: 128_000, max_output_tokens: 4096, input_modalities: ['text'], reasoning_efforts: ['medium'] },
    { id: 'preview-vision', label: '模拟视觉声明（不执行）', context_window: 32_000, max_output_tokens: 2048, input_modalities: ['text', 'image'] },
  ],
}

export interface PreviewModelPolicy { read: 'sample' | 'empty' | 'delayed' | 'failed' }

export class PreviewModelError extends Error {
  readonly status: number
  constructor(code: string, status: number) { super(code); this.status = status }
}

export class PreviewModels {
  private readonly mode: PreviewModelPolicy['read']
  private readonly document: PersonalApiProfilesResp
  private disposed = false
  private readonly pending = new Set<() => void>()

  constructor(policy: PreviewModelPolicy = { read: 'empty' }) {
    this.mode = policy.read
    this.document = {
      path: PREVIEW_MODELS.logicalPath,
      profiles: policy.read === 'empty' || policy.read === 'failed' ? [] : [{
        ...structuredClone(PREVIEW_MODEL_SAMPLE), id: `personal-${randomUUID().replace(/-/g, '')}`,
      }],
      enabled_profile_ids: [],
    }
  }

  hasProfile(id: string): boolean {
    return !this.disposed && this.document.profiles.some(profile => profile.id === id)
  }

  providers(): ModelProvidersResp { return { providers: [] } }

  async read(signal?: AbortSignal): Promise<PersonalApiProfilesResp> {
    if (this.disposed || signal?.aborted) throw new PreviewModelError(PREVIEW_MODELS.disposed, 410)
    if (this.mode === 'failed') throw new PreviewModelError(PREVIEW_MODELS.readFailure, 503)
    if (this.mode === 'delayed') {
      await new Promise<void>((resolve, reject) => {
        const finish = (cancelled: boolean): void => {
          clearTimeout(timer)
          this.pending.delete(cancel)
          signal?.removeEventListener('abort', cancel)
          if (cancelled) reject(new PreviewModelError(PREVIEW_MODELS.disposed, 410))
          else resolve()
        }
        const cancel = (): void => finish(true)
        const timer = setTimeout(() => finish(false), PREVIEW_MODELS.delayMs)
        this.pending.add(cancel)
        signal?.addEventListener('abort', cancel, { once: true })
      })
    }
    if (this.disposed || signal?.aborted) throw new PreviewModelError(PREVIEW_MODELS.disposed, 410)
    return structuredClone(this.document)
  }

  dispose(): void {
    this.disposed = true
    for (const cancel of this.pending) cancel()
    this.pending.clear()
  }
}
