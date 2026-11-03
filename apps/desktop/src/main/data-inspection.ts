import { inspectHistoryRequest } from './history-record.ts'
import { DESKTOP_INSPECTION_MAX_BYTES, inspectDesktopRecords } from './desktop-records.ts'

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > DESKTOP_INSPECTION_MAX_BYTES) throw new Error('Inspection frame too large')
    chunks.push(bytes)
  }
  const input = Buffer.concat(chunks)
  if (input.at(-1) !== 10) throw new Error('Incomplete inspection frame')
  const request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input))
  const report =
    request?.owner === 'browser-history'
      ? inspectHistoryRequest(request)
      : inspectDesktopRecords(request)
  process.stdout.write(`${JSON.stringify(report)}\n`)
}

void main().catch(() => {
  // File contents and parser errors can contain credentials or user data.
  process.stderr.write('desktop_inspection_failed\n')
  process.exitCode = 2
  process.stdin.destroy()
})
