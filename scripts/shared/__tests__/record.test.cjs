const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const child = require('node:child_process');
const test = require('node:test');
const recorder = require('../record.cjs');

function fixture(context, limits = {}, scope = ['FIXTURE-001']) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evaluation-record-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cli = path.join(directory, 'fixture.cjs');
  fs.writeFileSync(cli, "const fs=require('node:fs'); const mode=process.argv[2]; if(mode==='fail'){console.log('### Error\\nfixture failure');} else if(mode==='json-fail'||mode==='json-noise'){console.log(JSON.stringify({isError:true,error:'fixture failure'}));if(mode==='json-noise')console.error('fixture update notice');process.exitCode=1;} else if(mode==='snapshot' && fs.existsSync(__filename+'.inspection-error')){console.log('### Error\\nfixture inspection failure');} else if(mode==='wait'){setTimeout(()=>{},10000);} else if(mode==='evidence'){fs.writeFileSync(process.argv[3],'fixture evidence');console.log('### Result\\nfixture output');} else console.log('### Result\\n'+mode);");
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(cli)).digest('hex');
  const handoff = { task: 'fixture only, not product acceptance', authorization: 'unit test', scope, actions: [{ id: 'observe', ui: 1, description: 'fixture observation' }, { id: 'inspect', ui: 0, description: 'safe state inspection' }, { id: 'detach', ui: 0, description: 'detach fixture' }], forbidden: ['product access'], references: [{ locator: 'fixture', source: cli, sha256, fields: ['fixture'] }], stop: ['error'], cli: { path: cli, sha256 }, limits: { ui: 2, wallMs: 60000, commandMs: 1000, ...limits } };
  const filename = path.join(directory, 'input.json');
  fs.writeFileSync(filename, JSON.stringify(handoff));
  const run = path.join(directory, 'run');
  recorder.init(run, filename);
  return { directory, run, cli, filename, handoff };
}

test('new ordinary failures can each be corrected with evidence without resetting history', context => {
  const state = fixture(context, { ui: 8 });
  for (const reason of ['fresh observed state one', 'fresh observed state two']) {
    assert.throws(() => recorder.run(state.run, 'observe', ['fail']), /command_failed/);
    recorder.resume(state.run, reason);
  }
  const after = recorder.summary(state.run);
  assert.equal(after.stopped, false);
  assert.equal(after.cliCalls, 2);
  assert.equal(after.uiReserved, 2);
  assert.equal(after.events.filter(event => event.kind === 'correction-authorized').length, 2);
  assert.equal(after.commands.filter(command => command.status === 'failed').length, 2);
});

test('an explicitly cleared safety stop preserves failure and budget evidence', context => {
  const state = fixture(context, { ui: 8 });
  recorder.run(state.run, 'observe', ['success']);
  recorder.transition(state.run, 'halt', null, 'fixture risk');
  const stopped = recorder.summary(state.run);
  assert.equal(stopped.hardStopped, true);
  assert.throws(() => recorder.recover(state.run, ''), /evidence_required/);
  const recovered = recorder.recover(state.run, 'fixture risk resolved and process quiescent');
  assert.equal(recovered.hardStopped, false);
  assert.equal(recovered.cliCalls, stopped.cliCalls);
  assert.equal(recovered.uiReserved, stopped.uiReserved);
  assert.equal(recovered.executionQuality, 'blocked');
  assert.equal(recovered.events.filter(event => event.kind === 'hard-stop').length, 1);
  assert.equal(recovered.events.filter(event => event.kind === 'safety-cleared').length, 1);
});

test('safety recovery rejects exhausted budgets and identity drift', context => {
  const exhausted = fixture(context, { ui: 1 });
  recorder.run(exhausted.run, 'observe', ['success']);
  recorder.transition(exhausted.run, 'halt', null, 'fixture risk');
  assert.throws(() => recorder.recover(exhausted.run, 'risk resolved'), /budget_exhausted/);
  const drift = fixture(context);
  recorder.transition(drift.run, 'halt', null, 'fixture risk');
  fs.appendFileSync(drift.cli, '\n');
  assert.throws(() => recorder.recover(drift.run, 'risk resolved'), /source_mismatch|identity_mismatch/);
});

test('safety recovery refuses an unfinished subprocess', context => {
  const state = fixture(context);
  fs.appendFileSync(path.join(state.run, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind: 'step-start', sequence: 1, action: 'observe', ui: 1 }) + '\n');
  assert.throws(() => recorder.recover(state.run, 'state is uncertain'), /inflight_unresolved/);
  assert.equal(recorder.summary(state.run).hardStopped, true);
});

test('a skipped unit can be revisited without removing its earlier failure', context => {
  const state = fixture(context, { ui: 8 }, ['FIRST', 'SECOND']);
  recorder.transition(state.run, 'start', 'FIRST');
  assert.throws(() => recorder.run(state.run, 'observe', ['fail']), /command_failed/);
  recorder.run(state.run, 'inspect', ['snapshot']);
  recorder.transition(state.run, 'skip', 'SECOND', 'independent unit');
  const after = recorder.transition(state.run, 'start', 'FIRST');
  assert.equal(after.unit, 'FIRST');
  assert.deepEqual(after.skippedUnits, ['FIRST']);
  assert.equal(after.commands.filter(command => command.status === 'failed').length, 1);
});

