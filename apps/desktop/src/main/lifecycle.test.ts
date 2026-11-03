import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { createBrowserReadGrants } from './grant.ts'

const SCOPE = {
  sessionId: 'session',
  instanceId: 'instance',
  productTurnId: 'product-turn',
  turnId: 'native-turn',
  generation: 1,
  interruptGeneration: 0,
  lifecycleEpoch: 1,
}
const EXPIRED_PROOF_ADVANCE_MS = 61_000
const MAIN = ts.createSourceFile(
  'index.ts',
  readFileSync(new URL('index.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true
)
const WINDOW = MAIN.statements.find(
  (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'createWindow'
) as ts.FunctionDeclaration
const SERVICES = MAIN.statements.find(
  (statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'initializeWindowServices'
) as ts.FunctionDeclaration

function declares(statement: ts.Statement, name: string): boolean {
  return (
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name
    )
  )
}

function grantStatement(statement: ts.Statement): boolean {
  if (ts.isIfStatement(statement))
    return ts.isIdentifier(statement.expression) && statement.expression.text === 'browserGrants'
  if (!ts.isExpressionStatement(statement)) return false
  const expression = statement.expression
  if (ts.isBinaryExpression(expression))
    return ts.isIdentifier(expression.left) && expression.left.text === 'browserGrants'
  return (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === 'browserGrants'
  )
}

function mainLifecycle() {
  assert.ok(WINDOW?.body)
  assert.ok(SERVICES?.body)
  assert.ok(
    WINDOW.body.statements.some(
      (statement) =>
        ts.isExpressionStatement(statement) &&
        ts.isAwaitExpression(statement.expression) &&
        ts.isCallExpression(statement.expression.expression) &&
        statement.expression.expression.expression.getText(MAIN) === 'initializeWindowServices'
    )
  )
  const branch = SERVICES.body.statements.find(
    (statement) =>
      ts.isIfStatement(statement) &&
      ts.isBlock(statement.thenStatement) &&
      statement.thenStatement.statements.some((child) => declares(child, 'grantOwners'))
  ) as ts.IfStatement
  assert.ok(branch && ts.isBlock(branch.thenStatement))
  const cleanup = WINDOW.body.statements
    .filter(grantStatement)
    .map((statement) => statement.getText(MAIN))
    .join('\n')
  const binding = branch.thenStatement.statements
    .filter(
      (statement) =>
        grantStatement(statement) ||
        ['grantRegistry', 'grantPolicy', 'grantOwners'].some((name) => declares(statement, name))
    )
    .map((statement) => statement.getText(MAIN))
    .join('\n')
  assert.ok(cleanup && binding)
  const compiled = ts.transpileModule(
    `let browserGrants = null;
    return (nextRegistry, browserPolicy) => {
      let nextBrowserHost = nextRegistry ? { agent: nextRegistry } : null;
      ${cleanup}
      if (${branch.expression.getText(MAIN)}) { ${binding} }
      return browserGrants;
    };`,
    { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }
  ).outputText
  let created = 0
  const open = new Function('createBrowserReadGrants', 'backend', compiled)(
    (owners: Parameters<typeof createBrowserReadGrants>[0]) => {
      created += 1
      return createBrowserReadGrants(owners)
    },
    { agentTransport: { activeScope: () => SCOPE } }
  ) as (
    nextRegistry: ReturnType<typeof registry> | null,
    policy: typeof POLICY | null
  ) => ReturnType<typeof createBrowserReadGrants> | null
  return { open, created: () => created }
}

const POLICY = {
  inspect: () => ({ revision: 1, decision: 'ask' as const }),
  revision: () => 1,
  effectiveDecision: () => 'ask' as const,
  agentUseEnabled: () => true,
}
function registry(instanceId: string) {
  const target = {
    instanceId,
    generation: 1,
    origin: 'https://example.org',
    url: 'https://example.org/',
  }
  return { agentTarget: () => target, agentNavigationTarget: () => target }
}

for (const action of ['read', 'navigate'] as const)
  for (const disposition of ['cancelled', 'consumed', 'expired'] as const) {
    test(`Main window recreation retains ${disposition} ${action} request tombstones and rebinds live targets`, () => {
      const lifecycle = mainLifecycle()
      const original = lifecycle.open(registry('first-window'), POLICY)!
      const request = {
        sessionId: SCOPE.sessionId,
        turnId: SCOPE.turnId,
        requestId: `${action}-${disposition}`,
        tabId: 'tab',
        intent: 'Read or open page',
      }
      const prepare = (owner: typeof original, requestId = request.requestId) =>
        action === 'read'
          ? owner.prepareRead({ ...request, requestId })
          : owner.prepareNavigate({ ...request, requestId, url: 'https://example.org/next' })
      if (action === 'read') {
        const proof = original.prepareRead(request)
        if (disposition === 'cancelled')
          original.cancelRead({ scope: SCOPE, requestId: proof.requestId, tabId: proof.tabId })
        if (disposition === 'consumed') {
          const grant = original.issueApproved({
            ...request,
            proofId: proof.proofId,
            expiresAt: proof.expiresAt,
            origin: proof.target.origin,
            targetInstanceId: proof.target.instanceId,
            targetGeneration: proof.target.generation,
          })
          original.consume(grant.id)
        }
      } else {
        const proof = original.prepareNavigate({ ...request, url: 'https://example.org/next' })
        if (disposition === 'cancelled')
          original.cancelNavigate({ scope: SCOPE, requestId: proof.requestId, tabId: proof.tabId })
        if (disposition === 'consumed') {
          const grant = original.issueNavigateApproved({
            ...proof,
            sessionId: SCOPE.sessionId,
            turnId: SCOPE.turnId,
            sourceInstanceId: proof.source.instanceId,
            sourceGeneration: proof.source.generation,
            sourceOrigin: proof.source.origin,
          })
          original.consumeNavigate(grant.id)
        }
      }
      const originalNow = Date.now
      if (disposition === 'expired') {
        const advanced = originalNow() + EXPIRED_PROOF_ADVANCE_MS
        Date.now = () => advanced
      }
      try {
        const reopened = lifecycle.open(registry('reopened-window'), POLICY)!
        assert.throws(() => prepare(reopened), /replayed_request/)
        assert.equal(reopened, original)
        assert.equal(lifecycle.created(), 1)
        const next = prepare(reopened, 'new-request')
        assert.equal(
          'target' in next ? next.target.instanceId : next.source.instanceId,
          'reopened-window'
        )
      } finally {
        Date.now = originalNow
      }
    })
  }

test('Main disabled composition never constructs grants at startup or on window recreation', () => {
  const lifecycle = mainLifecycle()
  assert.equal(lifecycle.open(null, null), null)
  assert.equal(lifecycle.open(registry('disabled-policy'), null), null)
  assert.equal(lifecycle.open(null, POLICY), null)
  assert.equal(lifecycle.open(null, null), null)
  assert.equal(lifecycle.created(), 0)
})

for (const action of ['read', 'navigate'] as const) {
  test(`disabled window recreation revokes pending ${action} authority without forgetting replay identity`, () => {
    const lifecycle = mainLifecycle()
    const grants = lifecycle.open(registry('first-window'), POLICY)!
    const request = {
      sessionId: SCOPE.sessionId,
      turnId: SCOPE.turnId,
      requestId: `pending-${action}`,
      tabId: 'tab',
      intent: 'Inspect page',
    }
    const prepare = () =>
      action === 'read'
        ? grants.prepareRead(request)
        : grants.prepareNavigate({ ...request, url: 'https://example.org/next' })
    const proof = prepare()
    const retained = () =>
      action === 'read'
        ? grants.readProof(proof.requestId, proof.proofId)
        : grants.navigateProof(proof.requestId, proof.proofId)
    assert.equal(retained().proofId, proof.proofId)
    assert.equal(lifecycle.open(null, null), grants)
    assert.throws(retained, /stale_grant/)
    assert.throws(prepare, /replayed_request/)
    assert.equal(lifecycle.created(), 1)
  })
}
