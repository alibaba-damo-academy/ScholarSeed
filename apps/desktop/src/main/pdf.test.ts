import assert from 'node:assert/strict'
import test from 'node:test'

import { createPdfViewerPolicy } from './pdf.ts'

const DOCUMENT = 'https://example.com/document'
const VIEWER = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai'
type Request = Parameters<ReturnType<typeof createPdfViewerPolicy>['allows']>[0]
type Response = Parameters<ReturnType<typeof createPdfViewerPolicy>['response']>[0]
type Frame = NonNullable<Request['frame']>

function fixture() {
  const top: Frame = { url: DOCUMENT, frameTreeNodeId: 1, detached: false, parent: null, top: null }
  top.top = top
  const child: Frame = { url: 'about:blank', frameTreeNodeId: 2, detached: false, parent: top, top }
  const policy = createPdfViewerPolicy()
  const response = {
    url: DOCUMENT,
    method: 'GET',
    resourceType: 'mainFrame',
    frame: top,
    statusCode: 200,
    responseHeaders: { 'Content-Type': ['application/pdf; charset=binary'] },
  }
  const stylesheet = {
    url: `${VIEWER}/pdf_embedder.css`,
    method: 'GET',
    resourceType: 'stylesheet',
    frame: top,
  }
  const viewer = {
    url: `${VIEWER}/index.html`,
    method: 'GET',
    resourceType: 'subFrame',
    frame: child,
  }
  return { policy, top, child, response, stylesheet, viewer }
}

test('PDF capability follows the response MIME, not a URL suffix', () => {
  const { policy, response, stylesheet, viewer, child } = fixture()
  assert.equal(policy.allows(stylesheet), false)
  policy.response(response)
  assert.equal(policy.allows(stylesheet), true)
  assert.equal(policy.allows(viewer), true)
  child.url = viewer.url
  assert.equal(policy.allows({ ...viewer, resourceType: 'script', url: `${VIEWER}/main.js` }), true)
  assert.equal(
    policy.allows({
      ...viewer,
      resourceType: 'script',
      url: 'chrome://resources/js/load_time_data.js',
    }),
    true
  )
  assert.equal(policy.allows({ ...viewer, resourceType: 'xhr', url: DOCUMENT }), true)
  assert.equal(policy.viewerFailure(stylesheet), true)
})

test('non-PDF, unsuccessful, attachment and subframe responses cannot authorize the viewer', () => {
  const cases: Partial<Response>[] = [
    { responseHeaders: { 'content-type': ['text/html'] } },
    {
      responseHeaders: {
        'content-type': ['application/pdf'],
        'content-disposition': ['Attachment; filename=a.pdf'],
      },
    },
    { statusCode: 302 },
    { statusCode: 404 },
    { resourceType: 'subFrame' },
    { frame: null },
    { url: 'file:///tmp/a.pdf' },
    { url: 'invalid' },
  ]
  for (const overrides of cases) {
    const { policy, response, stylesheet, viewer } = fixture()
    policy.response({ ...response, ...overrides })
    assert.equal(policy.allows(stylesheet), false)
    assert.equal(policy.allows(viewer), false)
  }
})

test('viewer resources require the exact document and its direct viewer frame', () => {
  const { policy, response, stylesheet, viewer, child, top } = fixture()
  policy.response(response)
  for (const request of [
    { ...viewer, resourceType: 'mainFrame' },
    { ...viewer, method: 'POST' },
    { ...viewer, frame: null },
    { ...stylesheet, url: `${VIEWER}.example/pdf_embedder.css` },
    { ...stylesheet, url: 'chrome-extension://another-extension/pdf_embedder.css' },
    { ...stylesheet, url: `${VIEWER}/main.js`, resourceType: 'script' },
    { ...viewer, url: `${VIEWER}/main.js` },
    { ...viewer, frame: { ...child, top: { ...top, frameTreeNodeId: 99 } } },
    { ...viewer, frame: { ...child, parent: null } },
    { ...viewer, frame: { ...child, detached: true } },
    { ...viewer, frame: { ...child, top: null } },
  ])
    assert.equal(policy.allows(request), false)
  const script = { ...viewer, resourceType: 'script', url: `${VIEWER}/main.js` }
  assert.equal(policy.allows(script), false)
  child.url = viewer.url
  assert.equal(policy.allows(script), true)
  for (const url of [
    'http://127.0.0.1/private',
    `${DOCUMENT}/other`,
    'file:///tmp/a',
    'chrome://settings',
    'https://another.example/',
  ])
    assert.equal(policy.allows({ ...script, url }), false)
  top.url = `${DOCUMENT}#page=2`
  assert.equal(policy.allows(script), true)
  top.url = `${DOCUMENT}?different`
  assert.equal(policy.allows(script), false)
  assert.equal(policy.viewerFailure(script), false)
})

test('new navigations and non-PDF responses revoke old PDF capabilities', () => {
  const { policy, response, stylesheet } = fixture()
  policy.response(response)
  policy.reset()
  assert.equal(policy.allows(stylesheet), false)
  assert.equal(policy.viewerFailure(stylesheet), false)
  policy.response(response)
  policy.response({ ...response, responseHeaders: { 'content-type': ['text/html'] } })
  assert.equal(policy.allows(stylesheet), false)
})
