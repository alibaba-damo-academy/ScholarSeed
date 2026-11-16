import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDocuments } from '../structure-core.mjs';

const adapter = fileURLToPath(new URL('../structure.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../structure-check.mjs', import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), 'docs-structure-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false);
});
mkdirSync(path.join(root, 'docs'));
writeFileSync(path.join(root, 'docs/a.md'), '# A\n');
function invoke(input) {
  return spawnSync(process.execPath, [adapter], { input: JSON.stringify(input), encoding: 'utf8' });
}
test('complete stdin receipt for long logical lists', () => {
  const paths = Array.from({ length: 2000 }, (_, index) => `docs/${index}.md`);
  const result = invoke({ schemaVersion: 1, root, paths });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).paths, paths);
});
test('valid input returns complete successful receipt', () => {
  const result = invoke({ schemaVersion: 1, root, paths: ['docs/a.md'] });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { schemaVersion: 1, paths: ['docs/a.md'], errors: [] });
});
test('malformed or duplicate paths reject', () => {
  for (const paths of [[], ['docs/a.md', 'docs/a.md'], [42], ['../outside.md']]) {
    assert.notEqual(invoke({ schemaVersion: 1, root, paths }).status, 0);
  }
});
test('repository structure CLI validates explicit paths without Skill entrypoints', () => {
  const valid = spawnSync(process.execPath, [cli, 'docs/architecture/ops-cli.md'], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), { paths: ['docs/architecture/ops-cli.md'], errors: [] });
  const invalid = spawnSync(process.execPath, [cli, '../outside.md'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Usage/);
});
test('public entry points preserve the same structural errors without a private Skill', () => {
  writeFileSync(path.join(root, 'docs/b.md'), '# B\n[missing](missing.md)\n');
  const paths = ['docs/a.md', 'docs/b.md'];
  const errors = checkDocuments(root, paths);
  assert.deepEqual(errors, ['docs/b.md: missing link missing.md']);
  assert.deepEqual(JSON.parse(invoke({ schemaVersion: 1, root, paths }).stdout).errors, errors);
  const result = spawnSync(process.execPath, [cli, '--root', root, ...paths], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).errors, errors);
});
