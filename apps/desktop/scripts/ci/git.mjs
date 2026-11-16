import { execFileSync } from 'node:child_process'

const MAX_GIT_OUTPUT = 64 * 1024 * 1024

export function readGitBlobs(specifications, { root } = {}) {
  const unique = [...new Set(specifications)]
  if (!unique.length) return new Map()
  const output = execFileSync('git', ['cat-file', '--batch', '-z'], {
    cwd: root,
    input: unique.join('\0') + '\0',
    maxBuffer: MAX_GIT_OUTPUT,
  })
  const result = new Map()
  let offset = 0
  for (const specification of unique) {
    const headerEnd = output.indexOf(10, offset)
    const header = output.subarray(offset, headerEnd).toString('utf8')
    const match = /^[a-f0-9]+ blob (\d+)$/.exec(header)
    if (headerEnd < 0 || !match) throw new Error(`Git blob unavailable: ${specification}`)
    const start = headerEnd + 1
    const end = start + Number(match[1])
    if (end >= output.length || output[end] !== 10) throw new Error(`Git blob truncated: ${specification}`)
    result.set(specification, output.subarray(start, end).toString('utf8'))
    offset = end + 1
  }
  if (offset !== output.length) throw new Error('Git blob batch contains unexpected output')
  return result
}
