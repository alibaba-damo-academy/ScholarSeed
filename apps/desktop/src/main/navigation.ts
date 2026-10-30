import { isIP } from 'node:net'

import { BROWSER_ERROR } from '../browser.ts'

const HTTP_PROTOCOL = 'http:'
const HTTPS_PROTOCOL = 'https:'

const SCHEME = /^[a-z][a-z\d+.-]*:/i
const WEB_SCHEME = /^https?:\/\//i
const DOMAIN_WITH_PORT = /^(?:localhost|[a-z\d-]+(?:\.[a-z\d-]+)+):\d+(?:[/?#]|$)/i
const HOST_LABEL = /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

export interface BrowserResourceRequest {
  url: URL
  topOrigin: string
  approvedLocalOrigin: string | null
  apiOrigin: string | null
}

function validWebUrl(url: URL): boolean {
  if ((url.protocol !== HTTP_PROTOCOL && url.protocol !== HTTPS_PROTOCOL)
    || !url.hostname || url.username || url.password) return false
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(hostname)) return true
  return hostname.split('.').every((label) => HOST_LABEL.test(label))
}

export function normalizeBrowserInput(input: string): URL {
  const trimmed = input.trim()
  if (!trimmed || CONTROL_CHARACTER.test(trimmed)) throw new Error(BROWSER_ERROR.invalidUrl)
  if (SCHEME.test(trimmed) && !WEB_SCHEME.test(trimmed) && !DOMAIN_WITH_PORT.test(trimmed)) {
    throw new Error(BROWSER_ERROR.invalidUrl)
  }
  try {
    const url = new URL(WEB_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`)
    if (validWebUrl(url)) return url
  } catch {
    throw new Error(BROWSER_ERROR.invalidUrl)
  }
  throw new Error(BROWSER_ERROR.invalidUrl)
}

function privateIPv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number)
  const [first, second] = octets
  return first === 0 || first === 10 || first === 127 || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
}

export function mappedIPv4(hostname: string): string | null {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host.startsWith('::ffff:')) return null
  const mapped = host.slice('::ffff:'.length)
  if (isIP(mapped) === 4) return mapped
  const groups = mapped.split(':')
  if (groups.length !== 2 || groups.some((group) => !/^[\da-f]{1,4}$/.test(group))) return null
  const high = parseInt(groups[0], 16)
  const low = parseInt(groups[1], 16)
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

export function browserLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  const mapped = mappedIPv4(host)
  const address = mapped ?? host
  return isIP(address) === 4 && address.split('.')[0] === '127'
}

function privateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  const ipVersion = isIP(host)
  if (ipVersion === 4) return privateIPv4(host)
  if (ipVersion === 6) {
    if (host === '::' || host === '::1') return true
    const firstGroup = parseInt(host.split(':')[0] || '0', 16)
    if ((firstGroup & 0xfe00) === 0xfc00 || (firstGroup & 0xffc0) === 0xfe80) return true
    if (host.startsWith('::ffff:')) {
      const mapped = mappedIPv4(host)
      return mapped === null || privateIPv4(mapped)
    }
  }
  return false
}

export function browserResourceAllowed(request: BrowserResourceRequest): boolean {
  const { url, topOrigin, approvedLocalOrigin, apiOrigin } = request
  if (!validWebUrl(url)) return false
  if (!privateHost(url.hostname)) return true
  return approvedLocalOrigin !== null && apiOrigin !== null
    && approvedLocalOrigin === apiOrigin
    && topOrigin === approvedLocalOrigin
    && url.origin === approvedLocalOrigin
    && browserLoopbackHost(url.hostname)
}
