import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const directory = dirname(fileURLToPath(import.meta.url));
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const snapshots = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory());

test('versioned frozen inputs bind both platform manifests and every source asset to their committed identities', () => {
  assert.ok(snapshots.length > 0);
  for (const snapshot of snapshots) {
    const path = join(directory, snapshot.name);
    const freeze = JSON.parse(readFileSync(join(path, 'freeze.json')));
    const tier = freeze.id.startsWith('p1-') ? 2 : freeze.id.startsWith('p2-') ? 3 : null;
    assert.ok(tier, 'snapshot must declare a supported input tier');
    const expectedPoints = tier === 2 ? 41 : 74;
    const expectedChecks = tier === 2 ? 51 : 92;
    assert.equal(freeze.evaluationExecuted, false);
    assert.equal(freeze.runtimeAuthorizationGranted, false);
    assert.match(freeze.sourceCommit, /^[0-9a-f]{40}$/);
    for (const source of freeze.sourceFiles) {
      assert.ok(!source.path.startsWith('/') && !source.path.split('/').includes('..'));
      const bytes = execFileSync('git', ['show', `${freeze.sourceCommit}:${source.path}`], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
      assert.equal(digest(bytes), source.sha256, source.path);
    }
    for (const manifestFile of freeze.manifests) {
      const bytes = readFileSync(join(path, manifestFile.path));
      assert.equal(digest(bytes), manifestFile.sha256);
      const manifest = JSON.parse(bytes);
      assert.equal(manifest.scopeIdentity.state, 'committed');
      assert.equal(manifest.scopeIdentity.gitCommit, freeze.sourceCommit);
      assert.equal(manifest.catalogManifest.selection.platform, manifestFile.platform);
      assert.deepEqual(manifest.summary, {
        plannedPoints: expectedPoints, assetReadyPoints: expectedPoints, assetGapPoints: 0,
        knownRequiredChecks: expectedChecks, knownOptionalChecks: 1, checkDenominatorComplete: true,
      });
      const ids = manifest.catalogManifest.selected.map(({ id }) => id).sort();
      assert.deepEqual(ids, freeze.cases.map(({ businessPointId }) => businessPointId).sort());
      assert.equal(new Set(freeze.cases.map(({ caseId }) => caseId)).size, expectedPoints);
      assert.equal(manifest.catalogManifest.selection.tier, tier);
      assert.equal(manifest.catalogManifest.selected.filter(({ priority }) => priority === 'P0').length, 10);
      assert.equal(manifest.catalogManifest.selected.filter(({ priority }) => priority === 'P1').length, 31);
      if (tier === 3) assert.equal(manifest.catalogManifest.selected.filter(({ priority }) => priority === 'P2').length, 33);
      for (const source of manifest.scopeIdentity.files) {
        assert.ok(freeze.sourceFiles.some((entry) => entry.path === source.path && entry.sha256 === source.sha256), source.path);
      }
      for (const record of freeze.cases) {
        const point = manifest.catalogManifest.selected.find(({ id }) => id === record.businessPointId);
        assert.equal(record.pointRevision, point.revision);
        const checks = manifest.checks.filter(({ required, pointIds }) => required && pointIds.includes(point.id)).map(({ id }) => id).sort();
        assert.deepEqual([...record.requiredCheckIds].sort(), checks, record.caseId);
      }
      if (tier === 3) {
        const records = JSON.parse(execFileSync('git', ['show', `${freeze.sourceCommit}:apps/desktop/eval-scenarios/exploratory/desktop-business/cases.json`], { cwd: root, maxBuffer: 4 * 1024 * 1024 })).cases;
        const selectedCaseIds = [];
        for (const record of freeze.cases) {
          const branchChecks = new Set();
          for (const branch of [{ caseId: record.caseId, caseRevision: record.caseRevision }, ...record.requiredVariants]) {
            const original = records.find(({ id }) => id === branch.caseId);
            assert.ok(original, branch.caseId);
            assert.equal(original.businessPointId, record.businessPointId);
            assert.equal(original.caseRevision ?? 1, branch.caseRevision);
            assert.ok(['P0', 'P1', 'P2'].includes(original.priority));
            for (const checkId of original.checkIds) branchChecks.add(checkId);
            selectedCaseIds.push(branch.caseId);
          }
          for (const checkId of record.requiredCheckIds) assert.ok(branchChecks.has(checkId), `${record.caseId}/${checkId}`);
        }
        assert.equal(freeze.executionCaseCount, 76);
        assert.equal(new Set(selectedCaseIds).size, freeze.executionCaseCount);
        assert.deepEqual(freeze.cases.flatMap((record) => record.requiredVariants.map(({ caseId }) => caseId)).sort(), ['D4-RES-017', 'D6-PROJ-004']);
        assert.equal(freeze.excludedSamePointVariants.length, 12);
        for (const record of freeze.excludedSamePointVariants) assert.ok(!selectedCaseIds.includes(record.caseId));
      }
    }
  }
});
