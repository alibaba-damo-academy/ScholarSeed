import { createServer, type ServerResponse } from 'node:http'
import { lstat, open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'

const LOOPBACK_HOST = '127.0.0.1'
const AUTOMATIC_PORT = 0
const ROOT_PATH = '/'
const INDEX_FILE = 'index.html'
const OFFICE_PREFIX = '/office/'
const STATIC_DIRECTORIES = new Set(['assets', 'fonts', 'office'])
const STATIC_ENTRIES = new Set(['index.html', 'monaco.html', 'favicon.ico'])
const ALLOWED_METHODS = new Set(['GET', 'HEAD'])
const STATUS = { ok: 200, partial: 206, forbidden: 403, missing: 404, method: 405, range: 416 } as const
const MEDIA_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}
const DEFAULT_MEDIA_TYPE = 'application/octet-stream'
const SECURITY_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-cache',
}

export interface AssetServer {
  url: string
  setOfficeRoot(root: string): Promise<void>
  close(): Promise<void>
}

async function trustedRoot(directory: string): Promise<string> {
  if (!isAbsolute(directory)) throw new Error('asset_root_invalid')
  let current = directory
  while (true) {
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('asset_root_invalid')
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return realpath(directory)
}

async function assetFile(root: string, segments: string[]) {
  let filename = root
  for (const segment of segments) {
    filename = join(filename, segment)
    const details = await lstat(filename)
    if (details.isSymbolicLink()) throw new Error('asset_link_rejected')
  }
  const resolved = await realpath(filename)
  const within = relative(root, resolved)
  if (within.startsWith(`..${sep}`) || within === '..' || isAbsolute(within))
    throw new Error('asset_path_rejected')
  const metadata = await lstat(filename)
  if (process.platform === 'win32' && resolved.toLowerCase() !== filename.toLowerCase())
    throw new Error('asset_reparse_rejected')
  const handle = await open(resolved, constants.O_RDONLY |
    (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
  try {
    const details = await handle.stat()
    if (!details.isFile() || details.dev !== metadata.dev || details.ino !== metadata.ino)
      throw new Error('asset_not_file')
    return { handle, size: details.size, filename }
  } catch (error) {
    await handle.close()
    throw error
  }
}

export function byteRange(value: string | undefined, size: number): { start: number; end: number } | null {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match || (!match[1] && !match[2])) throw new Error('asset_range_invalid')
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size)
    throw new Error('asset_range_invalid')
  return { start, end }
}

function finish(response: ServerResponse, status: number): void {
  response.writeHead(status, SECURITY_HEADERS)
  response.end()
}

export async function serveAssets(directory: string): Promise<AssetServer> {
  const root = await trustedRoot(directory)
  const index = await assetFile(root, [INDEX_FILE])
  await index.handle.close()
  let officeRoot: string | null = null
  let expectedHost = ''
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.host !== expectedHost) return finish(response, STATUS.forbidden)
      if (!ALLOWED_METHODS.has(request.method ?? '')) return finish(response, STATUS.method)
      const rawPath = (request.url ?? '').split('?')[0]
      if (/%2f|%5c/i.test(rawPath)) return finish(response, STATUS.forbidden)
      let pathname: string
      try {
        pathname = decodeURIComponent(rawPath)
      } catch {
        return finish(response, STATUS.forbidden)
      }
      const segments = pathname === ROOT_PATH ? [INDEX_FILE] : pathname.slice(1).split('/')
      if (!pathname.startsWith(ROOT_PATH) || segments.some(segment =>
        !segment || segment === '.' || segment === '..' || /[\\\x00:]/.test(segment)))
        return finish(response, STATUS.forbidden)
      if (!(segments.length === 1 && STATIC_ENTRIES.has(segments[0])) &&
          !STATIC_DIRECTORIES.has(segments[0])) return finish(response, STATUS.missing)
      const office = pathname.startsWith(OFFICE_PREFIX) && officeRoot !== null
      let file
      try {
        file = await assetFile(office ? officeRoot! : root, office ? segments.slice(1) : segments)
      } catch {
        return finish(response, STATUS.missing)
      }
      try {
        let range
        try {
          range = byteRange(request.headers.range, file.size)
        } catch {
          response.setHeader('Content-Range', `bytes */${file.size}`)
          return finish(response, STATUS.range)
        }
        response.writeHead(range ? STATUS.partial : STATUS.ok, {
          ...SECURITY_HEADERS,
          'Content-Type': MEDIA_TYPES[extname(file.filename).toLowerCase()] ?? DEFAULT_MEDIA_TYPE,
          'Content-Length': range ? range.end - range.start + 1 : file.size,
          'Accept-Ranges': 'bytes',
          ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${file.size}` } : {}),
        })
        if (request.method === 'HEAD') response.end()
        else await pipeline(file.handle.createReadStream({ ...range, autoClose: false }), response)
      } finally {
        await file.handle.close()
      }
    })().catch(() => {
      if (!response.headersSent) finish(response, STATUS.missing)
      else response.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(AUTOMATIC_PORT, LOOPBACK_HOST, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('asset_listener_invalid')
  expectedHost = `${LOOPBACK_HOST}:${address.port}`
  let closing: Promise<void> | null = null
  return {
    url: `http://${expectedHost}`,
    async setOfficeRoot(directory) {
      officeRoot = await trustedRoot(directory)
    },
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        server.closeAllConnections()
      })
      return closing
    },
  }
}
