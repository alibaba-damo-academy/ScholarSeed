import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { previewCoverage } from './coverage.ts'

const REPORT_SCOPE = 'Declared test associations only; not execution results or product acceptance'
const REPORT_STATUSES = ['has-tests', 'partial', 'unmapped', 'excluded'] as const
const REPORT_USAGE = 'Usage: node --experimental-transform-types preview/report.ts <playwright-report.json|->'

export function previewCoverageReport(source: unknown) {
  const entries = previewCoverage(source)
  const summary = Object.fromEntries(REPORT_STATUSES.map(status => [status, entries.filter(entry => entry.status === status).length]))
  return { scope: REPORT_SCOPE, total: entries.length, summary, entries }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log(REPORT_USAGE)
  } else if (args.length !== 1 || !args[0] || (args[0].startsWith('-') && args[0] !== '-')) {
    console.error(REPORT_USAGE)
    process.exitCode = 1
  } else {
    try {
      const input = readFileSync(args[0] === '-' ? 0 : args[0], 'utf8')
      let source: unknown
      try { source = JSON.parse(input) }
      catch { throw new Error('Invalid JSON input') }
      console.log(JSON.stringify(previewCoverageReport(source), null, 2))
    } catch (error) {
      console.error('Preview coverage report failed:', error instanceof Error ? error.message : 'Unknown input error')
      process.exitCode = 1
    }
  }
}