test('handoff rejects duplicate scope identifiers before a run is created', context => {
  const state = fixture(context);
  state.handoff.scope = ['project-center', 'project-center'];
  fs.writeFileSync(state.filename, JSON.stringify(state.handoff));
  const duplicateRun = path.join(state.directory, 'duplicate');
  assert.throws(() => recorder.init(duplicateRun, state.filename), /duplicate_scope/);
  assert.equal(fs.existsSync(duplicateRun), false);
});

test('a fresh unit name mistake is recorded and can be corrected once without UI execution', context => {
  const state = fixture(context, { ui: 5 }, ['project-center', 'tabs']);
  recorder.transition(state.run, 'start', 'preparation');
  assert.throws(() => recorder.transition(state.run, 'start', '项目中心'), /unit_outside_scope/);
  const before = recorder.summary(state.run);
  assert.equal(before.hardStopped, false);
  assert.equal(before.stopped, true);
  assert.equal(before.cliCalls, 0);
  assert.equal(before.uiReserved, 0);
  assert.equal(before.events.find(event => event.error === 'unit_outside_scope').recoverable, true);
  recorder.resume(state.run, 'use the exact frozen unit ID');
  const after = recorder.transition(state.run, 'start', 'project-center');
  assert.equal(after.unit, 'project-center');
  assert.equal(after.cliCalls, 0);
  assert.equal(after.uiReserved, 0);
  assert.equal(after.events.filter(event => event.kind === 'correction-authorized').length, 1);
  assert.throws(() => recorder.resume(state.run, 'another correction'), /requires_completed_failure/);
});

test('a historical unmarked unit rejection remains a hard stop', context => {
  const state = fixture(context);
  fs.appendFileSync(path.join(state.run, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind: 'step-rejected', action: 'unit', error: 'unit_outside_scope' }) + '\n');
  assert.equal(recorder.summary(state.run).hardStopped, true);
  assert.throws(() => recorder.resume(state.run, 'must preserve history'), /requires_completed_failure|unsafe_rejection|hard_stop/);
});

test('unit name correction cannot bypass identity drift or exhausted UI budget', context => {
  const drift = fixture(context);
  fs.appendFileSync(drift.cli, '\n');
  assert.throws(() => recorder.transition(drift.run, 'start', 'unknown'), /cli_identity_mismatch|reference_source_mismatch/);
  assert.equal(recorder.summary(drift.run).hardStopped, true);
  const exhausted = fixture(context, { ui: 1 });
  recorder.run(exhausted.run, 'observe', ['success']);
  assert.throws(() => recorder.transition(exhausted.run, 'start', 'unknown'), /unit_outside_scope/);
  assert.equal(recorder.summary(exhausted.run).hardStopped, true);
});

test('unit and skip scope rejections are retained and stop later commands even when the caller ignores the exit', context => {
  for (const operation of ['start', 'skip']) {
    const state = fixture(context, { ui: 5 }, ['tabs', 'literature-list']);
    recorder.transition(state.run, 'start', 'tabs');
    assert.throws(() => recorder.run(state.run, 'observe', ['fail']), /command_failed/);
    recorder.resume(state.run, 'one ordinary locator correction');
    const before = recorder.summary(state.run);
    const args = [operation === 'start' ? 'unit' : 'skip', state.run, 'literature', ...(operation === 'skip' ? ['independent next page'] : [])];
    const rejected = child.spawnSync(process.execPath, [require.resolve('../record.cjs'), ...args], { encoding: 'utf8' });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /unit_outside_scope/);
    assert.match(rejected.stderr, /allowed units: \["tabs","literature-list"\]/);
    assert.throws(() => recorder.run(state.run, 'observe', ['success']), /stopped_or_budget_exhausted/);
    const after = recorder.summary(state.run);
    assert.equal(after.hardStopped, false);
    assert.equal(after.unit, 'tabs');
    assert.equal(after.cliCalls, before.cliCalls);
    assert.equal(after.uiReserved, before.uiReserved);
    assert.equal(after.startedAt, before.startedAt);
    assert.deepEqual(after.events.slice(0, before.events.length), before.events);
    const rejection = after.events.find(event => event.error === 'unit_outside_scope');
    assert.ok(Number.isFinite(Date.parse(rejection.at)));
    assert.equal(rejection.action, args[0]);
    assert.equal(rejection.unit, 'literature');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state.run, rejection.command))).argv, args);
    assert.match(fs.readFileSync(path.join(state.run, 'index.md'), 'utf8'), /unit_outside_scope/);
    recorder.resume(state.run, 'use the exact frozen unit identifier');
    assert.equal(recorder.summary(state.run).stopped, false);
    const detached = recorder.run(state.run, 'detach', ['detach']);
    assert.equal(detached.hardStopped, false);
    assert.equal(detached.cliCalls, before.cliCalls + 1);
  }
});

