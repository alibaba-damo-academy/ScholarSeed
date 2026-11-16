const CLIPBOARD_DENIED = 'ui_clipboard_not_authorized'

async function denyClipboard(): Promise<never> {
  throw new Error(CLIPBOARD_DENIED)
}

export {
  denyClipboard as copyImageElement,
  denyClipboard as writeClipboard,
  denyClipboard as writeClipboardContent,
  denyClipboard as writeClipboardImage,
}
