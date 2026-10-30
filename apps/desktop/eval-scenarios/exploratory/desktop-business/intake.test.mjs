import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assembleCases } from './assemble.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const atObservation = (record, field) => record.assetPreparation?.previous?.[field] ?? record[field];
const readJson = (file) => JSON.parse(readFileSync(join(directory, file), 'utf8'));
const priorities = ['P0', 'P1', 'P2', 'P3'];
const expectedNewIds = [
  'BROAD-PROJ-PIN', 'BROAD-PROJ-FILTER', 'BROAD-RES-HISTORY', 'BROAD-RES-DUPLICATE',
  'BROAD-RES-VIEW', 'BROAD-LIT-COLUMNS', 'BROAD-LIT-ZOTERO', 'BROAD-CHAT-ARTIFACT',
  'BROAD-CHAT-ARTIFACT-IMPORT', 'BROAD-CHAT-REFERENCE-TASK', 'BROAD-CHAT-REFERENCE-LIT',
  'BROAD-WORKSPACE-TABS', 'BROAD-CONNECTOR-AUTH', 'BROAD-SET-CONTEXT',
  'BROAD-SET-AUTOSAVE', 'BROAD-SET-VERSION-POLICY', 'BROAD-SET-PROMPTS',
  'BROAD-SET-NOTIFICATION', 'BROAD-SET-STORAGE', 'BROAD-SET-BROWSER-DATA',
];
const amendments = {
  'BROAD-RES-RENAME': 'D4-RES-011', 'BROAD-RES-REF': 'D4-RES-014',
  'BROAD-LIT-META': 'D4-LIT-012', 'BROAD-LIT-NOTE': 'D4-LIT-014',
  'BROAD-LIT-PROJECT': 'D4-LIT-011', 'BROAD-CHAT-STOP': 'D4-CHAT-007',
  'BROAD-SEARCH-CROSS': 'D6-CHAT-004', 'BROAD-CHAT-QUEUE': 'D4-CHAT-008',
  'BROAD-RES-MOVE': 'D4-RES-012',
};
const intakeSnapshot = '20261024T131248Z-105872aa';

test('bounded breadth intake registers twenty partial candidates and reuses nine existing identities', () => {
  const descriptor = assembleCases();
  const catalog = readJson('../../../docs/scenarios/catalog.json');
  const points = new Map(catalog.points.map((point) => [point.id, point]));
  const records = new Map(descriptor.cases.map((record) => [record.id, record]));
  const intake = descriptor.cases.filter((record) => record.candidateLocalId?.startsWith('BROAD-'));
  assert.deepEqual(intake.map((record) => record.candidateLocalId).sort(), [...expectedNewIds].sort());
  assert.equal(descriptor.cases.length, 105);
  assert.equal(points.size, 88);
  for (const record of intake) {
    const point = points.get(record.businessPointId);
    assert.equal(point.status, 'active', record.id);
    assert.equal(point.reviewState, 'pending', record.id);
    assert.equal(point.coverageEligibility, 'exploratory', record.id);
    assert.equal(atObservation(point, 'readiness'), 'partial', record.id);
    assert.equal(atObservation(record, 'readiness'), 'partial', record.id);
    assert.equal(record.expectedStatus, 'candidate_unapproved', record.id);
    assert.deepEqual(atObservation(record, 'checkIds'), [], record.id);
    assert.ok(atObservation(record, 'assetGaps').length, record.id);
    assert.equal(record.observedPlatform, 'macos-arm64', record.id);
    assert.ok(record.observationScope, record.id);
    assert.ok(record.evidenceRefs.some((reference) => reference.includes(intakeSnapshot)), record.id);
  }
  for (const [localId, caseId] of Object.entries(amendments)) {
    const record = records.get(caseId);
    assert.ok(record.observationSources.some((source) => source.localId === localId && source.snapshotId === intakeSnapshot), localId);
    assert.equal(atObservation(record, 'readiness'), 'partial', caseId);
    assert.ok(atObservation(record, 'assetGaps').length, caseId);
  }
  for (const caseId of ['D4-RES-014', 'D4-CHAT-008', 'D6-SET-007']) {
    assert.equal(records.get(caseId).resultEvidenceStatus, 'insufficient', caseId);
    assert.notEqual(records.get(caseId).observationStatus, 'observed', caseId);
  }
  assert.equal(records.get('D4-RES-012').resultEvidenceStatus, 'missing');
  assert.equal(records.get('D6-CHAT-006').evidenceCaveat.includes('前言'), true);
});

test('priority review retains all earlier IDs and exposes every case exactly once in the tier index', () => {
  const descriptor = assembleCases();
  const range = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`);
  const previous = {
    'library.json': range('D4-RES', 18),
    'literature.json': [...range('D4-LIT', 20), ...range('D6-LIT', 1)],
    'conversation.json': [...range('D4-CHAT', 14), ...range('D6-CHAT', 4)],
    'skills.json': [...range('D4-SKILL', 8), ...range('D6-SKILL', 4)],
    'project.json': range('D6-PROJ', 8),
    'settings.json': range('D6-SET', 6),
  };
  for (const [file, ids] of Object.entries(previous)) {
    assert.deepEqual(readJson(`cases/${file}`).slice(0, ids.length).map((record) => record.id), ids, file);
  }
  const counts = Object.fromEntries(priorities.map((priority) => [priority, descriptor.cases.filter((record) => record.priority === priority).length]));
  assert.deepEqual(counts, { P0: 10, P1: 45, P2: 44, P3: 6 });
  assert.deepEqual(descriptor.scope.priority_case_counts, counts);
  const index = readFileSync(join(directory, 'coverage.md'), 'utf8').split('## 全用例分级索引')[1];
  assert.ok(index, 'coverage must provide the complete case-priority projection');
  const rows = index.split('\n').filter((line) => /^\| `D[46]-/.test(line));
  assert.equal(rows.length, descriptor.cases.length);
  for (const record of descriptor.cases) {
    const matching = rows.filter((line) => line.startsWith(`| \`${record.id}\` |`));
    assert.equal(matching.length, 1, record.id);
    assert.ok(matching[0].includes(`| ${record.priority} |`), record.id);
  }
  const changed = descriptor.cases.filter((record) => record.priorityReview?.previousPriority);
  assert.equal(changed.filter((record) => !record.candidateLocalId?.startsWith('BROAD-')).length, 16);
  for (const record of changed) {
    assert.notEqual(record.priorityReview.previousPriority, record.priority, record.id);
    assert.ok(record.priorityReview.reason, record.id);
    assert.equal(record.priorityReview.source, 'user_authorized_risk_review', record.id);
  }
  for (const record of descriptor.cases.filter((record) => record.sourceLocator.startsWith('apps/desktop/docs/scenarios/catalog.json#'))) {
    assert.ok(record.sourceLocator.endsWith(`#${record.businessPointId}@${record.revision}`), record.id);
  }
});