test('inspection output argument is rejected before CLI execution and can be corrected once', context => {
  for (const separate of [false, true]) {
    const state = fixture(context);
    const filename = path.join(state.run, 'raw', 'snapshot.yml');
    const args = ['-s=isolated', 'snapshot', ...(separate ? ['--filename', filename] : ['--filename=' + filename])];
    assert.throws(() => recorder.run(state.run, 'inspect', args), /inspection_output_argument_not_supported/);
    const before = recorder.summary(state.run);
    assert.equal(before.hardStopped, false);
    assert.equal(before.stopped, true);
    assert.equal(before.cliCalls, 0);
    assert.equal(before.uiReserved, 0);
    assert.equal(fs.existsSync(filename), false);
    const rejected = before.events.find(event => event.kind === 'step-rejected');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state.run, rejected.command))).argv, args);
    const resumed = recorder.resume(state.run, 'remove unsupported output argument; same isolated session');
    assert.equal(resumed.startedAt, before.startedAt);
    assert.equal(resumed.stopped, false);
    assert.equal(resumed.executionQuality, 'blocked');
    assert.equal(resumed.cliCalls, 0);
    assert.equal(resumed.uiReserved, 0);
    const after = recorder.run(state.run, 'inspect', ['-s=isolated', 'snapshot']);
    assert.equal(after.cliCalls, 1);
    assert.equal(after.events.filter(event => event.kind === 'step-rejected').length, 1);
    assert.equal(after.events.filter(event => event.kind === 'correction-authorized').length, 1);
    assert.throws(() => recorder.resume(state.run, 'second correction'), /requires_completed_failure/);
  }
});

test('a new parameter failure can be corrected after an earlier CLI correction', context => {
  const state = fixture(context, { ui: 4 });
  assert.throws(() => recorder.run(state.run, 'observe', ['fail']), /command_failed/);
  recorder.resume(state.run, 'first correction');
  assert.throws(() => recorder.run(state.run, 'inspect', ['snapshot', '--filename=' + path.join(state.run, 'evidence', 'snapshot.yml')]), /inspection_output_argument_not_supported/);
  recorder.resume(state.run, 'remove the unsupported output parameter');
  assert.equal(recorder.summary(state.run).events.filter(event => event.kind === 'correction-authorized').length, 2);
  assert.equal(recorder.summary(state.run).cliCalls, 1);
  assert.equal(recorder.summary(state.run).uiReserved, 1);
  assert.equal(recorder.summary(state.run).commands[0].status, 'failed');
});

test('only the narrow in-run inspection output mistake is recoverable', context => {
  const cases = [
    state => ['eval', 'secret'],
    state => ['snapshot', '--filename=' + path.join(state.directory, 'outside.yml')],
    state => ['snapshot', '--filename=' + path.join(state.run, 'handoff.json')],
    state => ['snapshot', '--filename=' + path.join(state.run, 'raw', 'snapshot.yml'), '--unknown'],
    state => ['tab-list', '--filename=' + path.join(state.run, 'raw', 'snapshot.yml')],
    state => ['-s=one', '-s=two', 'snapshot', '--filename=' + path.join(state.run, 'raw', 'snapshot.yml')],
  ];
  for (const args of cases) {
    const state = fixture(context);
    assert.throws(() => recorder.run(state.run, 'inspect', args(state)), /inspection_command_required/);
    assert.equal(recorder.summary(state.run).hardStopped, true);
    assert.equal(recorder.summary(state.run).cliCalls, 0);
    assert.throws(() => recorder.resume(state.run, 'must not recover'), /requires_completed_failure|unsafe_rejection|hard_stop/);
  }
});

test('inspection output correction cannot hide identity drift or exhausted budgets', context => {
  const drift = fixture(context);
  assert.throws(() => recorder.run(drift.run, 'inspect', ['snapshot', '--filename=' + path.join(drift.run, 'raw', 'snapshot.yml')]), /inspection_output_argument_not_supported/);
  fs.appendFileSync(drift.cli, '\n');
  assert.throws(() => recorder.resume(drift.run, 'correction'), /source_mismatch|identity_mismatch/);
  const exhausted = fixture(context, { ui: 1 });
  recorder.run(exhausted.run, 'observe', ['success']);
  assert.throws(() => recorder.run(exhausted.run, 'inspect', ['snapshot', '--filename=' + path.join(exhausted.run, 'raw', 'snapshot.yml')]), /inspection_output_argument_not_supported/);
  assert.throws(() => recorder.resume(exhausted.run, 'correction'), /budget_exhausted/);
  const expired = fixture(context, { wallMs: 1 });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  assert.throws(() => recorder.run(expired.run, 'inspect', ['snapshot', '--filename=' + path.join(expired.run, 'raw', 'snapshot.yml')]), /stopped_or_budget_exhausted/);
  assert.throws(() => recorder.resume(expired.run, 'correction'), /requires_completed_failure|budget_exhausted/);
});

test('skipping a rejected inspection requires a fresh successful inspection after that rejection', context => {
  for (const fresh of [false, true]) {
    const state = fixture(context, {}, ['FIRST', 'SECOND']);
    recorder.transition(state.run, 'start', 'FIRST');
    recorder.run(state.run, 'inspect', ['snapshot']);
    assert.throws(() => recorder.run(state.run, 'inspect', ['snapshot', '--filename=' + path.join(state.run, 'raw', 'snapshot.yml')]), /inspection_output_argument_not_supported/);
    if (!fresh) {
      assert.throws(() => recorder.transition(state.run, 'skip', 'SECOND', 'old inspection is insufficient'), /requires_inspection/);
      const after = recorder.summary(state.run);
      assert.equal(after.hardStopped, true);
      assert.deepEqual(after.skippedUnits, []);
      assert.equal(after.events.at(-1).error, 'skip_requires_inspection');
      assert.throws(() => recorder.run(state.run, 'inspect', ['snapshot']), /stopped_or_budget_exhausted/);
      continue;
    }
    recorder.run(state.run, 'inspect', ['snapshot']);
    recorder.transition(state.run, 'skip', 'SECOND', 'fresh inspection confirms safe independent next unit');
    const after = recorder.summary(state.run);
    assert.deepEqual(after.skippedUnits, ['FIRST']);
    assert.equal(after.hardStopped, false);
    assert.equal(after.events.filter(event => event.kind === 'step-rejected').length, 1);
    assert.equal(after.events.filter(event => event.kind === 'correction-authorized').length, 0);
  }
});

