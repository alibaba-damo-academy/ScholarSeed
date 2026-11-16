const MATERIAL_FINALIZATIONS_ROUTE = '/api/resource/finalizations'

export function materialSessionRead(
  url: URL,
  method: string,
  project: { id: string; path: string },
  session: string
): Response | null {
  if (method !== 'GET' || !session) return null
  if (url.pathname === `/api/serve/sessions/${encodeURIComponent(session)}/runtime/reconfigure`)
    return new Response(null, { status: 204 })
  if (
    url.pathname === MATERIAL_FINALIZATIONS_ROUTE &&
    url.searchParams.get('session_id') === session &&
    [project.id, project.path].includes(url.searchParams.get('project') ?? '')
  )
    return new Response(JSON.stringify({ entries: [], next_cursor: null }), {
      headers: { 'content-type': 'application/json' },
    })
  return null
}

export function exampleSectionCode(source: string, id: string): string {
  const sectionStart = source.indexOf(
    `<section className={exampleSectionClass('${id}', activeExample)} id="${id}">`
  )
  if (sectionStart < 0) return ''
  const indentation = source.slice(source.lastIndexOf('\n', sectionStart) + 1, sectionStart)
  const afterStart = source.indexOf('\n', sectionStart)
  const sectionEnd = source.indexOf(`\n${indentation}</section>`, sectionStart)
  if (afterStart < 0 || sectionEnd < 0) return ''
  const lines = source
    .slice(afterStart + 1, sectionEnd)
    .replace(/\n\s*<CodePreview[^>]*\/>/g, '')
    .split('\n')
  const nonEmptyLines = lines.filter((line) => line.trim())
  const minIndent = nonEmptyLines.reduce(
    (minimum, line) => Math.min(minimum, line.match(/^\s*/)?.[0].length ?? 0),
    Number.POSITIVE_INFINITY
  )
  return lines
    .map((line) => line.slice(Number.isFinite(minIndent) ? minIndent : 0))
    .join('\n')
    .trim()
}
