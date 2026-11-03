import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assembleCases } from './assemble.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const atObservation = (record, field) => record.assetPreparation?.previous?.[field] ?? record[field];
const domains = ['项目', '资料库', '文献', 'AI对话', '技能中心', '模型与账户设置'];
const sourceFiles = ['project.json', 'library.json', 'literature.json', 'conversation.json', 'skills.json', 'settings.json'];
const catalogPath = join(directory, '../../../docs/scenarios/catalog.json');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

test('six-domain expansion includes real nonempty project and settings sources without removing the sixty earlier cases', () => {
  const aggregate = assembleCases();
  const records = sourceFiles.flatMap((file) => {
    const cases = readJson(join(directory, 'cases', file));
    assert.ok(Array.isArray(cases) && cases.length > 0, file);
    return cases;
  });
  assert.equal(new Set(records.map(({ id }) => id)).size, records.length);
  assert.equal(records.filter(({ id }) => id.startsWith('D4-')).length, 60);
  assert.deepEqual(new Set(aggregate.cases.map(({ id }) => id)), new Set(records.map(({ id }) => id)));
  assert.deepEqual(new Set(Object.keys(aggregate.scope.domain_case_counts)), new Set(domains));
  assert.equal(aggregate.case_count, records.length);
  assert.equal(aggregate.scope.case_rows, records.length);
  assert.ok(records.some(({ id, priority }) => id.startsWith('D6-PROJ-') && priority === 'P1'));
  assert.ok(records.some(({ id, priority }) => id.startsWith('D6-SET-') && priority === 'P2'));
});

test('new read-only settings observations do not pretend to prove credential configuration or login', () => {
  const catalog = readJson(catalogPath);
  const records = readJson(join(directory, 'cases', 'settings.json'));
  for (const id of ['MODEL-CATALOG-01', 'ACCOUNT-STATE-01']) {
    const point = catalog.points.find((entry) => entry.id === id);
    assert.ok(point, id);
    assert.equal(point.coverageEligibility, 'exploratory');
    assert.notEqual(point.priority, 'P0');
    assert.ok(records.some((entry) => entry.businessPointId === id));
  }
  for (const id of ['MODEL-CONFIG-01', 'ACCOUNT-LOGIN-01']) {
    const point = catalog.points.find((entry) => entry.id === id);
    assert.ok(point, id);
    assert.equal(point.readiness, 'manual_ready', 'input assets are prepared, not runtime credentials');
    assert.ok(point.preconditions.some((condition) => /账户|密钥/.test(condition)), 'dedicated runtime prerequisites must remain explicit');
    assert.equal(point.coverageEligibility, 'exploratory');
    const cases = records.filter((entry) => entry.businessPointId === id);
    assert.ok(cases.length > 0, id);
    for (const record of cases) {
      if (!record.variantOf) assert.notEqual(record.observationStatus, 'observed', id);
      assert.equal(record.expectedStatus, 'candidate_unapproved');
    }
  }
  const invalidProbe = records.find((record) => record.id === 'D6-SET-005');
  assert.equal(invalidProbe.variantOf, 'D6-SET-001');
  assert.equal(invalidProbe.readiness, 'partial', 'an observed invalid-address probe does not prove valid credential configuration');
});

test('expanded directions expose independent Check mappings and keep the original P0 scope intact', () => {
  const aggregate = assembleCases();
  const originalP0 = aggregate.cases.filter(({ priority }) => priority === 'P0');
  assert.equal(originalP0.length, 10);
  assert.ok(originalP0.every(({ id }) => id.startsWith('D4-')));
  const catalog = readJson(catalogPath);
  const points = new Map(catalog.points.map((point) => [point.id, point]));
  for (const scenario of ['project-flow', 'model-settings', 'account-state']) {
    const path = join(directory, '..', scenario);
    const mapping = readJson(join(path, 'checks.json'));
    const criteria = readFileSync(join(path, 'judge.md'), 'utf8');
    assert.ok(mapping.checks.length > 0);
    for (const check of mapping.checks) {
      assert.equal(check.evaluationType, 'A');
      assert.ok(criteria.includes(check.id), check.id);
      for (const id of check.pointIds) {
        assert.ok(points.get(id)?.directionIds.includes(mapping.directionId), id);
      }
    }
    for (const name of ['README.md', 'driver.md', 'scenario.json', 'cmd.jsonl', 'baseline.json']) {
      assert.ok(readFileSync(join(path, name)).length > 0, name);
    }
  }
});