test('legacy inspection rejections remain hard stops without rewriting history', context => {
  const state = fixture(context);
  fs.appendFileSync(path.join(state.run, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind: 'step-rejected', action: 'inspect', error: 'inspection_command_required' }) + '\n');
  assert.equal(recorder.summary(state.run).hardStopped, true);
  assert.throws(() => recorder.resume(state.run, 'must not reclassify old failure'), /requires_completed_failure|unsafe_rejection|hard_stop/);
});

test('records actual subprocess output, evidence hashes and phase timing without manual index', context => {
  const state = fixture(context);
  recorder.phase(state.run, 'end', 'preparation');
  recorder.phase(state.run, 'begin', 'capture');
  assert.equal(recorder.summary(state.run).targetEvidenceObserved, false);
  assert.ok(recorder.summary(state.run).phases.find(phase => phase.phase === 'capture').startedAt);
  const evidence = path.join(state.run, 'evidence/screen.txt');
  recorder.run(state.run, 'observe', ['evidence', evidence]);
  recorder.observed(state.run, 'evidence/screen.txt');
  recorder.phase(state.run, 'end', 'capture');
  const result = recorder.summary(state.run);
  assert.equal(result.cliCalls, 1);
  assert.equal(result.recordedThrough, result.events.at(-1).at);
  assert.equal(result.elapsedMs, Date.parse(result.recordedThrough) - Date.parse(result.startedAt));
  assert.equal(result.commandMs, result.commands.reduce((total, command) => total + command.elapsedMs, 0));
  assert.ok(result.elapsedMs >= result.commandMs);
  assert.equal(result.targetEvidenceObserved, true);
  assert.equal('captureStarted' in result, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state.run, result.commands[0].command), 'utf8')).argv, ['evidence', evidence]);
  assert.equal(result.commands[0].exitCode, 0);
  assert.equal(result.commands[0].status, 'passed');
  assert.ok(result.commands[0].elapsedMs > 0);
  assert.equal(result.commands[0].evidence.length, 1);
  assert.match(fs.readFileSync(path.join(state.run, 'raw/001.txt'), 'utf8'), /fixture output/);
  assert.match(fs.readFileSync(path.join(state.run, 'index.md'), 'utf8'), /\.\/evidence\/screen.txt/);
  assert.ok(result.phases.every(phase => phase.endedAt && phase.elapsedMs >= 0));
  assert.throws(() => recorder.init(state.run, state.filename), /run_already_exists/);
});

test('CLI error with exit zero is retained and blocks dependent commands but permits exact detach', context => {
  const state = fixture(context);
  assert.throws(() => recorder.run(state.run, 'observe', ['fail']), /command_failed/);
  assert.equal(recorder.summary(state.run).commands[0].error, 'cli_reported_error');
  assert.throws(() => recorder.run(state.run, 'observe', ['success']), /stopped_or_budget/);
  assert.throws(() => recorder.run(state.run, 'detach', ['success']), /detach_command_required/);
  recorder.run(state.run, 'detach', ['detach']);
  assert.equal(recorder.summary(state.run).executionQuality, 'blocked');
});

test('ambiguous JSON CLI errors stay hard stopped with or without stderr notices', context => {
  for (const mode of ['json-fail', 'json-noise']) {
    const state = fixture(context);
    assert.throws(() => recorder.run(state.run, 'observe', [mode, '--json']), /command_failed/);
    const after = recorder.summary(state.run);
    assert.equal(after.commands[0].exitCode, 1);
    assert.equal(after.commands[0].error, null);
    assert.equal(after.hardStopped, true);
    assert.equal(after.stopped, true);
    assert.equal(after.cliCalls, 1);
    assert.equal(after.executionQuality, 'blocked');
    assert.match(fs.readFileSync(path.join(state.run, after.commands[0].output), 'utf8'), /"isError":true/);
    if (mode === 'json-noise') assert.match(fs.readFileSync(path.join(state.run, after.commands[0].output), 'utf8'), /fixture update notice/);
    assert.throws(() => recorder.resume(state.run, 'JSON does not establish safe recovery'), /hard_stop/);
  }
});

test('action and UI limits are enforced without executing unlisted or excess commands', context => {
  const state = fixture(context, { ui: 1 });
  const rejected = fixture(context);
  assert.throws(() => recorder.run(rejected.run, 'unlisted', ['success']), /action_not_in_handoff/);
  assert.equal(recorder.summary(rejected.run).executionQuality, 'blocked');
  assert.equal(recorder.summary(rejected.run).cliCalls, 0);
  recorder.run(state.run, 'observe', ['success']);
  assert.throws(() => recorder.run(state.run, 'observe', ['success']), /ui_budget/);
  assert.equal(recorder.summary(state.run).cliCalls, 1);
});

