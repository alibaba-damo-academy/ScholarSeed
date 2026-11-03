import { createContext } from 'react'
import type { TFunction } from 'i18next'

interface OfficeFrameLifetime {
  token: string
  dispose: () => void
}

export type OfficeFrameTransport = OfficeFrameLifetime &
  ({ kind: 'srcdoc'; html: string } | { kind: 'url'; src: string })

export interface OfficeFrameRequest {
  translation: TFunction<'workbench'>
  language: 'zh' | 'en'
  locale: string
}

export type OfficeFrameFactory = (request: OfficeFrameRequest) => OfficeFrameTransport

export const OfficeFrameFactoryContext = createContext<OfficeFrameFactory | null>(null)

const OFFICE_FRAME_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isOfficeFrameToken(token: string): boolean {
  return OFFICE_FRAME_TOKEN.test(token)
}

export function resolveOfficeFrame(
  factory: OfficeFrameFactory | null,
  request: OfficeFrameRequest,
  fallback: OfficeFrameFactory
): OfficeFrameTransport {
  const frame = (factory ?? fallback)(request)
  if (!isOfficeFrameToken(frame.token)) {
    frame.dispose()
    throw new Error('Invalid Office frame token')
  }
  return frame
}
