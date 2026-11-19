import { nativeImage, type NativeImage } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'

import { readRemoteImage } from './remote'

import {
  OfficeImageError,
  OFFICE_IMAGE_MAX_BYTES,
  OFFICE_IMAGE_MAX_PIXELS,
  type OfficeImageResult,
  type RemoteImageResult,
} from '../images'

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']

export async function acquireRemoteImage(input: unknown): Promise<RemoteImageResult> {
  try {
    const result = normalize(nativeImage.createFromBuffer(await readRemoteImage(input)))
    return result.status === 'image' ? result : { status: 'error', code: 'unreadable' }
  } catch (error) {
    return error instanceof OfficeImageError
      ? { status: 'error', code: error.failure.code }
      : { status: 'error', code: 'read_failed' }
  }
}

function normalize(image: NativeImage): OfficeImageResult {
  if (image.isEmpty()) return { status: 'empty' }
  const { width, height } = image.getSize()
  if (width * height > OFFICE_IMAGE_MAX_PIXELS)
    throw new OfficeImageError({ code: 'pixel_limit', maxPixels: OFFICE_IMAGE_MAX_PIXELS })
  const bytes = image.toPNG()
  if (bytes.byteLength > OFFICE_IMAGE_MAX_BYTES)
    throw new OfficeImageError({ code: 'byte_limit', maxBytes: OFFICE_IMAGE_MAX_BYTES })
  return { status: 'image', bytes: new Uint8Array(bytes) }
}

export async function readSelectedImage(path: string): Promise<OfficeImageResult> {
  if (!IMAGE_EXTENSIONS.includes(extname(path).slice(1).toLowerCase())) return { status: 'empty' }
  const info = await stat(path)
  if (!info.isFile() || info.size > OFFICE_IMAGE_MAX_BYTES)
    throw new OfficeImageError({ code: 'invalid_file', maxBytes: OFFICE_IMAGE_MAX_BYTES })
  const bytes = await readFile(path)
  if (bytes.byteLength > OFFICE_IMAGE_MAX_BYTES)
    throw new OfficeImageError({ code: 'byte_limit', maxBytes: OFFICE_IMAGE_MAX_BYTES })
  return normalize(nativeImage.createFromBuffer(bytes))
}
