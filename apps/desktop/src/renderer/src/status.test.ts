import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

test('status reads batch session and queue limits without losing acknowledgements', async () => {
  const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true)
  const declarations = parsed.statements.filter((node) =>
    ts.isFunctionDeclaration(node)
      ? node.name?.text === 'loadSessionStatus'
      : ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((declaration) =>
          ['STATUS_SESSION_LIMIT', 'STATUS_QUEUE_LIMIT'].includes(declaration.name.getText(parsed))
        )
  )
  assert.equal(declarations.length, 3)
  const requests: Array<{ session_ids: string[]; queued_ids: Record<string, string[]> }> = []
  const context = {
    exports: {},
    apiFetch: async (_path: string, options: { body: string }) => {
      const request = JSON.parse(options.body)
      requests.push(request)
      return {
        ok: true,
        json: async () => ({
          sessions: request.session_ids.map((session_id: string) => ({
            session_id,
            summary_seq: requests.length,
            acknowledged_queue_ids: request.queued_ids[session_id] ?? [],
          })),
        }),
      }
    },
  }
  runInNewContext(
    ts.transpileModule(
      declarations.map((node) => node.getText(parsed)).join('\n') +
        '\nglobalThis.load = loadSessionStatus',
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
    ).outputText,
    context
  )
  const sessions = Array.from({ length: 203 }, (_, index) => `session-${index}`)
  const queue = Array.from({ length: 503 }, (_, index) => `queue-${index}`)
  const results = await (
    context as typeof context & {
      load: (
        sessions: string[],
        queue: Record<string, string[]>,
        signal: AbortSignal
      ) => Promise<Array<{ session_id: string; acknowledged_queue_ids: string[] }>>
    }
  ).load(sessions, { [sessions[0]]: queue }, new AbortController().signal)
  assert.equal(requests.length, 3)
  assert.equal(results.length, sessions.length)
  for (const request of requests) {
    assert.ok(request.session_ids.length <= 200)
    assert.ok(Object.values(request.queued_ids).flat().length <= 500)
  }
  assert.deepEqual(Array.from(results[0].acknowledged_queue_ids), queue)
})
