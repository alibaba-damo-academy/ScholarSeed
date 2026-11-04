const assert = require('node:assert/strict')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')

function validateSourceRun(run, repository, runId) {
  assert.match(runId, /^[1-9]\d*$/, 'Expected a numeric source run ID')
  assert.equal(String(run.id), runId, 'Source run ID differs')
  assert.equal(run.repository?.full_name, repository, 'Source repository differs')
  assert.equal(run.head_repository?.full_name, repository, 'Fork builds cannot be published')
  assert.equal(run.path, '.github/workflows/signed-macos.yml', 'Expected the signed package workflow')
  assert.equal(run.head_branch, 'main', 'Source build must use main')
  assert.ok(['push', 'workflow_dispatch'].includes(run.event), 'Unexpected source event')
  assert.equal(run.status, 'completed', 'Source build has not completed')
  assert.equal(run.conclusion, 'success', 'Source build must have succeeded')
  assert.match(run.head_sha, /^[0-9a-f]{40}$/, 'Invalid source commit')
  return run.head_sha
}

module.exports = { validateSourceRun }
if (require.main === module) {
  try {
    const { SOURCE_RUN_ID: runId, GITHUB_REPOSITORY: repository, GITHUB_OUTPUT: output } = process.env
    assert.match(runId || '', /^[1-9]\d*$/, 'Expected a numeric source run ID')
    const run = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/actions/runs/${runId}`], { encoding: 'utf8' }))
    const commit = validateSourceRun(run, repository, runId)
    fs.appendFileSync(output, `commit=${commit}\n`)
    console.log(`Selected build ${runId} at ${commit}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
