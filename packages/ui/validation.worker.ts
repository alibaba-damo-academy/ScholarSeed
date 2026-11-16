import { createParser, type LibraryJSONSchema } from '@openuidev/lang-core'
import { OPENUI_LIMITS } from './document'
import { validateSource, validateTree } from './validation'

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ source: string; schema: LibraryJSONSchema; root: string }>) => void) | null
  postMessage: (value: { ready?: boolean; valid?: boolean; error?: string }) => void
}

scope.postMessage({ ready: true })

scope.onmessage = ({ data }) => {
  try {
    validateSource(data.source)
    const result = createParser(data.schema, data.root).parse(data.source)
    if (!result.root || result.rootExpression || result.meta.incomplete || result.meta.errors.length ||
        result.meta.unresolved.length || result.meta.statementCount > OPENUI_LIMITS.statements ||
        result.queryStatements.length || result.mutationStatements.length)
      throw new Error('openui_description_invalid')
    validateTree(result.root, Object.keys(data.schema.properties ?? {}))
    scope.postMessage({ valid: true })
  } catch (error) {
    scope.postMessage({ valid: false, error: error instanceof Error ? error.message : 'openui_validation_failed' })
  }
}
