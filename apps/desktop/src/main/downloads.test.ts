import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  canPublishDownload,
  createDownloadPreferences,
  createDownloadStage,
  discardDownloadStage,
  downloadSourceAllowed,
  findPendingDownloadStages,
  publishDownload,
  safeDownloadName,
} from './downloads.ts'

test('download names cannot supply paths, controls, or Windows device names', () => {
  assert.equal(safeDownloadName('..\\..\\secret.txt'), 'secret.txt')
  assert.equal(safeDownloadName('../../report\u0000.txt'), 'report.txt')
  assert.equal(safeDownloadName('CON.txt'), 'download')
  assert.equal(safeDownloadName(''), 'download')
})

test(
  'macOS download capability probe disables Python bytecode writes',
  { skip: process.platform !== 'darwin' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'browser-download-bytecode-'))
    try {
      const python = join(root, 'python-probe')
      writeFileSync(
        python,
        '#!/bin/sh\nfor argument do\n  if [ "$argument" = "-B" ]; then exit 0; fi\ndone\nexit 1\n'
      )
      chmodSync(python, 0o755)
      assert.equal(canPublishDownload(python, root, root), true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test('download source policy permits same-origin local and public HTTP(S), not private or opaque origins', () => {
  assert.equal(
    downloadSourceAllowed(
      ['http://127.0.0.1:3000/export'],
      'http://127.0.0.1:3000/page',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3000'
    ),
    true
  )
  assert.equal(
    downloadSourceAllowed(
      ['http://127.0.0.1:3001/export'],
      'http://127.0.0.1:3000/page',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3000'
    ),
    false
  )
  assert.equal(
    downloadSourceAllowed(
      ['https://example.org/export'],
      'http://127.0.0.1:3000/page',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3000'
    ),
    false
  )
  assert.equal(
    downloadSourceAllowed(
      ['https://example.org/file', 'https://cdn.example.org/file'],
      'https://example.org/page',
      null,
      'http://127.0.0.1:3000'
    ),
    true
  )
  assert.equal(
    downloadSourceAllowed(
      ['https://example.org/file', 'http://127.0.0.1:3000/secret'],
      'https://example.org/page',
      null,
      'http://127.0.0.1:3000'
    ),
    false
  )
  assert.equal(
    downloadSourceAllowed(
      ['blob:https://example.org/id', 'blob:https://example.org/id'],
      'https://example.org/page',
      null,
      null
    ),
    true
  )
  assert.equal(
    downloadSourceAllowed(
      ['blob:http://127.0.0.1:3000/id'],
      'http://127.0.0.1:3000/page',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3000'
    ),
    true
  )
  assert.equal(
    downloadSourceAllowed(
      ['blob:http://127.0.0.1:3001/id'],
      'http://127.0.0.1:3000/page',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3000'
    ),
    false
  )
  assert.equal(
    downloadSourceAllowed(
      ['blob:https://other.example/id'],
      'https://example.org/page',
      null,
      null
    ),
    false
  )
  assert.equal(
    downloadSourceAllowed(
      ['blob:https://example.org/id', 'https://example.org/file'],
      'https://example.org/page',
      null,
      null
    ),
    false
  )
  assert.equal(
    downloadSourceAllowed(
      ['blob:https://example.org/id', 'blob:https://example.org/other'],
      'https://example.org/page',
      null,
      null
    ),
    false
  )
  assert.equal(
    downloadSourceAllowed(['blob:null/id'], 'https://example.org/page', null, null),
    false
  )
  assert.equal(
    downloadSourceAllowed(['blob:file:///tmp/file'], 'https://example.org/page', null, null),
    false
  )
  assert.equal(
    downloadSourceAllowed(['data:text/plain,payload'], 'https://example.org/page', null, null),
    false
  )
  assert.equal(
    downloadSourceAllowed(['https://example.org/file'], 'about:blank', null, null),
    false
  )
})

test('download directory preference persists and can be reset without accepting renderer paths', () => {
  const home = mkdtempSync(join(tmpdir(), 'browser-download-prefs-'))
  try {
    const defaultDirectory = join(home, 'default')
    const chosenDirectory = join(home, 'chosen')
    mkdirSync(defaultDirectory)
    mkdirSync(chosenDirectory)
    const first = createDownloadPreferences(home, defaultDirectory, true)
    assert.deepEqual(first.snapshot(), {
      directory: defaultDirectory,
      isDefault: true,
      directoryAvailable: true,
      askEveryTime: true,
      automaticAvailable: true,
    })
    first.select(chosenDirectory)
    assert.deepEqual(createDownloadPreferences(home, defaultDirectory, true).snapshot(), {
      directory: chosenDirectory,
      isDefault: false,
      directoryAvailable: true,
      askEveryTime: true,
      automaticAvailable: true,
    })
    first.setAskEveryTime(false)
    assert.equal(
      createDownloadPreferences(home, defaultDirectory, true).snapshot().askEveryTime,
      false
    )
    first.setAskEveryTime(true)
    assert.equal(
      createDownloadPreferences(home, defaultDirectory, true).snapshot().askEveryTime,
      true
    )
    rmSync(chosenDirectory, { recursive: true })
    assert.equal(first.snapshot().directoryAvailable, false)
    first.reset()
    assert.deepEqual(createDownloadPreferences(home, defaultDirectory, true).snapshot(), {
      directory: defaultDirectory,
      isDefault: true,
      directoryAvailable: true,
      askEveryTime: true,
      automaticAvailable: true,
    })
    assert.equal(
      readFileSync(join(home, 'downloads.json'), 'utf8').includes(chosenDirectory),
      false
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('automatic preference follows current directory capability and fails closed after a change', () => {
  const home = mkdtempSync(join(tmpdir(), 'browser-download-capability-'))
  try {
    const firstDirectory = join(home, 'first')
    const otherDirectory = join(home, 'other')
    mkdirSync(firstDirectory)
    mkdirSync(otherDirectory)
    let capable = true
    const settings = createDownloadPreferences(
      home,
      firstDirectory,
      true,
      (directory) => directory === firstDirectory && capable
    )
    settings.setAskEveryTime(false)
    assert.equal(settings.snapshot().askEveryTime, false)
    settings.select(otherDirectory)
    assert.equal(settings.snapshot().automaticAvailable, false)
    assert.equal(settings.snapshot().askEveryTime, true)
    assert.equal(settings.canAutomaticallySave(), false)
    assert.throws(() => settings.setAskEveryTime(false), /automatic_download_unavailable/)
    settings.reset()
    capable = false
    assert.equal(settings.canAutomaticallySave(), false)
    assert.equal(settings.snapshot().askEveryTime, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('failed preference writes leave the current directory unchanged', () => {
  const home = mkdtempSync(join(tmpdir(), 'browser-download-write-'))
  const defaultDirectory = join(home, 'default')
  const chosenDirectory = join(home, 'chosen')
  mkdirSync(defaultDirectory)
  mkdirSync(chosenDirectory)
  const settings = createDownloadPreferences(home, defaultDirectory)
  rmSync(home, { recursive: true })
  assert.throws(() => settings.select(chosenDirectory))
  assert.equal(settings.snapshot().directory, defaultDirectory)
})

test('pre-existing temporary hard link cannot redirect preference writes', () => {
  const home = mkdtempSync(join(tmpdir(), 'browser-download-symlink-'))
  try {
    const victim = join(home, 'victim.txt')
    writeFileSync(victim, 'safe')
    linkSync(victim, join(home, 'downloads.json.tmp'))
    const settings = createDownloadPreferences(home, home)
    settings.select(home)
    assert.equal(readFileSync(victim, 'utf8'), 'safe')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test(
  'automatic publication never overwrites and rejects symlinked destination parents',
  { skip: process.platform !== 'darwin' },
  async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'browser-download-publish-')))
    const python = join(process.cwd(), '..', '..', '.venv', 'bin', 'python')
    try {
      const stage = createDownloadStage(home, 'report.txt')
      const target = join(home, 'target')
      mkdirSync(target)
      writeFileSync(stage.path, 'new')
      const stagedInode = statSync(stage.path).ino
      writeFileSync(join(target, 'report.txt'), 'old')
      assert.equal(
        await publishDownload(python, stage.path, target, 'report.txt'),
        join(target, 'report (1).txt')
      )
      assert.equal(readFileSync(join(target, 'report.txt'), 'utf8'), 'old')
      assert.equal(readFileSync(join(target, 'report (1).txt'), 'utf8'), 'new')
      assert.notEqual(statSync(join(target, 'report (1).txt')).ino, stagedInode)
      assert.deepEqual(readdirSync(target).sort(), ['report (1).txt', 'report.txt'])
      discardDownloadStage(stage, python)
      const outside = join(home, 'outside')
      mkdirSync(outside)
      symlinkSync(outside, join(home, 'link'))
      const rejected = createDownloadStage(home, 'report.txt')
      writeFileSync(rejected.path, 'blocked')
      await assert.rejects(publishDownload(python, rejected.path, join(home, 'link'), 'report.txt'))
      assert.equal(readFileSync(rejected.path, 'utf8'), 'blocked')
      assert.deepEqual(readdirSync(target).sort(), ['report (1).txt', 'report.txt'])
      discardDownloadStage(rejected, python)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
)

test(
  'clone capability probe verifies the selected directory without leaving files',
  { skip: process.platform !== 'darwin' },
  () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'browser-download-probe-')))
    const python = join(process.cwd(), '..', '..', '.venv', 'bin', 'python')
    try {
      const target = join(home, 'target')
      mkdirSync(target)
      assert.equal(canPublishDownload(python, home, target), true)
      assert.deepEqual(readdirSync(home), ['target'])
      assert.deepEqual(readdirSync(target), [])
      assert.equal(canPublishDownload(python, home, home), true)
      assert.deepEqual(readdirSync(home), ['target'])
      const linked = join(home, 'linked')
      symlinkSync(target, linked)
      assert.equal(canPublishDownload(python, home, linked), false)
      assert.deepEqual(readdirSync(target), [])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
)

test(
  'stage cleanup cannot follow a replaced stage directory symlink',
  { skip: process.platform !== 'darwin' },
  () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'browser-download-cleanup-')))
    const python = join(process.cwd(), '..', '..', '.venv', 'bin', 'python')
    try {
      const stage = createDownloadStage(home, 'report.txt')
      const outside = join(home, 'outside')
      mkdirSync(outside)
      writeFileSync(join(outside, 'report.txt'), 'valuable')
      rmSync(stage.directory, { recursive: true })
      symlinkSync(outside, stage.directory)
      assert.throws(() => discardDownloadStage(stage, python), /staged_download_cleanup_failed/)
      assert.equal(readFileSync(join(outside, 'report.txt'), 'utf8'), 'valuable')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
)

test('stage cleanup rejects a forged leaf name', { skip: process.platform !== 'darwin' }, () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'browser-download-cleanup-leaf-')))
  const python = join(process.cwd(), '..', '..', '.venv', 'bin', 'python')
  try {
    const stage = createDownloadStage(home, 'report.txt')
    writeFileSync(stage.path, 'download')
    const victim = join(home, 'victim.txt')
    writeFileSync(victim, 'valuable')
    assert.throws(
      () => discardDownloadStage({ ...stage, filename: '../victim.txt' }, python),
      /staged_download_cleanup_failed/
    )
    assert.equal(readFileSync(victim, 'utf8'), 'valuable')
    discardDownloadStage(stage, python)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('startup scanning retains an active partial download while recovering only completed files', () => {
  const home = mkdtempSync(join(tmpdir(), 'browser-download-recovery-'))
  try {
    const completed = createDownloadStage(home, 'report.txt')
    writeFileSync(completed.path, 'complete')
    const interrupted = createDownloadStage(home, 'partial.txt')
    writeFileSync(`${interrupted.path}.crdownload`, 'partial')
    const outside = join(home, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'report.txt'), 'outside')
    symlinkSync(outside, join(home, 'download-symlink'))

    const alerts: string[] = []
    assert.deepEqual(
      findPendingDownloadStages(home, (path) => alerts.push(path)),
      [completed]
    )
    assert.equal(readFileSync(`${interrupted.path}.crdownload`, 'utf8'), 'partial')
    assert.deepEqual(alerts.sort(), [interrupted.directory, join(home, 'download-symlink')].sort())
    assert.equal(readFileSync(join(outside, 'report.txt'), 'utf8'), 'outside')
    assert.equal(existsSync(join(home, 'download-symlink')), true)
    assert.equal(readFileSync(completed.path, 'utf8'), 'complete')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('startup leaves empty or suspicious stage directories untouched and reports them', () => {
  const home = mkdtempSync(join(tmpdir(), 'browser-download-suspicious-'))
  try {
    const empty = join(home, 'download-empty')
    mkdirSync(empty)
    const suspicious = join(home, 'download-suspicious')
    mkdirSync(suspicious)
    writeFileSync(join(suspicious, 'unknown'), 'retain')
    const alerts: string[] = []
    findPendingDownloadStages(home, (path) => alerts.push(path))
    assert.equal(existsSync(empty), true)
    assert.equal(readFileSync(join(suspicious, 'unknown'), 'utf8'), 'retain')
    assert.deepEqual(alerts.sort(), [empty, suspicious].sort())
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test(
  'failed publication preserves completed stage until explicitly discarded',
  { skip: process.platform !== 'darwin' },
  async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'browser-download-retain-')))
    const python = join(process.cwd(), '..', '..', '.venv', 'bin', 'python')
    try {
      const staged = createDownloadStage(home, 'report.txt')
      writeFileSync(staged.path, 'valuable')
      await assert.rejects(
        publishDownload(python, staged.path, join(home, 'missing'), staged.filename)
      )
      assert.equal(
        JSON.parse(readFileSync(join(staged.directory, 'manifest.json'), 'utf8'))
          .publicationAttempted,
        true
      )
      const recoveredTarget = join(home, 'recovered')
      mkdirSync(recoveredTarget)
      await assert.rejects(
        publishDownload(python, staged.path, recoveredTarget, staged.filename),
        /publication_outcome_unknown/
      )
      assert.deepEqual(readdirSync(recoveredTarget), [])
      assert.deepEqual(findPendingDownloadStages(home), [{ ...staged, publicationAttempted: true }])
      assert.equal(readFileSync(staged.path, 'utf8'), 'valuable')
      discardDownloadStage(staged, python)
      assert.equal(existsSync(staged.directory), false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
)
