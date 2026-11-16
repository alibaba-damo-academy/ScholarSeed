const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const child = require('node:child_process');
const { Script } = require('node:vm');

const PHASES = ['preparation', 'capture', 'judge', 'report', 'verification'];
const FILES = { handoff: 'handoff.json', events: 'events.jsonl', record: 'record.json', index: 'index.md', lock: '.writer' };
const UNIT_EVENTS = { start: 'unit-start', skip: 'unit-skipped', halt: 'hard-stop' };
const FINISH_EVENT = 'record-finished';
const INSPECTIONS = ['snapshot', 'tab-list'];
const INSPECTION_OUTPUT_ERROR = 'inspection_output_argument_not_supported';
const NONFATAL_REJECTIONS = new Set(['stopped_or_budget_exhausted', INSPECTION_OUTPUT_ERROR]);
const UNIT_SCOPE_ERROR = 'unit_outside_scope';
const INSPECTION_OUTPUT_DIRECTORIES = ['raw', 'evidence'];
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const nonfatalRejection = event => NONFATAL_REJECTIONS.has(event.error) || (event.error === UNIT_SCOPE_ERROR && ['unit', 'skip'].includes(event.action) && event.recoverable === true);

function inspectionOutputMistake(directory, action, args) {
  const sessions = args.filter(argument => argument.startsWith('-s='));
  const command = args.filter(argument => !argument.startsWith('-s='));
  if (action.ui !== 0 || sessions.length > 1 || sessions.some(argument => argument === '-s=') || command[0] !== 'snapshot') return false;
  const filename = command.length === 2 && command[1].startsWith('--filename=') ? command[1].slice('--filename='.length) : command.length === 3 && command[1] === '--filename' ? command[2] : null;
  if (!nonempty(filename)) return false;
  const relative = path.relative(path.resolve(directory), path.resolve(filename));
  return !path.isAbsolute(relative) && INSPECTION_OUTPUT_DIRECTORIES.includes(relative.split(path.sep)[0]);
}

function verifyScript(script) {
  requireValue(path.isAbsolute(script.path) && digest(script.path) === script.sha256, 'action_script_mismatch');
  try { new Script('(' + fs.readFileSync(script.path, 'utf8') + '\n)'); } catch { throw new Error('action_script_expression_invalid'); }
}

function validate(handoff) {
  for (const key of ['task', 'authorization']) requireValue(nonempty(handoff[key]), `missing_${key}`);
  for (const key of ['scope', 'actions', 'forbidden', 'references', 'stop']) requireValue(Array.isArray(handoff[key]) && handoff[key].length > 0, `missing_${key}`);
  requireValue(handoff.scope.every(nonempty) && handoff.forbidden.every(nonempty) && handoff.stop.every(nonempty), 'invalid_boundaries');
  requireValue(new Set(handoff.scope).size === handoff.scope.length, 'duplicate_scope');
  const identifiers = new Set();
  for (const action of handoff.actions) {
    requireValue(nonempty(action.id) && nonempty(action.description) && Number.isInteger(action.ui) && action.ui >= 0 && !identifiers.has(action.id), 'invalid_action');
    if (action.script) verifyScript(action.script);
    identifiers.add(action.id);
  }
  requireValue(identifiers.has('detach'), 'detach_required');
  for (const reference of handoff.references) {
    requireValue(nonempty(reference.locator) && Array.isArray(reference.fields) && reference.fields.length > 0 && reference.fields.every(nonempty), 'invalid_reference');
    requireValue(path.isAbsolute(reference.source) && nonempty(reference.sha256) && digest(reference.source) === reference.sha256, 'reference_source_mismatch');
  }
  requireValue(path.isAbsolute(handoff.cli.path) && digest(handoff.cli.path) === handoff.cli.sha256, 'cli_identity_mismatch');
  for (const key of ['commandMs', 'ui']) requireValue(Number.isSafeInteger(handoff.limits[key]) && handoff.limits[key] > 0, `invalid_limit_${key}`);
  requireValue(handoff.limits.wallMs === null || (Number.isSafeInteger(handoff.limits.wallMs) && handoff.limits.wallMs > 0), 'invalid_limit_wallMs');
}

