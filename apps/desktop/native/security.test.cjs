const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const vectors = require('./security.test.json')
const principals = require('./principals.test.json')
const { lowerPolicy } = require('../scripts/shared/policy.cjs')
const policy = require('./security.json')
test('ACL generated artifacts match the single decision IR', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, '../scripts/pre/security.cjs'), '--check'],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)
})
test(
  'C ACL kernel satisfies the independent shared oracle',
  { skip: process.platform === 'win32' },
  (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-kernel-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const fields = [
      'principal',
      'mask',
      'flags',
      'deny',
      'trusted',
      'universal',
      'allow_subject',
      'deny_subject',
    ]
    const authorities = principals
      .map(
        (v, i) => `{
  const unsigned char principal[] = {${[...Buffer.from(v.principal_hex, 'hex')].join(',') || '0'}};
  const unsigned char user[] = {${[...Buffer.from(v.user_hex, 'hex')].join(',') || '0'}};
  if(sc_authority(principal,${v.principal_hex.length / 2},user,${v.user_hex.length / 2}) != ${Number(v.trusted)}) {fprintf(stderr,"authority ${i}\\n");return 3;}
 }`
      )
      .join('\n')
    const bodies = vectors
      .map(
        (v, i) => `{
  ${v.owner ? `if(sc_owner(${v.role},${Number(v.owner.trusted)})!=${Number(v.owner.allowed)}) return 2;` : ''}
  struct sc_entry entries[] = {${v.entries.map((e) => '{' + fields.map((k) => Number(e[k] || 0)).join(',') + '}').join(',')}};
  struct sc_result r=sc_evaluate(entries,${v.entries.length},${v.role},${Number(v.execution)});
  if(r.reason!=${v.expected.reason}||r.index!=${v.expected.index}||r.mask!=${v.expected.mask}||r.scope!=${v.expected.scope}) {fprintf(stderr,"vector ${i}: %d %d %u %d\\n",r.reason,r.index,r.mask,r.scope);return 1;}
 }`
      )
      .join('\n')
    fs.writeFileSync(
      path.join(directory, 'test.c'),
      '#include <stdio.h>\n#include "security.h"\nint main(void) {\n' +
        authorities +
        bodies +
        'return 0;}\n'
    )
    const output = path.join(directory, 'test')
    const build = spawnSync(
      'cc',
      [
        '-std=c11',
        '-Wall',
        '-Werror',
        '-I',
        __dirname,
        path.join(directory, 'test.c'),
        '-o',
        output,
      ],
      { encoding: 'utf8' }
    )
    assert.equal(build.status, 0, build.stderr)
    const result = spawnSync(output, [], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
)

test('readable policy preserves typed parameter order and named role references', () => {
  const owner = lowerPolicy(policy).functions.find((fn) => fn.name === 'owner')
  assert.deepEqual(owner.args, [
    ['role', 'int'],
    ['trusted', 'bool'],
  ])
  assert.deepEqual(owner.body, [['return', ['bin', '||', 'trusted', ['bin', '==', 'role', 2]]]])
})
test('readable policy rejects ambiguous or unsupported source instead of guessing', () => {
  const cases = [
    [
      'unknown reference',
      (p) => (p.functions[0].body = [{ return: '@roles.volum' }]),
      /unknown ACL policy reference/,
    ],
    [
      'unbounded right',
      (p) => (p.rights.read_execute.value = '0x100000000'),
      /invalid ACL policy literal/,
    ],
    [
      'unknown expression',
      (p) => (p.functions[0].body = [{ return: ['evaluate_text', 'anything'] }]),
      /unknown ACL expression/,
    ],
    [
      'operator arity',
      (p) => (p.functions[0].body = [{ return: ['||', true] }]),
      /requires two operands/,
    ],
    [
      'unknown statement field',
      (p) => (p.functions[0].body = [{ return: true, otherwise: false }]),
      /invalid ACL statement fields/,
    ],
    [
      'missing block',
      (p) => (p.functions[0].body = [{ if: true }]),
      /invalid ACL statement fields/,
    ],
    ['invalid parameter', (p) => (p.functions[0].args[0].type = 'any'), /invalid ACL parameter/],
    ['old schema', (p) => (p.schema = 1), /unsupported ACL policy schema/],
  ]
  for (const [name, mutate, error] of cases) {
    const input = structuredClone(policy)
    mutate(input)
    assert.throws(() => lowerPolicy(input), error, name)
  }
})

test('lease tooling uses the shared named profiles without widening grants', () => {
  const { LEASE_STATE, LEASE_GRANT } = require('../../../scripts/shared/security.cjs')
  const rows = require('./profiles.test.json')
  for (const row of rows.filter((row) => ['lease_state', 'lease_grant'].includes(row.profile))) {
    const members = row.profile === 'lease_state' ? LEASE_STATE : LEASE_GRANT
    assert.equal(
      members.some((sid) => row.principal === (sid === '$user' ? row.user : sid)),
      row.trusted
    )
  }
})
test('coordination descriptor keeps the exact prior minimal rights', () => {
  const { compilePrincipals } = require('../scripts/shared/principals.cjs')
  const lowered = lowerPolicy(policy)
  const compiled = compilePrincipals(lowered, (s) =>
    s
      .split('_')
      .map((p) => p[0].toUpperCase() + p.slice(1))
      .join('')
  )
  assert.equal(
    compiled.descriptor,
    'D:P(A;;0x00120001;;;AU)(A;;0x001f0001;;;SY)(A;;0x001f0001;;;BA)'
  )
})
test('tooling rejection logs one safe event while retaining the exception', (t) => {
  const { recordDenial } = require('../../../scripts/shared/security.cjs')
  const events = []
  let unavailable = true
  t.mock.method(console, 'error', (raw) => {
    if (unavailable) throw Error('sink failed')
    events.push(JSON.parse(raw))
  })
  const error = new Error('credential-secret S-1-5-21-private')
  error.code = 'EACCES'
  recordDenial(error, 'lease_state', 'inspect', 'C:/secret/profile')
  const incident = error.permissionIncidentId
  unavailable = false
  recordDenial(error, 'lease_state', 'inspect', 'C:/secret/profile')
  recordDenial(error, 'lease_state', 'inspect', 'C:/secret/profile')
  assert.equal(events.length, 1)
  assert.equal(events[0].correlation_id, incident)
  assert.equal(events[0].reason, 'os_access_denied')
  assert.equal(JSON.stringify(events).includes('credential-secret'), false)
  assert.equal(JSON.stringify(events).includes('S-1-5-21-private'), false)
  assert.equal(JSON.stringify(events).includes('C:/secret/profile'), false)
  assert.equal(error.message, 'credential-secret S-1-5-21-private')
})

test('tooling preserves native privilege and cancellation categories', t => {
  const { recordDenial } = require('../../../scripts/shared/security.cjs')
  const events=[]
  t.mock.method(console,'error',raw=>events.push(JSON.parse(raw)))
  for(const systemCode of [1223,1314]) {
    const error=new Error('hidden native details')
    error.systemCode=systemCode
    recordDenial(error,'lease_grant','grant','C:/secret/profile')
  }
  assert.deepEqual(events.map(event=>event.reason),['authorization_cancelled','privilege_not_held'])
})
