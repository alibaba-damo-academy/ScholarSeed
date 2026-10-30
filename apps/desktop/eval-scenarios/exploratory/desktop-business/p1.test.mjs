import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { renderPdf } from '../p1-assets/fixtures.mjs';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const script = '.agents/skills/llm-evaluation-scenarios/scripts/preflight.mjs';

test('P0 plus P1 has all 43 stable points and a complete Check denominator on each declared platform', () => {
  for (const platform of ['macos', 'windows']) {
    const result = JSON.parse(execFileSync(process.execPath, [script, '--tier', '2', '--platform', platform], { cwd: root }));
    assert.equal(result.summary.plannedPoints, 43);
    assert.equal(result.catalogManifest.selected.filter(({ priority }) => priority === 'P0').length, 10);
    assert.equal(result.catalogManifest.selected.filter(({ priority }) => priority === 'P1').length, 33);
    assert.equal(result.summary.assetReadyPoints, 43);
    assert.equal(result.summary.assetGapPoints, 0);
    assert.equal(result.summary.knownRequiredChecks, 54);
    assert.equal(result.summary.knownOptionalChecks, 1);
    assert.equal(result.summary.checkDenominatorComplete, true);
    for (const gaps of Object.values(result.gaps)) assert.deepEqual(gaps, []);
    for (const point of result.catalogManifest.selected) {
      assert.equal(point.coverageEligibility, 'exploratory');
      assert.ok(result.checks.some(({ required, pointIds }) => required && pointIds.includes(point.id)), point.id);
    }
  }
});

test('new P1 assets contain executable tasks, fixtures, criteria and no runtime authorization', () => {
  for (const name of ['library-management', 'literature-management', 'literature-reading', 'conversation-management']) {
    const directory = `${root}/apps/desktop/eval-scenarios/exploratory/${name}`;
    const descriptor = JSON.parse(readFileSync(`${directory}/scenario.json`));
    const driver = readFileSync(`${directory}/driver.md`, 'utf8');
    const judge = readFileSync(`${directory}/judge.md`, 'utf8');
    assert.ok(descriptor.project.files.length > 0, name);
    assert.ok(driver.includes('本轮授权'), name);
    assert.ok(driver.includes('不读取') && driver.includes('judge.md'), name);
    assert.ok(judge.includes('not_evaluated') && judge.includes('inconclusive'), name);
    assert.deepEqual(JSON.parse(readFileSync(`${directory}/baseline.json`)).provisional, true);
    assert.equal(readFileSync(`${directory}/cmd.jsonl`, 'utf8'), '{"op":"status"}\n');
  }
});

test('synthetic PDF inputs are deterministic and preserve independent page identities', () => {
  const fixtureRoot = `${root}/apps/desktop/eval-scenarios/exploratory/p1-assets`;
  execFileSync(process.execPath, [`${fixtureRoot}/fixtures.mjs`, '--check']);
  const pdf = readFileSync(`${fixtureRoot}/fixtures/document.pdf`, 'ascii');
  assert.ok(pdf.includes('/Count 2'));
  assert.ok(pdf.includes('Page 1 - Alpha pilot') && pdf.includes('Page 2 - Independent review'));
  assert.ok(pdf.includes('Twelve people') && pdf.includes('Five reviewers'));
  const sample = renderPdf([['literal (text) \\ path']]);
  assert.deepEqual(sample, renderPdf([['literal (text) \\ path']]));
  const source = sample.toString('ascii');
  const start = Number(/startxref\n(\d+)/.exec(source)[1]);
  assert.equal(source.slice(start, start + 4), 'xref');
});

test('asset preparation preserves candidate observations and records exactly the 29 affected identities', () => {
  const catalog = JSON.parse(readFileSync(`${root}/apps/desktop/docs/scenarios/catalog.json`));
  const cases = JSON.parse(readFileSync(`${root}/apps/desktop/eval-scenarios/exploratory/desktop-business/cases.json`)).cases;
  const prepared = catalog.points.filter(({ assetPreparation }) => assetPreparation?.id === 'p1-assets-20261025');
  assert.equal(prepared.length, 29);
  for (const point of prepared) {
    assert.equal(point.priority, 'P1');
    assert.equal(point.directionPreparation?.previous.revision ?? point.revision, point.assetPreparation.previous.revision + 1);
    assert.equal(point.assetPreparation.previous.readiness, 'partial');
    assert.equal(point.readiness, 'manual_ready');
    assert.equal(point.coverageEligibility, 'exploratory');
    const main = cases.filter((record) => record.businessPointId === point.id && !record.variantOf && record.sourceKind !== 'catalog_case_variant' && record.priority === 'P1');
    assert.equal(main.length, 1, point.id);
    for (const record of main) {
      assert.equal(record.readiness, 'manual_ready');
      assert.ok(record.checkIds.length > 0);
      assert.equal(record.expectedStatus, 'candidate_unapproved');
      assert.deepEqual(record.assetGaps, []);
    }
  }
});
