import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import {
  assertTerminalSignatureIdentity,
  inspectTerminalRecovery,
  inspectOrphanRecovery,
  RecoveryInspectionError,
} from './terminal.ts'
import { updateLaunchDirectory } from './relaunch.ts'

const macosTest = process.platform === 'darwin' ? test : test.skip

macosTest('orphan inspection maps missing context to a typed record refusal', async (context) => {
  const current = fixture(context)
  rmSync(current.contextPath)
  await assert.rejects(
    inspectOrphanRecovery(current.options, current.dependencies),
    (error) => error instanceof RecoveryInspectionError && error.code === 'unsafe_record'
  )
})

function fixture(context: test.TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'terminal-inspection-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const application = join(root, 'ScholarSeed.app')
  const source = join(root, 'candidate', 'ScholarSeed.app')
  const coordinator = join(root, 'coordination')
  const home = join(root, 'home')
  const userData = join(root, 'profile')
  const workspace = join(root, 'projects')
  for (const directory of [
    join(application, 'Contents', 'Resources'),
    join(source, 'Contents'),
    coordinator,
    home,
    userData,
    workspace,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  const uid = process.getuid!()
  const binding = {
    schema: 1,
    candidate: 'candidate-terminal',
    requestId: 'a'.repeat(64),
    sha512: 'b'.repeat(128),
    size: 1234,
  }
  const capture = (path: string) => {
    const identity = (value: string) => {
      const metadata = statSync(value)
      return { dev: metadata.dev, ino: metadata.ino, uid: metadata.uid }
    }
    return { path, parent: identity(dirname(path)), item: identity(path) }
  }
  const contextPath = join(updateLaunchDirectory(coordinator, application), 'context.json')
  const handoff = join(home, 'updates', 'squirrel.json')
  const selection = {
    schema: 2,
    uid,
    application,
    bundleId: 'com.scholarseed.desktop',
    sourceBuild: '202611031043',
    targetBuild: '202611031329',
    candidate: binding.candidate,
    at: 1,
    home,
    userData,
    workspace,
    identities: Array(3).fill(
      `darwin:${'a'.repeat(32)}:${'b'.repeat(16)}:${'c'.repeat(16)}:${'d'.repeat(8)}`
    ),
  }
  const nativeRequest = { source: capture(source), target: capture(application), binding }
  const record = {
    version: '0.3.1',
    buildNumber: selection.targetBuild,
    candidate: binding.candidate,
    at: 1,
    state: 'installing',
    binding,
    nativeRequest,
  }
  const product = {
    product_id: 'scholarseed',
    bundle_id: selection.bundleId,
    build_number: selection.sourceBuild,
    expected_team_id: 'KYG3VP6NVH',
    release_lane: 'distribution',
  }
  mkdirSync(dirname(contextPath), { recursive: true, mode: 0o700 })
  mkdirSync(dirname(handoff), { recursive: true, mode: 0o700 })
  const productPath = join(application, 'Contents', 'Resources', 'product.json')
  writeFileSync(contextPath, JSON.stringify(selection), { mode: 0o600 })
  writeFileSync(handoff, JSON.stringify(record), { mode: 0o600 })
  writeFileSync(productPath, JSON.stringify(product))
  const options = {
    application,
    coordinator,
    handoff,
    nativeState: join(root, 'ShipItState.plist'),
    preparation: join(root, 'CandidatePreparation'),
    cleanup: join(root, 'DeferredCleanup'),
    toolDirectory: join(root, 'tool'),
    expectedTeam: product.expected_team_id,
  }
  let probes = 0
  let signatureChecks = 0
  const proof = {
    kind: 'terminal-failure-observation',
    bundleIdentifier: selection.bundleId,
    selection: { schema: selection.schema, sha256: 'f'.repeat(64) },
    binding,
    code: 60,
    source: { ...nativeRequest.source, contents: capture(source).item },
    target: { ...nativeRequest.target, contents: capture(application).item },
    journal: { sha256: 'c'.repeat(64) },
    ack: { sha256: 'd'.repeat(64) },
    state: { sha256: 'e'.repeat(64) },
  }
  const dependencies = {
    platform: 'darwin' as NodeJS.Platform,
    uid,
    verifyApplication: async () => {
      signatureChecks++
    },
    probe: async () => {
      probes++
      return proof
    },
  }
  return {
    root,
    contextPath,
    handoff,
    productPath,
    selection,
    record,
    proof,
    options,
    dependencies,
    counts: () => ({ probes, signatureChecks }),
  }
}

macosTest(
  'terminal inspection validates one failed transaction and never grants mutation authority',
  async (context) => {
    const current = fixture(context)
    const before = [current.contextPath, current.handoff].map((path) => readFileSync(path))
    const result = await inspectTerminalRecovery(current.options, current.dependencies)
    assert.equal(result.mode, 'inspect')
    assert.equal(result.outcome, 'terminal_failure_verified')
    assert.deepEqual(result.transaction, {
      sourceBuild: '202611031043',
      targetBuild: '202611031329',
      candidate: current.selection.candidate,
    })
    assert.equal(result.failureCode, 60)
    assert.equal(
      result.records.context.sha256,
      createHash('sha256').update(before[0]).digest('hex')
    )
    assert.equal(result.mutationPerformed, false)
    assert.equal(result.executionAuthority, false)
    assert.deepEqual(
      [current.contextPath, current.handoff].map((path) => readFileSync(path)),
      before
    )
    assert.deepEqual(current.counts(), { probes: 1, signatureChecks: 1 })
  }
)

test('unsupported platforms refuse before any filesystem or native operation', async () => {
  const dependencies = {
    platform: 'win32' as NodeJS.Platform,
    uid: -1,
    verifyApplication: async () => {
      throw new Error('must not verify')
    },
    probe: async () => {
      throw new Error('must not probe')
    },
  }
  await assert.rejects(
    inspectTerminalRecovery({} as never, dependencies),
    (error) => error instanceof RecoveryInspectionError && error.code === 'unsupported_platform'
  )
})

macosTest(
  'handoff candidate or native binding mismatch refuses before probing',
  async (context) => {
    for (const field of ['candidate', 'binding'] as const) {
      const current = fixture(context)
      const changed =
        field === 'candidate'
          ? { ...current.record, candidate: 'another' }
          : {
              ...current.record,
              nativeRequest: {
                ...current.record.nativeRequest,
                binding: { ...current.record.binding, requestId: 'f'.repeat(64) },
              },
            }
      writeFileSync(current.handoff, JSON.stringify(changed))
      await assert.rejects(inspectTerminalRecovery(current.options, current.dependencies))
      assert.equal(current.counts().probes, 0)
    }
  }
)

macosTest('a changed installed build cannot be treated as the failed source', async (context) => {
  const current = fixture(context)
  const product = JSON.parse(readFileSync(current.productPath, 'utf8'))
  writeFileSync(current.productPath, JSON.stringify({ ...product, build_number: '202611031427' }))
  await assert.rejects(
    inspectTerminalRecovery(current.options, current.dependencies),
    (error) => error instanceof RecoveryInspectionError && error.code === 'source_identity_differs'
  )
  assert.equal(current.counts().probes, 0)
})

macosTest(
  'unsafe record permissions and symlinks are refused without native operations',
  async (context) => {
    const unsafe = fixture(context)
    chmodSync(unsafe.contextPath, 0o666)
    await assert.rejects(inspectTerminalRecovery(unsafe.options, unsafe.dependencies))
    assert.equal(unsafe.counts().probes, 0)
    const linked = fixture(context)
    const original = linked.handoff + '.original'
    renameSync(linked.handoff, original)
    symlinkSync(original, linked.handoff)
    await assert.rejects(inspectTerminalRecovery(linked.options, linked.dependencies))
    assert.equal(linked.counts().probes, 0)
  }
)

macosTest(
  'a record inode replacement during the probe invalidates even identical bytes',
  async (context) => {
    const current = fixture(context)
    current.dependencies.probe = async () => {
      const replacement = current.contextPath + '.replacement'
      writeFileSync(replacement, readFileSync(current.contextPath), { mode: 0o600 })
      renameSync(replacement, current.contextPath)
      return current.proof
    }
    await assert.rejects(
      inspectTerminalRecovery(current.options, current.dependencies),
      (error) => error instanceof RecoveryInspectionError && error.code === 'evidence_changed'
    )
  }
)

macosTest(
  'native proof cannot substitute another binding, target or nonfailure code',
  async (context) => {
    for (const changed of [
      { code: 0 },
      { code: true },
      { binding: { requestId: 'f'.repeat(64) } },
      { target: { path: resolve('/different/application.app') } },
      { bundleIdentifier: 'com.different.application' },
      { selection: undefined },
      { selection: { schema: 1, sha256: 'f'.repeat(64) } },
      { selection: { schema: 2, sha256: true } },
      { source: { contents: { dev: true, ino: 1, uid: 1 } } },
    ]) {
      const current = fixture(context)
      current.dependencies.probe = async () =>
        ({ ...current.proof, ...changed }) as typeof current.proof
      await assert.rejects(
        inspectTerminalRecovery(current.options, current.dependencies),
        (error) =>
          error instanceof RecoveryInspectionError && error.code === 'native_evidence_differs'
      )
    }
  }
)

test('source signature reuses the complete offline Developer ID policy', () => {
  const valid = [
    'Identifier=com.scholarseed.desktop',
    'TeamIdentifier=KYG3VP6NVH',
    'Authority=Developer ID Application: Trusted Developer (KYG3VP6NVH)',
    'Authority=Developer ID Certification Authority',
    'Authority=Apple Root CA',
    'CodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=1+1 location=embedded',
    'Timestamp=Nov 3, 2026 at 10:43:00 AM',
  ].join('\n')
  assert.doesNotThrow(() =>
    assertTerminalSignatureIdentity(
      valid.replaceAll('\n', '\r\n'),
      'com.scholarseed.desktop',
      'KYG3VP6NVH'
    )
  )
  for (const refused of [
    valid.replace('Developer ID Application:', 'Untrusted Application:'),
    valid.replace('Authority=Apple Root CA', ''),
    valid.replace('Authority=Developer ID Certification Authority', ''),
    valid.replace('TeamIdentifier=KYG3VP6NVH', 'TeamIdentifier=not set'),
    valid.replace('flags=0x10000(runtime)', 'flags=0x0(none)'),
    valid.replace('Timestamp=Nov 3, 2026 at 10:43:00 AM', 'Timestamp=none'),
    valid.replace('Identifier=com.scholarseed.desktop', 'Identifier=com.different.application'),
  ]) {
    assert.throws(
      () => assertTerminalSignatureIdentity(refused, 'com.scholarseed.desktop', 'KYG3VP6NVH'),
      (error) => error instanceof RecoveryInspectionError && error.code === 'signature_refused'
    )
  }
})

macosTest('signature or native refusal retains original records', async (context) => {
  const current = fixture(context)
  const before = readFileSync(current.contextPath)
  current.dependencies.verifyApplication = async () => {
    throw new Error('sensitive signer failure')
  }
  await assert.rejects(
    inspectTerminalRecovery(current.options, current.dependencies),
    (error) => error instanceof RecoveryInspectionError && !error.message.includes('sensitive')
  )
  assert.deepEqual(readFileSync(current.contextPath), before)
  assert.equal(current.counts().probes, 0)
})
