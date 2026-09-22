import { checkProjectCalls } from './localization/calls.mjs'
import { checkResourceFiles } from './localization/resources.mjs'
import { checkSources, generateDebt } from './localization/git.mjs'
import { checkStaged } from './localization/staged.mjs'

const args = process.argv.slice(2)
const baseIndex = args.indexOf('--base')
const base = baseIndex === -1 ? undefined : args[baseIndex + 1]
if (baseIndex !== -1 && (!base || base.startsWith('--'))) throw new Error('--base requires an explicit Git ref')
if (args.includes('--initialize-debt') || args.includes('--tighten')) {
  generateDebt(base, { tighten: args.includes('--tighten') })
  console.log('Debt generated; review exact AST entries before accepting.')
} else {
  const resources = checkResourceFiles({ write: args.includes('--generate') })
  if (!args.includes('--generate')) {
    const callErrors = checkProjectCalls(resources)
    if (callErrors.length) throw new Error(callErrors.join("\n"))
    const staged = checkStaged()
    if (staged.errors.length) throw new Error(staged.errors.join('\n'))
    const result = checkSources(base)
    if (result.errors.length) throw new Error(result.errors.join('\n'))
    console.log(`Localization resource/types/source checks passed against ${result.base}`)
  }
}
