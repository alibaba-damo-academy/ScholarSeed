import { request } from 'node:https'
import type { IncomingMessage } from 'node:http'

import { OfficeImageError, OFFICE_IMAGE_MAX_BYTES } from '../images.ts'
import { resolveBrowserDestinations } from './network.ts'

const IMAGE_TIMEOUT_MS = 30_000
const IMAGE_REDIRECT_LIMIT = 3
const IMAGE_USER_AGENT =
  'ScholarSeed (image preview; https://github.com/alibaba-damo-academy/ScholarSeed)'
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const IMAGE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
])

function imageUrl(input: unknown): URL {
  if (typeof input !== 'string' || /[\u0000-\u001f\u007f]/u.test(input))
    throw new OfficeImageError({ code: 'unsupported_source' })
  const url = new URL(input)
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new OfficeImageError({ code: 'unsupported_source' })
  return url
}

async function read(input: unknown, signal: AbortSignal): Promise<Buffer> {
  let url = imageUrl(input)
  for (let redirects = 0; ; redirects++) {
    const destinations = await resolveBrowserDestinations(url, null)
    signal.throwIfAborted()
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = request(
        url,
        {
          method: 'GET',
          agent: false,
          rejectUnauthorized: true,
          signal,
          headers: {
            Accept: [...IMAGE_MEDIA_TYPES].join(', '),
            'Accept-Encoding': 'identity',
            'User-Agent': IMAGE_USER_AGENT,
          },
          lookup: (_hostname, options, callback) => {
            const first = destinations[0]
            callback(null, options.all ? destinations : first.address, first.family)
          },
        },
        resolve
      )
      outgoing.once('error', reject)
      outgoing.end()
    })
    if (REDIRECT_STATUSES.has(response.statusCode ?? 0)) {
      response.destroy()
      if (redirects >= IMAGE_REDIRECT_LIMIT || !response.headers.location)
        throw new OfficeImageError({ code: 'read_failed' })
      url = imageUrl(new URL(response.headers.location, url).href)
      continue
    }
    const mediaType = response.headers['content-type']?.split(';', 1)[0].trim().toLowerCase()
    if (
      response.statusCode !== 200 ||
      !mediaType ||
      !IMAGE_MEDIA_TYPES.has(mediaType) ||
      (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
    ) {
      response.destroy()
      throw new OfficeImageError({ code: 'unreadable' })
    }
    if (Number(response.headers['content-length']) > OFFICE_IMAGE_MAX_BYTES) {
      response.destroy()
      throw new OfficeImageError({ code: 'byte_limit', maxBytes: OFFICE_IMAGE_MAX_BYTES })
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of response) {
      signal.throwIfAborted()
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > OFFICE_IMAGE_MAX_BYTES) {
        response.destroy()
        throw new OfficeImageError({ code: 'byte_limit', maxBytes: OFFICE_IMAGE_MAX_BYTES })
      }
      chunks.push(bytes)
    }
    return Buffer.concat(chunks, size)
  }
}

export async function readRemoteImage(input: unknown): Promise<Buffer> {
  const controller = new AbortController()
  let expired!: () => void
  const deadline = new Promise<never>((_resolve, reject) => {
    expired = () => {
      controller.abort()
      reject(new OfficeImageError({ code: 'read_failed' }))
    }
  })
  const timer = setTimeout(expired, IMAGE_TIMEOUT_MS)
  try {
    return await Promise.race([read(input, controller.signal), deadline])
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
