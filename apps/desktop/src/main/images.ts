import { clipboard, dialog, nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mainLocalization } from './localization'

import { OfficeImageError, OFFICE_IMAGE_MAX_BYTES, OFFICE_IMAGE_MAX_PIXELS, OFFICE_IMAGE_MEDIA_TYPE, type OfficeImageResult, type OfficeImageSource } from '../images'

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']
const CLIPBOARD_FILE_URL = 'electron application/osclipboard;format="public.file-url"'
const FILE_PROTOCOL = 'file:'

function normalize(image: NativeImage): OfficeImageResult {
  if (image.isEmpty()) return { status: 'empty' }
  const { width, height } = image.getSize()
  if (width * height > OFFICE_IMAGE_MAX_PIXELS) throw new OfficeImageError({ code: 'pixel_limit', maxPixels: OFFICE_IMAGE_MAX_PIXELS })
  const bytes = image.toPNG()
  if (bytes.byteLength > OFFICE_IMAGE_MAX_BYTES) throw new OfficeImageError({ code: 'byte_limit', maxBytes: OFFICE_IMAGE_MAX_BYTES })
  return { status: 'image', bytes: new Uint8Array(bytes) }
}

async function readSelectedImage(path: string): Promise<OfficeImageResult> {
  if (!IMAGE_EXTENSIONS.includes(extname(path).slice(1).toLowerCase())) return { status: 'empty' }
  const info = await stat(path)
  if (!info.isFile() || info.size > OFFICE_IMAGE_MAX_BYTES) throw new OfficeImageError({ code: 'invalid_file', maxBytes: OFFICE_IMAGE_MAX_BYTES })
  const bytes = await readFile(path)
  if (bytes.byteLength > OFFICE_IMAGE_MAX_BYTES) throw new OfficeImageError({ code: 'byte_limit', maxBytes: OFFICE_IMAGE_MAX_BYTES })
  return normalize(nativeImage.createFromBuffer(bytes))
}

export async function acquireOfficeImage(window: BrowserWindow, source: OfficeImageSource): Promise<OfficeImageResult> {
  try {
    if (source === 'file') {
      const selected = await dialog.showOpenDialog(window, {
        title: mainLocalization().getFixedT(null, 'native')('dialogs.insertImage'), properties: ['openFile'], filters: [{ name: mainLocalization().getFixedT(null, 'native')('dialogs.images'), extensions: IMAGE_EXTENSIONS }]
      })
      if (selected.canceled || !selected.filePaths[0]) return { status: 'cancelled' }
      const result = await readSelectedImage(selected.filePaths[0])
      return result.status === 'empty' ? { status: 'error', code: 'unreadable' } : result
    }
    if (source !== 'clipboard') throw new OfficeImageError({ code: 'unsupported_source' })
    const items = await clipboard.read()
    const imageItem = items.find(item => item.types.includes(OFFICE_IMAGE_MEDIA_TYPE))
    if (imageItem) {
      const blob = await imageItem.getType(OFFICE_IMAGE_MEDIA_TYPE)
      if (blob instanceof Blob) {
        if (blob.size > OFFICE_IMAGE_MAX_BYTES) throw new OfficeImageError({ code: 'clipboard_limit', maxBytes: OFFICE_IMAGE_MAX_BYTES })
        const image = normalize(nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer())))
        if (image.status !== 'empty') return image
      }
    }
    // Finder supplies a file URL when copying a local file, not bitmap bytes.
    const fileItem = items.find(item => item.types.includes(CLIPBOARD_FILE_URL))
    if (process.platform === 'darwin' && fileItem) {
      const value = await fileItem.getType(CLIPBOARD_FILE_URL)
      if (value instanceof Blob) {
        if (value.size > OFFICE_IMAGE_MAX_BYTES) throw new OfficeImageError({ code: 'clipboard_limit', maxBytes: OFFICE_IMAGE_MAX_BYTES })
        const url = new URL(await value.text())
        if (url.protocol === FILE_PROTOCOL) return await readSelectedImage(fileURLToPath(url))
      }
    }
    const text = await clipboard.readText()
    if (Buffer.byteLength(text) > OFFICE_IMAGE_MAX_BYTES) throw new OfficeImageError({ code: 'clipboard_limit', maxBytes: OFFICE_IMAGE_MAX_BYTES })
    return text ? { status: 'text', text } : { status: 'empty' }
  } catch (error) {
    return error instanceof OfficeImageError
      ? { status: 'error', ...error.failure }
      : { status: 'error', code: 'read_failed', message: error instanceof Error ? error.message : String(error) }
  }
}
