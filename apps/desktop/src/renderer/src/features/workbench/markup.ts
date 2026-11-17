import DOMPurify from 'dompurify'

export const STATIC_HTML_POLICY =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

export function staticHtml(raw: string): string {
  const clean = DOMPurify.sanitize(raw, {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ['style'],
    FORBID_TAGS: [
      'script',
      'noscript',
      'iframe',
      'object',
      'embed',
      'meta',
      'base',
      'link',
      'video',
      'audio',
      'source',
      'track',
    ],
    FORBID_ATTR: [
      'href',
      'xlink:href',
      'srcset',
      'action',
      'formaction',
      'poster',
      'background',
      'autofocus',
    ],
    ALLOWED_URI_REGEXP: /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i,
  })
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${STATIC_HTML_POLICY}">${clean}`
}
