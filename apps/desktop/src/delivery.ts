export const DELIVERY_PICK_CHANNEL = 'scholarseed:delivery-pick'
export const DELIVERY_OPEN_CHANNEL = 'scholarseed:delivery-open'
export const DELIVERY_SAVE_CHANNEL = 'scholarseed:delivery-save'
export const DELIVERY_REQUEST_LIMIT = 128
export const DELIVERY_PATH_LIMIT = 4096
export const DELIVERY_NATIVE_UNAVAILABLE = 'literature_delivery_native_unavailable'
export const DELIVERY_INVALID_REQUEST = 'literature_delivery_request_invalid'
export const DELIVERY_INVALID_SENDER = 'literature_delivery_invalid_sender'
export const DELIVERY_VERSION_ACTIONS = ['keep_both', 'skip'] as const
const DELIVERY_CHOICE_KEYS = [
  'target',
  'project_id',
  'parent',
  'ticket',
  'add_to_library',
  'collection_id',
  'versions',
]

export interface DeliveryRequest {
  sessionId: string
  deliveryId: string
}

export interface DeliverySaveRequest extends DeliveryRequest {
  choice: {
    target: 'project' | 'directory'
    project_id?: string
    parent: string
    ticket: string
    add_to_library: boolean
    collection_id: string
    versions?: Record<string, 'keep_both' | 'skip'>
  }
}

export interface DeliveryNativeReply {
  ok: boolean
  canceled?: boolean
  ticket?: string
  label?: string
  error?: string
  value?: unknown
}

export function parseDeliverySave(value: unknown): DeliverySaveRequest {
  if (!value || typeof value !== 'object') throw new Error(DELIVERY_INVALID_REQUEST)
  const request = value as Record<string, unknown>
  if (Object.keys(request).length !== 3) throw new Error(DELIVERY_INVALID_REQUEST)
  const identity = parseDeliveryRequest({
    sessionId: request.sessionId,
    deliveryId: request.deliveryId,
  })
  const choice = request.choice as DeliverySaveRequest['choice'] | undefined
  if (
    !choice ||
    typeof choice !== 'object' ||
    Object.keys(choice).some((key) => !DELIVERY_CHOICE_KEYS.includes(key)) ||
    !['project', 'directory'].includes(choice.target) ||
    typeof choice.add_to_library !== 'boolean' ||
    !['parent', 'ticket', 'collection_id'].every((key) => {
      const field = choice[key as 'parent' | 'ticket' | 'collection_id']
      return (
        typeof field === 'string' &&
        field.length <= (key === 'parent' ? DELIVERY_PATH_LIMIT : DELIVERY_REQUEST_LIMIT)
      )
    })
  )
    throw new Error(DELIVERY_INVALID_REQUEST)
  if (
    choice.project_id !== undefined &&
    (typeof choice.project_id !== 'string' || choice.project_id.length > DELIVERY_REQUEST_LIMIT)
  )
    throw new Error(DELIVERY_INVALID_REQUEST)
  if (
    choice.versions !== undefined &&
    (!choice.versions ||
      typeof choice.versions !== 'object' ||
      Array.isArray(choice.versions) ||
      !Object.entries(choice.versions).every(
        ([paper, action]) =>
          paper.length > 0 &&
          paper.length <= DELIVERY_REQUEST_LIMIT &&
          DELIVERY_VERSION_ACTIONS.includes(action)
      ))
  )
    throw new Error(DELIVERY_INVALID_REQUEST)
  return { ...identity, choice }
}

export function parseDeliveryRequest(value: unknown): DeliveryRequest {
  if (!value || typeof value !== 'object') throw new Error(DELIVERY_INVALID_REQUEST)
  const request = value as Record<string, unknown>
  if (
    Object.keys(request).length !== 2 ||
    !['sessionId', 'deliveryId'].every(
      (key) =>
        typeof request[key] === 'string' &&
        request[key].length > 0 &&
        request[key].length <= DELIVERY_REQUEST_LIMIT
    )
  )
    throw new Error(DELIVERY_INVALID_REQUEST)
  return request as unknown as DeliveryRequest
}

export function deliveryPath(request: DeliveryRequest, action: string): string {
  return `/api/sessions/${encodeURIComponent(request.sessionId)}/literature/deliveries/${encodeURIComponent(request.deliveryId)}/${action}`
}
