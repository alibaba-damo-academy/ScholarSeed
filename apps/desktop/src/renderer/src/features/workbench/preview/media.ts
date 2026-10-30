import { convertMetafileToSvg } from 'emf-converter'
import UTIF from 'utif'
import { strToU8, unzipSync, zipSync } from 'fflate'

import { OOXML_NS, readXml, relationshipOwner, resolvePart, writeXml } from './xml.ts'

interface DecodedImage {
  bytes: Uint8Array<ArrayBuffer>
  extension: string
  mime: string
}

const CONTENT_TYPES_PART = '[Content_Types].xml'
const SVG_MIME = 'image/svg+xml'
const PNG_MIME = 'image/png'
const PREVIEW_IMAGE_SUFFIX = '.preview.'
const FIRST_IMAGE = 0

async function metafile(bytes: Uint8Array): Promise<DecodedImage> {
  const svg = await convertMetafileToSvg(Uint8Array.from(bytes).buffer)
  if (!svg) throw new Error('Unable to decode metafile')
  return { bytes: strToU8(svg), extension: 'svg', mime: SVG_MIME }
}

async function tiff(bytes: Uint8Array): Promise<DecodedImage> {
  const buffer = Uint8Array.from(bytes).buffer
  const image = UTIF.decode(buffer)[FIRST_IMAGE]
  if (!image) throw new Error('TIFF has no image')
  UTIF.decodeImage(buffer, image)
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Unable to encode decoded TIFF')
  context.putImageData(
    new ImageData(Uint8ClampedArray.from(UTIF.toRGBA8(image)), image.width, image.height),
    0,
    0
  )
  const png = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Unable to encode decoded TIFF'))
    }, PNG_MIME)
  )
  return { bytes: new Uint8Array(await png.arrayBuffer()), extension: 'png', mime: PNG_MIME }
}

const IMAGE_DECODERS: Readonly<Record<string, (bytes: Uint8Array) => Promise<DecodedImage>>> = {
  wmf: metafile,
  emf: metafile,
  tif: tiff,
  tiff,
}

/** Only the reader input is projected. Sessions, anchors and Agent still use the source package. */
export async function mediaPreview(bytes: Uint8Array): Promise<Uint8Array> {
  const entries = unzipSync(bytes)
  const converted = new Map<string, { path: string; extension: string; mime: string }>()
  for (const [path, content] of Object.entries(entries)) {
    if (!/^(word|ppt)\/media\//.test(path)) continue
    const decoder = IMAGE_DECODERS[path.split('.').at(-1)?.toLowerCase() ?? '']
    if (!decoder) continue
    const image = await decoder(content)
    const projectedPath = `${path}${PREVIEW_IMAGE_SUFFIX}${image.extension}`
    if (entries[projectedPath]) throw new Error('Duplicate preview image part')
    entries[projectedPath] = image.bytes
    converted.set(path, { path: projectedPath, extension: image.extension, mime: image.mime })
  }
  if (!converted.size) return bytes
  for (const [path, content] of Object.entries(entries)) {
    if (!path.endsWith('.rels')) continue
    const document = readXml(content)
    let changed = false
    for (const relationship of Array.from(
      document.getElementsByTagNameNS(OOXML_NS.relationships, 'Relationship')
    )) {
      if (relationship.getAttribute('TargetMode') === 'External') continue
      const target = relationship.getAttribute('Target')
      if (!target) continue
      const image = converted.get(resolvePart(relationshipOwner(path), target))
      if (!image) continue
      relationship.setAttribute('Target', `${target}${PREVIEW_IMAGE_SUFFIX}${image.extension}`)
      changed = true
    }
    if (changed) entries[path] = writeXml(document)
  }
  const types = readXml(entries[CONTENT_TYPES_PART])
  for (const image of converted.values()) {
    const existing = Array.from(
      types.getElementsByTagNameNS(OOXML_NS.contentTypes, 'Default')
    ).find((type) => type.getAttribute('Extension') === image.extension)
    if (!existing) {
      const type = types.createElementNS(OOXML_NS.contentTypes, 'Default')
      type.setAttribute('Extension', image.extension)
      type.setAttribute('ContentType', image.mime)
      types.documentElement.appendChild(type)
    }
  }
  entries[CONTENT_TYPES_PART] = writeXml(types)
  return zipSync(entries)
}
