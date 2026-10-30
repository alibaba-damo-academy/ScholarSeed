import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const CHILD_TIMEOUT_MS = 30_000
const ROOT = fileURLToPath(new URL('../', import.meta.url))

test('empty project center does not load unrelated reviewed documents; required sample failures remain strict and retryable', () => {
  const preload = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.readFileSync;
    globalThis.reviewedReads = 0;
    fs.readFileSync = function(path, ...options) {
      if (String(path).replaceAll(String.fromCharCode(92), '/').includes('/e2e/fixtures/')) {
        globalThis.reviewedReads++;
        throw new Error('blocked-reviewed-fixture');
      }
      return original.call(this, path, ...options);
    };
    syncBuiltinESMExports();
    globalThis.restoreReviewedReads = () => { fs.readFileSync = original; syncBuiltinESMExports(); };
  `
  const source = `
    import assert from 'node:assert/strict';
    import { once } from 'node:events';
    import { createServer } from 'node:http';
    import { createPreviewService } from './preview/service.ts';
    import { PreviewFiles } from './preview/files.ts';
    const service = createPreviewService();
    const server = createServer((request, response) => service.middleware(request, response, () => response.writeHead(404).end()));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const origin = 'http://127.0.0.1:' + server.address().port;
      const empty = await fetch(origin + '/__preview/state?previewInstance=sample-loading&scene=home-empty&page=page-home');
      assert.equal(empty.status, 200);
      const state = await empty.json();
      assert.equal(state.projects.length, 0);
      assert.equal(state.sessions.length, 0);
      assert.equal(globalThis.reviewedReads, 0);
      assert.throws(() => new PreviewFiles(), /blocked-reviewed-fixture/);
      assert.ok(globalThis.reviewedReads > 0);
      globalThis.restoreReviewedReads();
      const recovered = new PreviewFiles();
      assert.ok(recovered.manifest().length > 0);
      const ordinary = await fetch(origin + '/__preview/reset?previewInstance=sample-loading', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pageId: 'page-home', scene: 'home-states' }),
      });
      assert.equal(ordinary.status, 200);
      assert.equal((await ordinary.json()).projects.length, 1);
    } finally {
      service.dispose();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  `
  const child = spawnSync(process.execPath, ['--experimental-transform-types', '--import', 'data:text/javascript,' + encodeURIComponent(preload), '--input-type=module', '--eval', source], {
    cwd: ROOT, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS,
  })
  assert.ifError(child.error)
  assert.equal(child.status, 0, child.stderr + child.stdout)
})