test('one authorized correction resumes without erasing failure, calls or budgets', context => {
  const state = fixture(context, { ui: 4 });
  assert.throws(() => recorder.resume(state.run, 'fixture correction'), /requires_completed_failure/);
  assert.throws(() => recorder.run(state.run, 'observe', ['fail']), /command_failed/);
  assert.throws(() => recorder.run(state.run, 'observe', ['success']), /stopped_or_budget/);
  assert.throws(() => recorder.resume(state.run, ''), /authorization_required/);
  const before = recorder.summary(state.run);
  const resumed = recorder.resume(state.run, 'authorized fixture-only minimal correction');
  assert.equal(resumed.startedAt, before.startedAt);
  assert.equal(resumed.cliCalls, before.cliCalls);
  assert.equal(resumed.uiReserved, before.uiReserved);
  assert.equal(resumed.executionQuality, 'blocked');
  assert.equal(resumed.stopped, false);
  recorder.run(state.run, 'observe', ['success']);
  assert.throws(() => recorder.resume(state.run, 'second correction'), /requires_completed_failure/);
  assert.throws(() => recorder.run(state.run, 'observe', ['fail']), /command_failed/);
  assert.throws(() => recorder.run(state.run, 'observe', ['success']), /stopped_or_budget/);
  assert.equal(recorder.summary(state.run).commands[0].status, 'failed');
  assert.equal(recorder.summary(state.run).cliCalls, 3);
});

test('correction cannot recover exhausted budgets, unsafe rejection or identity drift', context => {
  const exhausted = fixture(context, { ui: 1 });
  assert.throws(() => recorder.run(exhausted.run, 'observe', ['fail']), /command_failed/);
  assert.throws(() => recorder.resume(exhausted.run, 'correction'), /budget_exhausted/);
  const unsafe = fixture(context);
  assert.throws(() => recorder.run(unsafe.run, 'observe', ['fail']), /command_failed/);
  assert.throws(() => recorder.run(unsafe.run, 'unlisted', ['success']), /action_not_in_handoff/);
  assert.throws(() => recorder.resume(unsafe.run, 'correction'), /unsafe_rejection/);
  const drift = fixture(context);
  assert.throws(() => recorder.run(drift.run, 'observe', ['fail']), /command_failed/);
  fs.appendFileSync(drift.cli, '\n');
  assert.throws(() => recorder.resume(drift.run, 'correction'), /source_mismatch|identity_mismatch/);
});

test('a failed unit can be skipped only after inspection without erasing failure or resetting correction', context => {
  const state = fixture(context, { ui: 6 }, ['FIRST', 'SECOND', 'THIRD']);
  recorder.transition(state.run, 'start', 'FIRST');
  assert.throws(() => recorder.run(state.run, 'observe', ['fail']), /command_failed/);
  recorder.resume(state.run, 'one permitted correction');
  assert.throws(() => recorder.run(state.run, 'observe', ['fail']), /command_failed/);
  recorder.run(state.run, 'inspect', ['snapshot']);
  const before = recorder.summary(state.run);
  recorder.transition(state.run, 'skip', 'SECOND', 'instance and clean state checked; no dependency on FIRST');
  const after = recorder.run(state.run, 'observe', ['success']);
  assert.equal(after.cliCalls, before.cliCalls + 1);
  assert.equal(after.uiReserved, before.uiReserved + 1);
  assert.equal(after.startedAt, before.startedAt);
  assert.equal(after.executionQuality, 'blocked');
  assert.deepEqual(after.skippedUnits, ['FIRST']);
  assert.throws(() => recorder.resume(state.run, 'another correction'), /requires_completed_failure/);
  assert.throws(() => recorder.run(state.run, 'observe', ['fail']), /command_failed/);
  recorder.run(state.run, 'inspect', ['tab-list']);
  recorder.transition(state.run, 'skip', 'THIRD', 'safe state checked; third independent of failed pages');
  assert.equal(recorder.run(state.run, 'observe', ['success']).uiReserved, 5);
  assert.equal(recorder.summary(state.run).commands.filter(command => command.status === 'failed').length, 3);
  recorder.transition(state.run, 'start', 'FIRST');
  assert.equal(recorder.summary(state.run).hardStopped, false);
});

test('unit failure and skip safety validation rejections persist without restoring execution', context => {
  const cases = [
    { operation: 'start', error: 'unit_failure_unresolved' },
    { operation: 'skip', reason: 'safe independent page', error: 'skip_requires_inspection' },
    { operation: 'skip', error: 'skip_reason_required' },
  ];
  for (const entry of cases) {
    const state = fixture(context, {}, ['FIRST', 'SECOND']);
    recorder.transition(state.run, 'start', 'FIRST');
    assert.throws(() => recorder.run(state.run, 'observe', ['fail']), /command_failed/);
    const before = recorder.summary(state.run);
    assert.equal(before.hardStopped, false);
    assert.throws(() => recorder.transition(state.run, entry.operation, 'SECOND', entry.reason), new RegExp(entry.error));
    const after = recorder.summary(state.run);
    assert.equal(after.events.at(-1).error, entry.error);
    assert.equal(after.hardStopped, true);
    assert.equal(after.cliCalls, before.cliCalls);
    assert.equal(after.uiReserved, before.uiReserved);
    assert.equal(after.unit, 'FIRST');
    assert.throws(() => recorder.resume(state.run, 'cannot recover safety refusal'), /unsafe_rejection/);
    assert.throws(() => recorder.run(state.run, 'inspect', ['snapshot']), /stopped_or_budget_exhausted/);
  }
});

