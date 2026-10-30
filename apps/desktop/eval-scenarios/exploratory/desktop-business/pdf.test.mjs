import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const asset = `${root}/apps/desktop/eval-scenarios/exploratory/literature-pdf-ai`;
const qualityPoints = ['LIT-PDF-EXPLAIN-QUALITY-01', 'LIT-PDF-TRANSLATE-QUALITY-01'];
const qualityChecks = ['LIT-EXPLAIN-QUALITY', 'LIT-TRANSLATE-QUALITY', 'LIT-QUALITY-EVIDENCE'];

test('PDF P0 projects only functional Checks while P1 adds separate semantic points on both platforms', () => {
  for (const platform of ['macos', 'windows']) {
    const manifests = [1, 2].map(tier => JSON.parse(execFileSync(process.execPath, [
      '.agents/skills/llm-evaluation-scenarios/scripts/preflight.mjs', '--tier', String(tier), '--platform', platform,
    ], { cwd: root })));
    const [p0, p1] = manifests;
    assert.equal(p0.directions.find(direction => direction.id === 'LIT-01').revision, 2);
    assert.equal(p0.summary.plannedPoints, 10);
    assert.equal(p0.summary.knownRequiredChecks, 18);
    const functional = p0.checks.filter(check => check.directionId === 'LIT-01');
    assert.deepEqual(functional.map(check => check.id), ['LIT-OPEN', 'LIT-EXPLAIN', 'LIT-TRANSLATE', 'LIT-EVIDENCE']);
    assert.ok(functional.every(check => check.evaluationType === 'A'));
    assert.ok(!p0.catalogManifest.selected.some(point => qualityPoints.includes(point.id)));
    for (const id of qualityPoints) {
      const point = p1.catalogManifest.selected.find(point => point.id === id);
      assert.ok(point, id);
      assert.equal(point.priority, 'P1');
      assert.equal(point.readiness, 'manual_ready');
      assert.equal(point.coverageEligibility, 'exploratory');
    }
    assert.deepEqual(p1.checks.filter(check => qualityChecks.includes(check.id)).map(check => check.id), qualityChecks);
    assert.equal(p1.summary.plannedPoints, 43);
    assert.equal(p1.summary.knownRequiredChecks, 54);
    for (const result of manifests) {
      assert.equal(result.summary.checkDenominatorComplete, true);
      assert.equal(result.summary.assetGapPoints, 0);
      for (const gaps of Object.values(result.gaps)) assert.deepEqual(gaps, []);
    }
  }
});

test('PDF tier separation retains quality requirements, source identity, safety and historical scope', () => {
  const judge = readFileSync(`${asset}/judge.md`, 'utf8');
  const driver = readFileSync(`${asset}/driver.md`, 'utf8');
  const mapping = JSON.parse(readFileSync(`${asset}/checks.json`));
  for (const id of ['LIT-EXPLAIN', 'LIT-TRANSLATE']) {
    const line = judge.split('\n').find(line => line.includes(`**${id}｜`));
    assert.match(line, /触发.*完成.*展示/);
    assert.match(line, /P1/);
  }
  for (const id of qualityChecks) {
    const check = mapping.checks.find(check => check.id === id);
    assert.ok(check?.required, id);
    assert.ok(check.pointIds.every(id => qualityPoints.includes(id)), id);
  }
  assert.match(judge, /前测.*前后/);
  assert.match(judge, /数字、条件、否定或因果关系反转/);
  assert.match(judge, /实际模型.*副作用/);
  assert.match(judge, /历史.*冻结.*不.*追溯|历史.*不.*覆盖/);
  assert.match(driver, /同一次.*结果.*复用/);
  assert.match(driver, /不.*重新生成/);
  assert.match(driver, /授权.*停止/);
  const cases = JSON.parse(readFileSync(`${root}/apps/desktop/eval-scenarios/exploratory/desktop-business/cases/literature.json`));
  for (const id of qualityPoints) assert.equal(cases.filter(record => record.businessPointId === id).length, 1);
});

test('authorized PDF split keeps the former semantic and safety requirements in P1 rather than deleting them', () => {
  const previous = execFileSync('git', ['show', '2360c20b5f21134d6c0a09e4f1d9ece1d489f4e4:apps/desktop/eval-scenarios/exploratory/literature-pdf-ai/judge.md'], { cwd: root, encoding: 'utf8' });
  const current = readFileSync(`${asset}/judge.md`, 'utf8');
  for (const [id, marker] of [['LIT-EXPLAIN', '解释须'], ['LIT-TRANSLATE', '译文须'], ['LIT-EVIDENCE', '两次动作']]) {
    const original = previous.split('\n').find(line => line.includes(`**${id}｜`));
    const requirements = original.slice(original.indexOf(marker)).split('。').filter(Boolean);
    const targetId = id === 'LIT-EVIDENCE' ? 'LIT-QUALITY-EVIDENCE' : `${id}-QUALITY`;
    const target = current.split('\n').find(line => line.includes(`**${targetId}｜`));
    for (const requirement of requirements) assert.ok(target.includes(requirement), `${targetId}: ${requirement}`);
  }
});
