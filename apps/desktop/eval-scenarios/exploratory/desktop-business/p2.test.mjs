import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { outlinePdf } from '../p2-assets/fixtures.mjs';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const script = '.agents/skills/llm-evaluation-scenarios/scripts/preflight.mjs';

test('tier three prepares all 76 points without silently adding outside directions or P3 variants', () => {
  for (const platform of ['macos', 'windows']) {
    const result = JSON.parse(execFileSync(process.execPath, [script, '--tier', '3', '--platform', platform], { cwd: root }));
    assert.equal(result.summary.plannedPoints, 76);
    assert.equal(result.summary.assetReadyPoints, 76);
    assert.equal(result.summary.assetGapPoints, 0);
    assert.equal(result.summary.checkDenominatorComplete, true);
    assert.deepEqual(Object.fromEntries(['P0', 'P1', 'P2'].map((priority) => [priority,
      result.catalogManifest.selected.filter((point) => point.priority === priority).length,
    ])), { P0: 10, P1: 33, P2: 33 });
    for (const gaps of Object.values(result.gaps)) assert.deepEqual(gaps, []);
    const cases = JSON.parse(readFileSync(`${root}/apps/desktop/eval-scenarios/exploratory/desktop-business/cases.json`)).cases;
    for (const point of result.catalogManifest.selected) {
      const checks = result.checks.filter(({ required, pointIds }) => required && pointIds.includes(point.id));
      const linked = cases.filter((record) => record.businessPointId === point.id && record.priority <= 'P2');
      for (const check of checks) assert.ok(linked.some((record) => record.checkIds.includes(check.id)), `${point.id}/${check.id}`);
      assert.equal(point.coverageEligibility, 'exploratory');
    }
    for (const outside of ['MODEL-PROMPTS-01', 'CONNECTOR-VALIDATE-01', 'CONNECTOR-PREVIEW-01']) {
      assert.ok(!result.catalogManifest.selected.some(({ id }) => id === outside));
    }
  }
});

test('non-PDF P2 inputs retain earlier P0/P1 criteria; PDF split is verified separately', () => {
  const old = JSON.parse(execFileSync('git', ['show', 'bc6c7e0efdec666539d1c58a4fb5e4042b185a65:apps/desktop/eval-scenarios/frozen/p1-20261025-e2567e836/macos.json'], { cwd: root, maxBuffer: 4 * 1024 * 1024 }));
  for (const check of old.checks) {
    if (check.directionId === 'LIT-01') {
      const table = readFileSync(`${root}/apps/desktop/eval-scenarios/README.md`, 'utf8');
      assert.match(table, /^\| LIT-01 \| 2 \|/m);
      continue;
    }
    const before = execFileSync('git', ['show', `${old.scopeIdentity.gitCommit}:${check.criterionPath}`], { cwd: root, encoding: 'utf8' });
    const after = readFileSync(`${root}/${check.criterionPath}`, 'utf8');
    const section = before.split('\n').find((line) => line.includes(`**${check.id}｜`));
    assert.ok(section && after.split('\n').includes(section), check.id);
  }
});

test('P2 fixtures have reproducible page, outline and exact-size boundary identities', () => {
  const directory = `${root}/apps/desktop/eval-scenarios/exploratory/p2-assets`;
  execFileSync(process.execPath, [`${directory}/fixtures.mjs`, '--check']);
  const bytes = readFileSync(`${directory}/fixtures/outline.pdf`);
  assert.deepEqual(bytes, outlinePdf());
  const pdf = bytes.toString('ascii');
  assert.ok(pdf.includes('/Title (Second section)') && pdf.includes('/Dest [6 0 R /Fit]'));
  assert.ok(pdf.includes('P2-ANNOTATE-TARGET') && pdf.includes('/Count 2'));
  const start = Number(/startxref\n(\d+)/.exec(pdf)[1]);
  assert.equal(pdf.slice(start, start + 4), 'xref');
  for (const size of [1023, 1024, 1025]) assert.equal(readFileSync(`${directory}/fixtures/threshold/${size}.txt`).length, size);
  const bib = readFileSync(`${directory}/fixtures/bibliography.bib`, 'utf8');
  const ris = readFileSync(`${directory}/fixtures/bibliography.ris`, 'utf8');
  assert.equal((bib.match(/@article\{/g) ?? []).length, 2);
  assert.equal((ris.match(/^TY  - JOUR/gm) ?? []).length, 2);
  assert.ok(bib.includes('BIB-ALPHA') && ris.includes('RIS-ALPHA') && !ris.includes('BIB-ALPHA'));
});