test('skip does not consume the single correction allowed later in an independent unit', context => {
  const state = fixture(context, { ui: 4 }, ['FIRST', 'SECOND']);
  recorder.transition(state.run, 'start', 'FIRST');
  assert.throws(() => recorder.run(state.run, 'observe', ['fail']), /command_failed/);
  recorder.run(state.run, 'inspect', ['snapshot']);
  recorder.transition(state.run, 'skip', 'SECOND', 'clean state and independent next page confirmed');
  assert.throws(() => recorder.run(state.run, 'observe', ['fail']), /command_failed/);
  recorder.resume(state.run, 'first correction, not reset by skip');
  const after = recorder.run(state.run, 'observe', ['success']);
  assert.equal(after.uiReserved, 3);
  assert.equal(after.events.filter(event => event.kind === 'correction-authorized').length, 1);
  assert.deepEqual(after.skippedUnits, ['FIRST']);
});

test('failed inspection leaves state unknown and cannot continue an independent unit', context => {
  const state = fixture(context, {}, ['FIRST', 'SECOND']);
  recorder.transition(state.run, 'start', 'FIRST');
  assert.throws(() => recorder.run(state.run, 'observe', ['fail']), /command_failed/);
  fs.writeFileSync(state.cli + '.inspection-error', 'fixture only');
  assert.throws(() => recorder.run(state.run, 'inspect', ['snapshot']), /command_failed/);
  assert.equal(recorder.summary(state.run).hardStopped, true);
  assert.throws(() => recorder.resume(state.run, 'cannot prove safe'), /hard_stop/);
  assert.throws(() => recorder.transition(state.run, 'skip', 'SECOND', 'cannot prove safe'), /hard_stop/);
  assert.equal(recorder.summary(state.run).events.at(-1).error, 'unit_hard_stop');
  assert.throws(() => recorder.resume(state.run, 'cannot ignore recorded refusal'), /unsafe_rejection/);
});

test('hard safety stop cannot be bypassed by inspection, skip, correction or unit selection', context => {
  const state = fixture(context, {}, ['FIRST', 'SECOND']);
  recorder.transition(state.run, 'start', 'FIRST');
  assert.throws(() => recorder.run(state.run, 'observe', ['fail']), /command_failed/);
  recorder.transition(state.run, 'halt', null, 'unknown identity or sensitive diagnostic');
  assert.equal(recorder.summary(state.run).hardStopped, true);
  assert.throws(() => recorder.resume(state.run, 'continue'), /hard_stop/);
  assert.throws(() => recorder.transition(state.run, 'skip', 'SECOND', 'continue'), /hard_stop/);
  assert.throws(() => recorder.transition(state.run, 'start', 'SECOND'), /hard_stop/);
  assert.throws(() => recorder.run(state.run, 'inspect', ['snapshot']), /stopped_or_budget/);
  assert.throws(() => recorder.resume(state.run, 'continue'), /unsafe_rejection/);
  recorder.run(state.run, 'detach', ['detach']);
  assert.equal(recorder.summary(state.run).hardStopped, true);
});

test('skip cannot bypass exhaustion, identity drift, unlisted units or unsafe inspection', context => {
  const exhausted = fixture(context, { ui: 1 }, ['FIRST', 'SECOND']);
  recorder.transition(exhausted.run, 'start', 'FIRST');
  assert.throws(() => recorder.run(exhausted.run, 'observe', ['fail']), /command_failed/);
  recorder.run(exhausted.run, 'inspect', ['snapshot']);
  assert.throws(() => recorder.transition(exhausted.run, 'skip', 'SECOND', 'safe'), /budget_exhausted/);
  const drift = fixture(context, {}, ['FIRST', 'SECOND']);
  recorder.transition(drift.run, 'start', 'FIRST');
  assert.throws(() => recorder.run(drift.run, 'observe', ['fail']), /command_failed/);
  recorder.run(drift.run, 'inspect', ['snapshot']);
  assert.throws(() => recorder.transition(drift.run, 'skip', 'UNKNOWN', 'safe'), /outside_scope/);
  fs.appendFileSync(drift.cli, '\n');
  assert.throws(() => recorder.transition(drift.run, 'skip', 'SECOND', 'safe'), /source_mismatch|identity_mismatch/);
  const unsafe = fixture(context, {}, ['FIRST', 'SECOND']);
  recorder.transition(unsafe.run, 'start', 'FIRST');
  assert.throws(() => recorder.run(unsafe.run, 'observe', ['fail']), /command_failed/);
  assert.throws(() => recorder.run(unsafe.run, 'inspect', ['eval', 'secret']), /inspection_command/);
  assert.equal(recorder.summary(unsafe.run).hardStopped, true);
  assert.throws(() => recorder.transition(unsafe.run, 'skip', 'SECOND', 'safe'), /hard_stop/);
});

