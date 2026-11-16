import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { block } from '../../../../test-helpers/source-contract.ts'
import { listLiteratureCollections, type LibraryCollection } from '../literature/api.ts'

const host = readFileSync(new URL('./Artifacts.tsx', import.meta.url), 'utf8')
const view = readFileSync(
  new URL('../../components/business/Artifact.tsx', import.meta.url),
  'utf8'
)
const source = host + '\n' + view
const receipt = readFileSync(
  new URL('../../components/primitive/Receipt.tsx', import.meta.url),
  'utf8'
)
const zh = JSON.parse(
  readFileSync(
    new URL('../../../../localization/locales/zh/assistant.json', import.meta.url),
    'utf8'
  )
)
const en = JSON.parse(
  readFileSync(
    new URL('../../../../localization/locales/en/assistant.json', import.meta.url),
    'utf8'
  )
)

test('artifact host wires the shared view without moving integrity or file operations into the UI package', () => {
  assert.match(
    host,
    /import\s+\{\s*Artifact,\s*ArtifactGroup,\s*ArtifactMenuItems,\s*MENU_CLASS_NAME,?\s*\}\s+from\s+['"].*Artifact['"]/
  )
  assert.match(host, /artifactVersionGroups\(items\)[\s\S]*groupArtifacts\(versions\)/)
  assert.match(host, /<ArtifactGroup key=\{key\}>[\s\S]*<ArtifactEntry/)
  for (const callback of ['preview', 'previewVersion', 'openImport'])
    assert.ok(host.includes(callback + '={' + callback + '}'))
  assert.match(host, /expectedSha256: currentSha256/)
  assert.match(host, /fetchArtifactSha256\(thread.sessionId, primary.artifact_id\)/)
  assert.doesNotMatch(view, /from ['"].*\/(?:api|store|fileOpen)['"]|window\.scholarseed/)
})

test('artifact host shares image eligibility with the gallery grouping', () => {
  assert.match(host, /groupArtifacts\(versions\)/)
  assert.match(host, /block.kind === 'images' && thread.sessionId/)
  assert.match(host, /<GeneratedImageGallery/)
})

test('artifact filename tooltip contains the full filename without repeating its path', () => {
  assert.match(view, /titleTooltip=\{primary.name\}/)
  assert.doesNotMatch(view, /titleTooltip=\{[^\n]*primary.path/)
  const receipt = readFileSync(
    new URL('../../components/primitive/Receipt.tsx', import.meta.url),
    'utf8'
  )
  assert.match(receipt, /tooltip=\{titleTooltip \?\?/)
  assert.match(receipt, /tooltipContentClassName="whitespace-pre-wrap"/)
})
test('image batches retain artifact actions and bind viewer menus to the selected revision', () => {
  assert.match(host, /<GeneratedImageGallery/)
  assert.match(host, /key=\{artifact.artifact_id \+ ':' \+ artifact.sha256\}/)
  assert.match(host, /primary=\{artifact\}[\s\S]*mode=\{preview \? 'preview' : 'actions'\}/)
  assert.match(host, /\{feedback\}[\s\S]*<\/DropdownMenuContent>/)
  assert.match(host, /const feedback =/)
})

test('PDF artifacts use the ordinary file receipt without an inline first-page preview', () => {
  assert.doesNotMatch(host, /GeneratedPdf/)
  assert.match(view, /<Receipt[\s\S]*onOpen=\{\(\) => preview\(primary\)\}/)
})

test('artifact import uses the inline collection list with the selected ID and retry', () => {
  assert.match(
    source,
    /<LiteratureCollections[\s\S]*?value=\{literatureCollection\}[\s\S]*?onValueChange=\{setLiteratureCollection\}/
  )
  assert.match(source, /onRetry=\{\(\) => void openLiteratureImport\(\)\}/)
})

for (const imported of [true, false]) {
  test(`artifact import invalidates both literature caches only on success: ${imported}`, async () => {
    let invalidated = 0
    let submitted: unknown[] = []
    const implementation = stripTypeScriptTypes(
      block(source, '  const saveLiterature = ', '  const openLiteratureImport = ')
    )
    const save = Function(
      'thread',
      'sessionProject',
      'savingLiterature',
      'literatureCollections',
      'setSavingLiterature',
      'setLiteratureError',
      'fetchArtifactSha256',
      'primary',
      'importArtifactToLiterature',
      'literatureCollection',
      'importError',
      'act',
      'setDialogOpen',
      `${implementation}; return saveLiterature`
    )(
      { sessionId: 'session' },
      { id: 'project' },
      false,
      [],
      () => {},
      () => {},
      async () => 'digest',
      { artifact_id: 'artifact' },
      async (...args: unknown[]) => {
        submitted = args
        return { ok: imported, error: 'failed' }
      },
      'global-id',
      () => ({}),
      {
        invalidateLiterature: () => {
          invalidated += 1
        },
        reloadArtifactLinks: async () => ({ ok: true }),
      },
      () => {}
    )
    await save()
    assert.deepEqual(submitted, ['session', 'artifact', 'digest', 'global-id'])
    assert.equal(invalidated, imported ? 1 : 0)
  })
}

test('artifact action labels remain available in both interface languages', () => {
  for (const catalog of [zh, en]) {
    for (const key of [
      'import',
      'importShort',
      'openWith',
      'saveAs',
      'copyPath',
      'revealInFinder',
      'revealInFileManager',
    ]) {
      assert.equal(typeof catalog.artifactEntry[key], 'string')
      assert.ok(catalog.artifactEntry[key].length > 0)
    }
  }
})

for (const scenario of ['available', 'global-only', 'project-only', 'empty', 'failed'] as const) {
  test(`artifact import loads global and project collections: ${scenario}`, async (context) => {
    const previousWindow = globalThis.window
    const previousFetch = globalThis.fetch
    const requests: URL[] = []
    const projectId = 'project with spaces'
    const collections = [
      { id: 'global-a', name: 'Research', project_id: null },
      { id: 'project-a', name: 'Research', project_id: projectId },
    ]
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        location: { href: 'http://desktop.test/' },
        scholarseed: { getApiBase: () => 'http://service.test' },
      },
    })
    context.after(() => {
      globalThis.fetch = previousFetch
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        writable: true,
        value: previousWindow,
      })
    })
    globalThis.fetch = async (input) => {
      const url = new URL(String(input))
      requests.push(url)
      assert.equal(url.pathname, '/api/v1/collections')
      const project = url.searchParams.get('project_id')
      const available = collections.filter((collection) => collection.project_id === project)
      const empty =
        scenario === 'empty' ||
        (scenario === 'global-only' && project) ||
        (scenario === 'project-only' && !project)
      return scenario === 'failed' && !project
        ? Response.json({ detail: 'unavailable' }, { status: 503 })
        : Response.json(empty ? [] : available)
    }
    const state = {
      destination: 'resources',
      selected: 'previous',
      collections: [] as LibraryCollection[] | null,
      error: null as { key: string } | null,
    }
    const implementation = stripTypeScriptTypes(
      block(source, '  const openLiteratureImport = ', '  /* 副标题')
    )
    const open = Function(
      'sessionProject',
      'savingLiterature',
      'listLiteratureCollections',
      'setDestination',
      'setLiteratureError',
      'setLiteratureCollection',
      'setLiteratureCollections',
      `${implementation}; return openLiteratureImport`
    )(
      { id: projectId },
      false,
      listLiteratureCollections,
      (value: string) => {
        state.destination = value
      },
      (value: { key: string } | null) => {
        state.error = value
      },
      (value: string) => {
        state.selected = value
      },
      (value: LibraryCollection[] | null) => {
        state.collections = value
      }
    )
    const loading = open()
    assert.equal(state.collections, null)
    assert.equal(state.selected, '')
    await loading
    assert.equal(state.destination, 'literature')
    assert.deepEqual(
      state.collections,
      scenario === 'failed'
        ? null
        : scenario === 'empty'
          ? []
          : collections.filter((collection) =>
              scenario === 'global-only'
                ? !collection.project_id
                : scenario === 'project-only'
                  ? Boolean(collection.project_id)
                  : true
            )
    )
    assert.deepEqual(
      state.error,
      scenario === 'failed' ? { key: 'artifactEntry.collectionsFailed' } : null
    )
    assert.deepEqual(
      requests.map((request) => request.pathname),
      ['/api/v1/collections', '/api/v1/collections']
    )
    assert.equal(requests[0].searchParams.get('project_id'), null)
    assert.equal(requests[1].searchParams.get('project_id'), projectId)
  })
}
