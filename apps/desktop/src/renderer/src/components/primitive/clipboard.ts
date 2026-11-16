/** Desktop uses its existing preload capability; browsers retain their permission checks. */
export async function writeClipboard(text: string): Promise<void> {
  const native = window.scholarseed?.writeClipboard
  if (native) {
    const result = await native(text)
    if (!result.ok) throw new Error(result.error || 'clipboard_write_failed')
    return
  }
  await navigator.clipboard.writeText(text)
}

export async function writeClipboardContent(text: string, html: string): Promise<void> {
  const native = window.scholarseed?.writeClipboardContent
  if (native) {
    const result = await native({ text, html })
    if (!result.ok) throw new Error(result.error || 'clipboard_content_write_failed')
    return
  }
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    await writeClipboard(text)
    return
  }
  await navigator.clipboard.write([
    new ClipboardItem({
      'text/plain': new Blob([text], { type: 'text/plain' }),
      'text/html': new Blob([html], { type: 'text/html' }),
    }),
  ])
}

export async function copyImageElement(image: HTMLImageElement): Promise<void> {
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context || !canvas.width || !canvas.height) throw new Error('clipboard_image_unavailable')
  context.drawImage(image, 0, 0)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('clipboard_image_unavailable')
  await writeClipboardImage(blob)
}

export async function writeClipboardImage(blob: Blob): Promise<void> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const native = window.scholarseed?.writeClipboardImage
  if (native) {
    const result = await native(bytes)
    if (!result.ok) throw new Error(result.error || 'clipboard_image_write_failed')
    return
  }
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('clipboard_image_write_unavailable')
  }
  await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })])
}