test('timeout is recorded and script identity drift fails before another command', context => {
  const state = fixture(context, { commandMs: 30 });
  assert.throws(() => recorder.run(state.run, 'observe', ['wait']), /command_failed/);
  assert.equal(recorder.summary(state.run).commands[0].error, 'ETIMEDOUT');
  assert.equal(recorder.summary(state.run).hardStopped, true);
  assert.throws(() => recorder.resume(state.run, 'cannot assume timed-out process is safe'), /hard_stop/);
  fs.appendFileSync(state.cli, '\n');
  assert.throws(() => recorder.run(state.run, 'detach', ['detach']), /cli_identity/);
});

test('phase boundaries, single writer and evidence scope are explicit failures', context => {
  const state = fixture(context);
  assert.throws(() => recorder.phase(state.run, 'end', 'judge'), /phase_boundary/);
  assert.throws(() => recorder.phase(state.run, 'begin', 'preparation'), /phase_boundary/);
  assert.throws(() => recorder.observed(state.run, '../input.json'), /target_evidence_outside_run/);
  fs.writeFileSync(path.join(state.run, '.writer'), 'fixture');
  assert.throws(() => recorder.run(state.run, 'observe', ['success']), /EEXIST/);
  assert.equal(recorder.summary(state.run).cliCalls, 0);
});

test('observed evidence cannot escape the run through an ancestor link', context => {
  const state = fixture(context);
  const outside = path.join(state.directory, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'target.txt'), 'external fixture, not run evidence');
  fs.symlinkSync(outside, path.join(state.run, 'evidence', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => recorder.observed(state.run, 'evidence/linked/target.txt'), /target_evidence_outside_run/);
  assert.equal(recorder.summary(state.run).targetEvidenceObserved, false);
  const nested = path.join(state.run, 'evidence', 'nested');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'target.txt'), 'actual run fixture');
  recorder.observed(state.run, 'evidence/nested/target.txt');
  assert.equal(recorder.summary(state.run).targetEvidenceObserved, true);
});

test('missing handoff boundaries or mismatched source are rejected before run creation', context => {
  const state = fixture(context);
  for (const mutate of [handoff => { handoff.forbidden = []; }, handoff => { handoff.references[0].sha256 = 'wrong'; }]) {
    const input = JSON.parse(JSON.stringify(state.handoff));
    mutate(input);
    fs.writeFileSync(state.filename, JSON.stringify(input));
    const destination = path.join(state.directory, 'invalid');
    assert.throws(() => recorder.init(destination, state.filename));
    assert.equal(fs.existsSync(destination), false);
  }
});

test('verified action scripts cannot be replaced with guessed calls or edited after handoff', context => {
  const state = fixture(context);
  const handoffPath = path.join(state.run, 'handoff.json');
  const handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
  const script = path.join(state.directory, 'capture.js');
  fs.writeFileSync(script, 'async page => page.title()');
  handoff.actions[0].script = { path: script, sha256: crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex') };
  fs.writeFileSync(handoffPath, JSON.stringify(handoff));
  recorder.run(state.run, 'observe', ['run-code', '--filename', script]);
  assert.equal(recorder.summary(state.run).cliCalls, 1);
  recorder.run(state.run, 'observe', ['run-code', '--filename=' + script]);
  assert.equal(recorder.summary(state.run).cliCalls, 2);
  assert.throws(() => recorder.run(state.run, 'observe', ['run-code', 'guessed.get()']), /verified_script_required/);
  const stateAfterRejection = recorder.summary(state.run);
  assert.equal(stateAfterRejection.cliCalls, 2);
  assert.equal(stateAfterRejection.executionQuality, 'blocked');
  const rejection = stateAfterRejection.events.find(event => event.kind === 'step-rejected');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state.run, rejection.command), 'utf8')).argv, ['run-code', 'guessed.get()']);
  fs.appendFileSync(script, '\n');
  assert.throws(() => recorder.run(state.run, 'observe', ['run-code', '--filename', script]), /action_script_mismatch/);
});

test('frozen CLI callback is checked as an expression rather than a script statement', context => {
  const state = fixture(context);
  const script = path.join(state.directory, 'invalid.js');
  fs.writeFileSync(script, 'async page => page.title();');
  const handoff = JSON.parse(JSON.stringify(state.handoff));
  handoff.actions[0].script = { path: script, sha256: crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex') };
  fs.writeFileSync(state.filename, JSON.stringify(handoff));
  assert.throws(() => recorder.init(path.join(state.directory, 'invalid-run'), state.filename), /action_script_expression_invalid/);
  assert.equal(fs.existsSync(path.join(state.directory, 'invalid-run')), false);
});

test('expired wall budget stops before executing another command', context => {
  const state = fixture(context, { wallMs: 1 });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  assert.throws(() => recorder.run(state.run, 'observe', ['success']), /stopped_or_budget_exhausted/);
  assert.equal(recorder.summary(state.run).cliCalls, 0);
});

test('explicit time amendment preserves original handoff and does not reset UI or failure limits', context => {
  const state = fixture(context, { wallMs: 1, ui: 1 });
  assert.throws(() => recorder.budget(state.run, null, ''), /authorization_required/);
  recorder.budget(state.run, null, 'user explicitly removed overall time cap');
  assert.equal(JSON.parse(fs.readFileSync(path.join(state.run, 'handoff-before-budget-1.json'), 'utf8')).limits.wallMs, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state.run, 'handoff.json'), 'utf8')).limits.wallMs, null);
  recorder.run(state.run, 'observe', ['success']);
  assert.throws(() => recorder.run(state.run, 'observe', ['success']), /ui_budget/);
  recorder.budget(state.run, null, 'repeat time amendment does not clear errors');
  assert.equal(recorder.summary(state.run).executionQuality, 'blocked');
  assert.equal(recorder.summary(state.run).cliCalls, 1);
  assert.equal(recorder.summary(state.run).uiReserved, 1);
});

