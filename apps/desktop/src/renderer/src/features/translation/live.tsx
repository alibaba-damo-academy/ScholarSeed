import React, { useEffect, useState } from 'react'
import type {
  TranslationRequest,
  TranslationReply,
  TranslationPreferences,
} from '../../../../translation'
import { TranslationProvider, type TranslationBackend } from './context'
import {
  initialTranslation,
  PUBLIC_SERVICE_FIELDS,
  rememberChoice,
  TRANSLATION_SERVICES,
  translationAllowed,
  type TranslationState,
} from './model'

const ERROR_CODES = new Set([
  'authentication',
  'quota',
  'rate_limited',
  'provider_rejected',
  'empty_text',
  'text_too_long',
  'direction',
  'region',
  'timeout',
  'network',
  'storage',
  'unconfigured',
  'invalid_response',
  'superseded',
  'required',
])
export function translationError(error: unknown): string {
  return error instanceof Error && ERROR_CODES.has(error.message) ? error.message : 'network'
}

function readPreferences(value: unknown): TranslationPreferences {
  if (
    !value ||
    typeof value !== 'object' ||
    !('toolbar' in value) ||
    !('selectionAutomatic' in value) ||
    typeof value.toolbar !== 'boolean' ||
    typeof value.selectionAutomatic !== 'boolean'
  )
    throw new Error('invalid_response')
  return { toolbar: value.toolbar, selectionAutomatic: value.selectionAutomatic }
}

function readConfiguration(value: unknown): TranslationState['configuration'] {
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(
    TRANSLATION_SERVICES.filter((service) => service.id in value).map((service) => {
      const fields: unknown = value[service.id as keyof typeof value]
      return [
        service.id,
        Object.fromEntries(
          fields && typeof fields === 'object'
            ? Object.entries(fields).filter(
                ([name, field]) =>
                  PUBLIC_SERVICE_FIELDS.includes(name) &&
                  (service.fields as readonly string[]).includes(name) &&
                  typeof field === 'string'
              )
            : []
        ),
      ]
    })
  )
}

export function createLiveTranslation(
  send: (request: TranslationRequest) => Promise<TranslationReply>
): TranslationBackend & { load: () => Promise<void> } {
  let state: TranslationState = {
    ...initialTranslation(),
    defaultEngine: 'ai:',
    packages: {},
    preferencesReady: false,
  }
  let writes = Promise.resolve()
  let pendingWrites = 0
  let loading: Promise<void> | null = null
  const listeners = new Set<() => void>()
  const invalidations = new Map<string, Promise<unknown>>()
  const commit = (next: TranslationState): void => {
    state = next
    listeners.forEach((listener) => listener())
  }
  const request = async (
    payload: TranslationRequest
  ): Promise<{
    services?: TranslationState['services']
    configuration?: unknown
    preferences?: unknown
    text?: string
    retries?: number
  }> => {
    const reply = await send(payload)
    const body = JSON.parse(reply.body)
    if (reply.status !== 200)
      throw new Error(ERROR_CODES.has(body.detail) ? body.detail : 'network')
    return body
  }
  return {
    live: true,
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    load: () => {
      if (loading) return loading
      commit({ ...state, preferencesReady: false, preferencesError: undefined })
      loading = (async () => {
        try {
          await writes
          const { services, configuration, preferences } = await request({ operation: 'status' })
          commit({
            ...state,
            ...readPreferences(preferences),
            services: services ?? state.services,
            configuration: readConfiguration(configuration),
            preferencesReady: true,
            preferencesError: undefined,
            loadError: undefined,
          })
        } catch (error) {
          commit({
            ...state,
            loadError: translationError(error),
            preferencesReady: false,
            preferencesError: translationError(error),
          })
        } finally {
          loading = null
        }
      })()
      return loading
    },
    update: (patch) => {
      const { toolbar, selectionAutomatic, ...local } = patch
      commit({ ...state, ...local })
      if (toolbar === undefined && selectionAutomatic === undefined) return
      const preferences: Partial<TranslationPreferences> = {
        ...(toolbar === undefined ? {} : { toolbar }),
        ...(selectionAutomatic === undefined ? {} : { selectionAutomatic }),
      }
      pendingWrites += 1
      commit({ ...state, preferencesSaving: true, preferencesError: undefined })
      writes = writes.then(async () => {
        try {
          if (!state.preferencesReady) throw new Error('network')
          const result = await request({ operation: 'preferences', preferences })
          commit({ ...state, ...readPreferences(result.preferences), preferencesError: undefined })
        } catch (error) {
          commit({ ...state, preferencesError: translationError(error) })
        } finally {
          pendingWrites -= 1
          commit({ ...state, preferencesSaving: pendingWrites > 0 })
        }
      })
      return writes
    },
    choose: (document, scope, choice) => commit(rememberChoice(state, document, scope, choice)),
    invalidate: (provider) => {
      if (state.services[provider] === 'unconfigured' || state.services[provider] === 'pending')
        return
      commit({
        ...state,
        services: { ...state.services, [provider]: 'unconfigured' },
        configuration: { ...state.configuration, [provider]: {} },
      })
      const operation = request({ operation: 'invalidate', provider })
      invalidations.set(provider, operation)
      void operation.catch(() => undefined)
    },
    verify: async (provider, fields, onRecovered) => {
      if (state.services[provider] === 'pending') return false
      commit({ ...state, services: { ...state.services, [provider]: 'pending' } })
      try {
        await invalidations.get(provider)
        invalidations.delete(provider)
        const result = await request({ operation: 'verify', provider, fields })
        commit({
          ...state,
          services: { ...state.services, [provider]: 'configured' },
          configuration: {
            ...state.configuration,
            [provider]: readConfiguration(result.configuration)[provider] ?? {},
          },
        })
        if (result.retries && result.retries > 0) onRecovered?.()
        return true
      } catch (error) {
        invalidations.delete(provider)
        commit({ ...state, services: { ...state.services, [provider]: 'failed' } })
        throw error
      }
    },
    install: async () => false,
    translate: async (choice, source, signal, onRecovered) => {
      signal.throwIfAborted()
      if (!translationAllowed(state, choice)) throw new Error('direction')
      const { text, retries } = await request({
        operation: 'translate',
        provider: choice.engine,
        text: source,
        source: choice.source,
        target: choice.target,
      })
      signal.throwIfAborted()
      if (typeof text !== 'string' || !text.trim()) throw new Error('invalid_response')
      if (retries && retries > 0) onRecovered?.()
      return text
    },
  }
}

export function LiveTranslationProvider({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const [backend] = useState(() =>
    window.scholarseed?.translation ? createLiveTranslation(window.scholarseed.translation) : null
  )
  useEffect(() => {
    void backend?.load()
  }, [backend])
  return backend ? (
    <TranslationProvider backend={backend}>{children}</TranslationProvider>
  ) : (
    <>{children}</>
  )
}
