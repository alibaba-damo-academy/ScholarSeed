import { readFileSync } from 'node:fs'
import { pdfeTaskContext } from '../../../../apps/desktop/preview/collaboration.ts'

try {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  process.stdout.write(JSON.stringify(pdfeTaskContext(input), null, 2) + '\n')
} catch (error) {
  process.stderr.write('PDFE task context: ' + (error instanceof Error ? error.message : String(error)) + '\n')
  process.exitCode = 1
}