test('finish records actual later endpoints without inventing target evidence or reopening phases', context => {
  const state = fixture(context);
  recorder.phase(state.run, 'end', 'preparation');
  recorder.phase(state.run, 'begin', 'verification');
  recorder.phase(state.run, 'end', 'verification');
  const before = recorder.summary(state.run);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  const first = recorder.finish(state.run);
  assert.equal(first.events.at(-1).kind, 'record-finished');
  assert.equal(first.recordedThrough, first.events.at(-1).at);
  assert.ok(first.elapsedMs > before.elapsedMs);
  assert.equal(first.startedAt, before.startedAt);
  assert.equal(first.targetEvidenceObserved, false);
  assert.equal(first.cliCalls, 0);
  assert.equal(first.uiReserved, 0);
  assert.equal(first.executionQuality, 'requires-independent-review');
  assert.deepEqual(first.phases, before.phases);
  assert.throws(() => recorder.phase(state.run, 'begin', 'verification'), /phase_boundary_conflict/);
  fs.writeFileSync(path.join(state.run, 'report.md'), 'later fixture report, not target evidence');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  const second = recorder.finish(state.run);
  assert.ok(second.elapsedMs > first.elapsedMs);
  assert.equal(second.events.filter(event => event.kind === 'record-finished').length, 2);
  assert.deepEqual(second.events.slice(0, first.events.length), first.events);
  assert.equal(second.targetEvidenceObserved, false);
  assert.deepEqual(second.commands, before.commands);
  assert.match(fs.readFileSync(path.join(state.run, 'index.md'), 'utf8'), new RegExp(second.recordedThrough));
  assert.equal(JSON.parse(fs.readFileSync(path.join(state.run, 'record.json'))).recordedThrough, second.recordedThrough);
});

test('finish refuses unclosed phases, incomplete commands and another writer without adding an endpoint', context => {
  const state = fixture(context);
  const before = recorder.summary(state.run);
  assert.throws(() => recorder.finish(state.run), /finish_requires_closed_phases/);
  assert.deepEqual(recorder.summary(state.run).events, before.events);
  recorder.phase(state.run, 'end', 'preparation');
  fs.writeFileSync(path.join(state.run, '.writer'), 'fixture writer');
  assert.throws(() => recorder.finish(state.run), /EEXIST/);
  fs.unlinkSync(path.join(state.run, '.writer'));
  fs.appendFileSync(path.join(state.run, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind: 'step-start', sequence: 1, action: 'inspect', ui: 0 }) + '\n');
  assert.throws(() => recorder.finish(state.run), /finish_requires_completed_commands/);
  const after = recorder.summary(state.run);
  assert.equal(after.events.some(event => event.kind === 'record-finished'), false);
  assert.equal(after.hardStopped, true);
  assert.equal(fs.existsSync(path.join(state.run, '.writer')), false);
});

test('finish preserves failures, hard stops, correction history and frozen budgets', context => {
  for (const hardStop of [false, true]) {
    const state = fixture(context, { ui: 4 });
    recorder.phase(state.run, 'end', 'preparation');
    assert.throws(() => recorder.run(state.run, 'observe', ['fail']), /command_failed/);
    if (hardStop) {
      recorder.resume(state.run, 'fixture correction remains consumed');
      recorder.transition(state.run, 'halt', null, 'fixture unknown safety state');
    }
    const before = recorder.summary(state.run);
    const handoff = fs.readFileSync(path.join(state.run, 'handoff.json'));
    const after = recorder.finish(state.run);
    assert.equal(after.stopped, true);
    assert.equal(after.hardStopped, hardStop);
    assert.equal(after.executionQuality, 'blocked');
    assert.equal(after.targetEvidenceObserved, before.targetEvidenceObserved);
    assert.equal(after.cliCalls, before.cliCalls);
    assert.equal(after.uiReserved, before.uiReserved);
    assert.deepEqual(after.commands, before.commands);
    assert.deepEqual(after.events.slice(0, before.events.length), before.events);
    assert.deepEqual(fs.readFileSync(path.join(state.run, 'handoff.json')), handoff);
    assert.throws(() => recorder.run(state.run, 'observe', ['success']), /stopped_or_budget/);
  }
});

test('finish CLI retains the existing output shape and does not invoke the UI CLI', context => {
  const state = fixture(context);
  recorder.phase(state.run, 'end', 'preparation');
  const result = child.spawnSync(process.execPath, [require.resolve('../record.cjs'), 'finish', state.run], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { directory: path.resolve(state.run), cliCalls: 0, uiReserved: 0, targetEvidenceObserved: false, executionQuality: 'requires-independent-review' });
  const after = recorder.summary(state.run);
  assert.equal(after.events.at(-1).kind, 'record-finished');
  assert.equal(after.commands.length, 0);
});