function eventsAt(directory) {
  return fs.readFileSync(path.join(directory, FILES.events), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function append(directory, event) {
  fs.appendFileSync(path.join(directory, FILES.events), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
}

function summary(directory) {
  const events = eventsAt(directory);
  const starts = events.filter(event => event.kind === 'step-start');
  const phases = PHASES.flatMap(phase => {
    const begin = events.find(event => event.kind === 'phase-start' && event.phase === phase);
    if (!begin) return [];
    const end = events.find(event => event.kind === 'phase-end' && event.phase === phase);
    return [{ phase, startedAt: begin.at, endedAt: end?.at ?? null, elapsedMs: end ? Date.parse(end.at) - Date.parse(begin.at) : null }];
  });
  const commands = starts.map(start => {
    const end = events.find(event => event.kind === 'step-end' && event.sequence === start.sequence);
    return { ...start, endedAt: end?.at ?? null, elapsedMs: end?.elapsedMs ?? null, status: end?.status ?? 'incomplete', output: end?.output ?? null, error: end?.error ?? null, exitCode: end?.exitCode ?? null, signal: end?.signal ?? null, evidence: end?.evidence ?? [] };
  });
  const rejected = events.filter(event => event.kind === 'step-rejected');
  const failed = commands.some(command => command.status !== 'passed') || rejected.length > 0 || events.some(event => event.kind === UNIT_EVENTS.halt);
  const safetyIndex = events.findLastIndex(event => event.kind === 'safety-cleared');
  const activeEvents = events.slice(safetyIndex + 1);
  const activeSequences = new Set(activeEvents.filter(event => event.kind === 'step-start').map(event => event.sequence));
  const recoveryIndex = events.findLastIndex(event => event.kind === 'correction-authorized' || event.kind === UNIT_EVENTS.skip || event.kind === 'safety-cleared');
  const hardStopped = activeEvents.some(event => event.kind === UNIT_EVENTS.halt || (event.kind === 'step-rejected' && !nonfatalRejection(event))) || commands.some(command => activeSequences.has(command.sequence) && (command.status === 'incomplete' || command.signal || (command.status === 'failed' && (command.error !== 'cli_reported_error' || command.action === 'inspect'))));
  const stopped = hardStopped || events.slice(recoveryIndex + 1).some(event => event.kind === 'step-rejected' || (event.kind === 'step-end' && event.status !== 'passed'));
  const unit = events.findLast(event => event.kind === UNIT_EVENTS.start || event.kind === UNIT_EVENTS.skip)?.unit ?? null;
  const skippedUnits = events.filter(event => event.kind === UNIT_EVENTS.skip).map(event => event.previous);
  const recordedThrough = events.at(-1).at;
  const elapsedMs = Date.parse(recordedThrough) - Date.parse(events[0].at);
  const commandMs = commands.reduce((total, command) => total + (command.elapsedMs ?? 0), 0);
  const result = { startedAt: events[0].at, recordedThrough, elapsedMs, commandMs, updatedAt: new Date().toISOString(), uiReserved: starts.reduce((total, event) => total + event.ui, 0), cliCalls: starts.length, targetEvidenceObserved: events.some(event => event.kind === 'target-observed'), phases, commands, unit, skippedUnits, hardStopped, stopped, executionQuality: failed || hardStopped ? 'blocked' : 'requires-independent-review', events };
  fs.writeFileSync(path.join(directory, FILES.record), JSON.stringify(result, null, 2));
  const lines = ['# 自动运行索引', '', '记录实际命令与阶段边界，不自动裁决产品符合性或宣称执行无偏离。UI为批次预留上界，不是推断的实际点击数。', '', '| 阶段 | 起点 | 终点 | 毫秒 |', '| --- | --- | --- | --- |', ...phases.map(phase => `| ${phase.phase} | ${phase.startedAt} | ${phase.endedAt ?? '进行中'} | ${phase.elapsedMs ?? '未知'} |`), '', '| 命令 | 动作 | 状态 | 毫秒 | 原文/输出 | 证据 |', '| --- | --- | --- | --- | --- | --- |', ...commands.map(command => `| ${command.sequence} | ${command.action} | ${command.status} | ${command.elapsedMs ?? '未知'} | ${command.command ? `[命令](./${command.command}) ` : ''}${command.output ? `[输出](./${command.output})` : '未完成'} | ${command.evidence.map(file => `[文件](./${file.path})`).join('、')} |`), ''];
  lines.splice(4, 0, `已记录墙钟：${elapsedMs / 1000}秒（${events[0].at} → ${recordedThrough}）；已结束命令累计：${commandMs / 1000}秒，包含在墙钟内，不另加。进行中时间及未记录部分不推算；阶段可能重叠，不相加充当总耗时。`, '');
  lines.push('## 执行前拒绝', '', ...rejected.map(event => `- ${event.at} ${event.action}: ${event.error} [命令](./${event.command})`), '');
  lines.push('## 纠正记录', '', ...events.filter(event => event.kind === 'correction-authorized').map(event => `- ${event.at} ${event.authorization}；保留原失败、${event.cliCalls}次调用和${event.uiReserved}次UI预留，不重置预算。`), '');
  lines.push('## 单项隔离与安全停止', '', ...events.filter(event => Object.values(UNIT_EVENTS).includes(event.kind)).map(event => `- ${event.at} ${event.kind}: ${event.previous ?? ''} → ${event.unit ?? ''} ${event.reason ?? ''}`), '');
  lines.push('## 安全恢复', '', ...events.filter(event => event.kind === 'safety-cleared').map(event => `- ${event.at}: ${event.evidence}；保留${event.cliCalls}次调用和${event.uiReserved}次UI预留。`), '');
  fs.writeFileSync(path.join(directory, FILES.index), lines.join('\n'));
  return result;
}

function lock(directory, callback) {
  const filename = path.join(directory, FILES.lock);
  const descriptor = fs.openSync(filename, 'wx');
  try { return callback(); } finally { fs.closeSync(descriptor); fs.unlinkSync(filename); }
}

function reject(directory, action, error, invocation, metadata = {}) {
  const command = `raw/rejected-${eventsAt(directory).filter(event => event.kind === 'step-rejected').length + 1}-command.json`;
  fs.writeFileSync(path.join(directory, command), JSON.stringify(invocation, null, 2), { flag: 'wx' });
  append(directory, { kind: 'step-rejected', action, error: error.message, command, ...metadata });
  summary(directory);
  throw error;
}

function init(directory, filename) {
  const startedAt = new Date().toISOString();
  const handoff = JSON.parse(fs.readFileSync(filename, 'utf8'));
  validate(handoff);
  requireValue(!fs.existsSync(directory), 'run_already_exists');
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  fs.mkdirSync(directory);
  fs.mkdirSync(path.join(directory, 'raw'));
  fs.mkdirSync(path.join(directory, 'evidence'));
  fs.writeFileSync(path.join(directory, FILES.handoff), JSON.stringify(handoff, null, 2), { flag: 'wx' });
  fs.writeFileSync(path.join(directory, FILES.events), JSON.stringify({ at: startedAt, kind: 'init' }) + '\n', { flag: 'wx' });
  append(directory, { kind: 'phase-start', phase: 'preparation' });
  return summary(directory);
}

function phase(directory, operation, name) {
  requireValue(PHASES.includes(name) && ['begin', 'end'].includes(operation), 'invalid_phase');
  return lock(directory, () => {
    const events = eventsAt(directory);
    const begun = events.some(event => event.kind === 'phase-start' && event.phase === name);
    const ended = events.some(event => event.kind === 'phase-end' && event.phase === name);
    requireValue(operation === 'begin' ? !begun : begun && !ended, 'phase_boundary_conflict');
    append(directory, { kind: operation === 'begin' ? 'phase-start' : 'phase-end', phase: name });
    return summary(directory);
  });
}

function run(directory, actionId, args) {
  return lock(directory, () => {
    const handoff = JSON.parse(fs.readFileSync(path.join(directory, FILES.handoff), 'utf8'));
    const before = summary(directory);
    const action = handoff.actions.find(item => item.id === actionId);
    const remaining = handoff.limits.wallMs === null ? Infinity : handoff.limits.wallMs - (Date.now() - Date.parse(before.startedAt));
    const detaching = actionId === 'detach';
    const inspecting = actionId === 'inspect';
    try {
      requireValue(action && args.length > 0, 'action_not_in_handoff');
      if (action.script) {
        verifyScript(action.script);
        const semanticArgs = args.filter(argument => !argument.startsWith('-s='));
        const normalized = semanticArgs.length === 2 && semanticArgs[0] === 'run-code' && semanticArgs[1].startsWith('--filename=') ? ['run-code', '--filename', semanticArgs[1].slice('--filename='.length)] : semanticArgs;
        requireValue(JSON.stringify(normalized) === JSON.stringify(['run-code', '--filename', action.script.path]), 'verified_script_required');
      }
      requireValue(digest(handoff.cli.path) === handoff.cli.sha256, 'cli_identity_mismatch');
      if (detaching) requireValue(JSON.stringify(args.filter(argument => !argument.startsWith('-s='))) === JSON.stringify(['detach']), 'detach_command_required');
      requireValue(detaching || (remaining > 0 && !before.hardStopped && (!before.stopped || inspecting)), 'stopped_or_budget_exhausted');
      requireValue(detaching || before.uiReserved + action.ui <= handoff.limits.ui, 'ui_budget_exhausted');
      if (inspecting) {
        requireValue(!inspectionOutputMistake(directory, action, args), INSPECTION_OUTPUT_ERROR);
        requireValue(action.ui === 0 && args.filter(argument => !argument.startsWith('-s=')).length === 1 && INSPECTIONS.includes(args.filter(argument => !argument.startsWith('-s='))[0]), 'inspection_command_required');
      }
    } catch (error) {
      reject(directory, actionId, error, { entry: handoff.cli.path, argv: args });
    }
    const sequence = before.cliCalls + 1;
    const output = `raw/${String(sequence).padStart(3, '0')}.txt`;
    const command = `raw/${String(sequence).padStart(3, '0')}-command.json`;
    const currentEvidence = new Set(fs.readdirSync(path.join(directory, 'evidence')));
    fs.writeFileSync(path.join(directory, command), JSON.stringify({ node: process.execPath, entry: handoff.cli.path, argv: args }, null, 2), { flag: 'wx' });
    append(directory, { kind: 'step-start', sequence, action: actionId, unit: before.unit, ui: action.ui, command, argumentsSha256: crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex') });
    const started = process.hrtime.bigint();
    const descriptor = fs.openSync(path.join(directory, output), 'wx');
    let result;
    try { result = child.spawnSync(process.execPath, [handoff.cli.path, ...args], { stdio: ['ignore', descriptor, descriptor], timeout: detaching ? handoff.limits.commandMs : Math.min(remaining, handoff.limits.commandMs), windowsHide: true }); } finally { fs.closeSync(descriptor); }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const cliError = /^### Error\b/m.test(fs.readFileSync(path.join(directory, output), 'utf8'));
    const status = result.status === 0 && !result.error && !cliError ? 'passed' : 'failed';
    const evidence = fs.readdirSync(path.join(directory, 'evidence')).filter(file => !currentEvidence.has(file)).map(file => {
      const filename = path.join(directory, 'evidence', file);
      requireValue(fs.lstatSync(filename).isFile(), 'invalid_evidence_file');
      return { path: `evidence/${file}`, sha256: digest(filename) };
    });
    append(directory, { kind: 'step-end', sequence, status, elapsedMs, exitCode: result.status, signal: result.signal, output, evidence, error: result.error?.code ?? (cliError ? 'cli_reported_error' : null) });
    const state = summary(directory);
    requireValue(status === 'passed', `command_failed_${sequence}`);
    return state;
  });
}

function resume(directory, authorization) {
  requireValue(nonempty(authorization), 'correction_authorization_required');
  return lock(directory, () => {
    const handoff = JSON.parse(fs.readFileSync(path.join(directory, FILES.handoff), 'utf8'));
    validate(handoff);
    const before = summary(directory);
    const lastRecovery = before.events.findLastIndex(event => ['correction-authorized', 'unit-skipped', 'safety-cleared'].includes(event.kind));
    const pendingEvents = before.events.slice(lastRecovery + 1);
    const completedFailure = pendingEvents.some(event => (event.kind === 'step-end' && event.status === 'failed') || (event.kind === 'step-rejected' && (event.error === INSPECTION_OUTPUT_ERROR || (event.error === UNIT_SCOPE_ERROR && nonfatalRejection(event)))));
    requireValue(before.stopped && completedFailure && !before.commands.some(command => command.status === 'incomplete'), 'correction_requires_completed_failure');
    requireValue(!pendingEvents.some(event => event.kind === 'step-rejected' && !nonfatalRejection(event)), 'correction_unsafe_rejection');
    requireValue(!before.hardStopped, 'correction_hard_stop');
    requireValue(before.uiReserved < handoff.limits.ui && (handoff.limits.wallMs === null || Date.now() - Date.parse(before.startedAt) < handoff.limits.wallMs), 'correction_budget_exhausted');
    append(directory, { kind: 'correction-authorized', authorization, cliCalls: before.cliCalls, uiReserved: before.uiReserved });
    return summary(directory);
  });
}

function recover(directory, evidence) {
  requireValue(nonempty(evidence), 'safety_evidence_required');
  return lock(directory, () => {
    const handoff = JSON.parse(fs.readFileSync(path.join(directory, FILES.handoff), 'utf8'));
    validate(handoff);
    const before = summary(directory);
    requireValue(before.hardStopped, 'safety_stop_required');
    requireValue(!before.commands.some(command => command.status === 'incomplete' || command.signal), 'safety_inflight_unresolved');
    requireValue(before.uiReserved < handoff.limits.ui && (handoff.limits.wallMs === null || Date.now() - Date.parse(before.startedAt) < handoff.limits.wallMs), 'safety_budget_exhausted');
    append(directory, { kind: 'safety-cleared', evidence, cliCalls: before.cliCalls, uiReserved: before.uiReserved });
    return summary(directory);
  });
}

function transition(directory, operation, unit, reason) {
  return lock(directory, () => {
    const handoff = JSON.parse(fs.readFileSync(path.join(directory, FILES.handoff), 'utf8'));
    const before = summary(directory);
    try {
      requireValue(Object.hasOwn(UNIT_EVENTS, operation), 'invalid_unit_operation');
      if (operation === 'halt') requireValue(nonempty(reason), 'safety_reason_required');
      else {
        validate(handoff);
        requireValue(!before.hardStopped, 'unit_hard_stop');
        requireValue(unit === 'preparation' || handoff.scope.includes(unit), UNIT_SCOPE_ERROR);
        requireValue(unit !== before.unit, 'unit_closed_or_current');
        requireValue(before.uiReserved < handoff.limits.ui && (handoff.limits.wallMs === null || Date.now() - Date.parse(before.startedAt) < handoff.limits.wallMs), 'unit_budget_exhausted');
        if (operation === 'skip') {
          requireValue(nonempty(reason), 'skip_reason_required');
          requireValue(before.unit && before.stopped && !before.commands.some(command => command.status === 'incomplete'), 'skip_requires_unit_failure');
          const lastFailure = before.events.findLastIndex(event => event.kind === 'step-rejected' || (event.kind === 'step-end' && event.status === 'failed'));
          requireValue(before.events.slice(lastFailure + 1).some(event => event.kind === 'step-end' && event.status === 'passed' && before.commands.some(command => command.sequence === event.sequence && command.action === 'inspect')), 'skip_requires_inspection');
        } else requireValue(!before.stopped, 'unit_failure_unresolved');
      }
    } catch (error) {
      const action = operation === 'start' ? 'unit' : operation;
      const args = [action, directory, ...(operation === 'halt' ? [reason] : [unit, ...(reason === undefined ? [] : [reason])])];
      const recoverable = error.message === UNIT_SCOPE_ERROR && ['start', 'skip'].includes(operation) && nonempty(unit) && !before.hardStopped && !before.commands.some(command => command.status === 'incomplete' || command.signal) && before.uiReserved < handoff.limits.ui && (handoff.limits.wallMs === null || Date.now() - Date.parse(before.startedAt) < handoff.limits.wallMs);
      if (error.message === UNIT_SCOPE_ERROR) error.allowedUnits = handoff.scope;
      reject(directory, action, error, { node: process.execPath, entry: __filename, argv: args }, { unit, reason: reason ?? null, ...(recoverable ? { recoverable: true } : {}) });
    }
    if (operation === 'halt') {
      append(directory, { kind: UNIT_EVENTS.halt, unit: before.unit, reason });
      return summary(directory);
    }
    append(directory, { kind: UNIT_EVENTS[operation], previous: before.unit, unit, reason: reason ?? null });
    return summary(directory);
  });
}

function budget(directory, wallMs, authorization) {
  requireValue(wallMs === null || (Number.isSafeInteger(wallMs) && wallMs > 0), 'invalid_limit_wallMs');
  requireValue(nonempty(authorization), 'budget_authorization_required');
  return lock(directory, () => {
    const filename = path.join(directory, FILES.handoff);
    const handoff = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const archived = `handoff-before-budget-${eventsAt(directory).filter(event => event.kind === 'budget-amended').length + 1}.json`;
    fs.copyFileSync(filename, path.join(directory, archived), fs.constants.COPYFILE_EXCL);
    const previous = handoff.limits.wallMs;
    handoff.limits.wallMs = wallMs;
    fs.writeFileSync(filename, JSON.stringify(handoff, null, 2));
    append(directory, { kind: 'budget-amended', previousWallMs: previous, wallMs, authorization, archivedHandoff: archived });
    return summary(directory);
  });
}

function finish(directory) {
  return lock(directory, () => {
    const before = summary(directory);
    requireValue(before.phases.every(phase => phase.endedAt !== null), 'finish_requires_closed_phases');
    requireValue(before.commands.every(command => command.status !== 'incomplete'), 'finish_requires_completed_commands');
    append(directory, { kind: FINISH_EVENT });
    return summary(directory);
  });
}

function observed(directory, filename) {
  return lock(directory, () => {
    const file = path.resolve(directory, filename);
    const relative = path.relative(directory, file);
    requireValue(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && fs.lstatSync(file).isFile(), 'target_evidence_outside_run');
    const actualRelative = path.relative(fs.realpathSync(directory), fs.realpathSync(file));
    requireValue(actualRelative && !actualRelative.startsWith('..') && !path.isAbsolute(actualRelative), 'target_evidence_outside_run');
    append(directory, { kind: 'target-observed', evidence: relative, sha256: digest(file) });
    return summary(directory);
  });
}

module.exports = { init, phase, run, observed, budget, resume, recover, transition, finish, summary };

if (require.main === module) {
  try {
    const [operation, directory, argument, ...remaining] = process.argv.slice(2);
    requireValue(directory, 'run_directory_required');
    const output = operation === 'init' ? init(directory, argument) : operation === 'phase' ? phase(directory, argument, remaining[0]) : operation === 'run' ? run(directory, argument, remaining[0] === '--' ? remaining.slice(1) : remaining) : operation === 'observed' ? observed(directory, argument) : operation === 'budget' ? budget(directory, argument === 'unlimited' ? null : Number(argument), remaining[0]) : operation === 'resume' ? resume(directory, argument) : operation === 'recover' ? recover(directory, argument) : operation === 'unit' ? transition(directory, 'start', argument) : operation === 'skip' ? transition(directory, 'skip', argument, remaining[0]) : operation === 'halt' ? transition(directory, 'halt', null, argument) : operation === 'finish' ? finish(directory) : operation === 'status' ? lock(directory, () => summary(directory)) : (() => { throw new Error('unknown_operation'); })();
    console.log(JSON.stringify({ directory: path.resolve(directory), cliCalls: output.cliCalls, uiReserved: output.uiReserved, targetEvidenceObserved: output.targetEvidenceObserved, executionQuality: output.executionQuality }));
  } catch (error) { console.error(error.message); if (error.allowedUnits) console.error(`allowed units: ${JSON.stringify(error.allowedUnits)}`); process.exitCode = 1; }
}
