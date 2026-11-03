// Monotonic stage logs: no command arguments, environment values or secrets.
const { performance } = require('node:perf_hooks')
function startStage(stage) {
  const started = performance.now()
  console.log(`[stage] ${JSON.stringify({ stage, event: 'start' })}`)
  return (status = 'passed') => console.log(`[stage] ${JSON.stringify({
    stage, event: 'end', status, seconds: Number(((performance.now() - started) / 1000).toFixed(3))
  })}`)
}
function timed(stage, action) {
  const finish = startStage(stage)
  try { const result = action(); finish(); return result }
  catch (error) { finish('failed'); throw error }
}
async function timedAsync(stage, action) {
  const finish = startStage(stage)
  try { const result = await action(); finish(); return result }
  catch (error) { finish('failed'); throw error }
}
module.exports = { startStage, timed, timedAsync }
