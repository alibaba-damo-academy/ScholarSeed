import assert from 'node:assert/strict'
import test from 'node:test'

import type { LiteratureNote } from '../../contracts/literature'
import { NoteEditingSession, type NoteEditorOperations } from './editor.ts'
import { catalogue } from './catalog.ts'

const note = (id = 'note-a', text = 'Original', version = 1): LiteratureNote => ({
  id,
  title: 'Title',
  text,
  version,
  position: 0,
  created_at: 1,
  updated_at: version,
})

function editor(
  overrides: Partial<NoteEditorOperations> = {},
  onUnused?: () => void
): NoteEditingSession {
  return new NoteEditingSession(
    {
      create: async (draft) => ({ ...note(), ...draft }),
      update: async (id, draft) => ({ ...note(id), ...draft, version: draft.version + 1 }),
      remove: async () => {},
      changed: () => {},
      saveError: () => 'saveFailed',
      ...overrides,
    },
    onUnused
  )
}

test('failed saves preserve title and body when returning or switching notes', async () => {
  const session = editor({
    update: async () => {
      throw new Error('offline')
    },
  })
  await session.requestOpen(note())
  session.setTitle('Changed title')
  session.setText('Unsaved body')
  assert.equal(await session.requestClose(), false)
  assert.equal(await session.requestOpen(note('note-b')), false)
  assert.equal(session.getSnapshot().selectedId, 'note-a')
  assert.deepEqual(session.getSnapshot().draft, {
    title: 'Changed title',
    text: 'Unsaved body',
    version: 1,
  })
  assert.equal(session.getSnapshot().status, 'dirty')
  assert.equal(session.getSnapshot().errorCode, 'saveFailed')
})

test('title-only new drafts are created before returning', async () => {
  const created: Array<{ title: string; text: string }> = []
  const session = editor({
    create: async (draft) => {
      created.push(draft)
      return { ...note(), ...draft }
    },
  })
  await session.requestNew()
  session.setTitle('An important idea')
  assert.equal(await session.requestClose(), true)
  assert.deepEqual(created, [{ title: 'An important idea', text: '', version: 1 }])
  assert.equal(session.getSnapshot().draft, null)
})

test('body-only new drafts are created and become editable existing notes', async () => {
  let creates = 0
  let updates = 0
  const session = editor({
    create: async (draft) => {
      creates++
      return { ...note(), ...draft }
    },
    update: async (id, draft) => {
      updates++
      return { ...note(id), ...draft, version: draft.version + 1 }
    },
  })
  await session.requestNew()
  session.setText('A new idea')
  assert.equal(await session.flush(), true)
  assert.equal(session.getSnapshot().isNew, false)
  session.setText('')
  assert.equal(await session.requestClose(), true)
  assert.equal(creates, 1)
  assert.equal(updates, 1)
})

test('empty and whitespace-only new drafts do not create records or block returning', async () => {
  for (const value of ['', ' \n\t ']) {
    let creates = 0
    const session = editor({
      create: async () => {
        creates++
        return note()
      },
    })
    await session.requestNew()
    session.setTitle(value)
    session.setText(value)
    assert.equal(await session.flush(), true)
    assert.equal(session.getSnapshot().selectedId, null)
    assert.equal(session.getSnapshot().errorCode, null)
    assert.equal(await session.requestClose(), true)
    assert.equal(creates, 0)
  }
})

test('existing notes persist cleared fields before returning or switching', async () => {
  for (const draft of [
    { title: '', text: '' },
    { title: 'Title', text: '' },
    { title: '', text: 'Body' },
    { title: ' \t ', text: ' \n ' },
  ]) {
    const updates: Array<{ id: string; title: string; text: string; version: number }> = []
    const session = editor({
      update: async (id, updated) => {
        updates.push({ id, ...updated })
        return { ...note(id), ...updated, version: updated.version + 1 }
      },
    })
    await session.requestOpen(note())
    session.setTitle(draft.title)
    session.setText(draft.text)
    assert.equal(await session.flush(), true)
    assert.deepEqual(updates, [{ id: 'note-a', ...draft, version: 1 }])
    assert.equal(session.getSnapshot().draft?.version, 2)
    assert.equal(session.getSnapshot().status, 'saved')
    assert.equal(session.getSnapshot().errorCode, null)
    assert.equal(await session.requestOpen(note('note-b')), true)
    assert.equal(await session.requestClose(), true)
    assert.equal(updates.length, 1)
  }
})

test('failed empty updates keep the draft and recover on retry', async () => {
  let offline = true
  const session = editor({
    update: async (id, draft) => {
      if (offline) throw new Error('offline')
      return { ...note(id), ...draft, version: draft.version + 1 }
    },
  })
  await session.requestOpen(note())
  session.setTitle('')
  session.setText('')
  assert.equal(await session.requestClose(), false)
  assert.deepEqual(session.getSnapshot().draft, { title: '', text: '', version: 1 })
  assert.equal(session.getSnapshot().errorCode, 'saveFailed')
  assert.equal(session.getSnapshot().status, 'dirty')
  offline = false
  assert.equal(await session.flush(), true)
  assert.equal(await session.requestClose(), true)
})

test('cleared new drafts release on unmount without issuing a create request', async () => {
  let creates = 0
  const session = catalogue.noteEditor('empty-new-note', (unused) =>
    editor(
      {
        create: async () => {
          creates++
          return note()
        },
      },
      unused
    )
  )
  const detach = session.subscribe(() => {})
  await session.requestNew()
  session.setTitle('Transient')
  session.setText('Transient body')
  session.setTitle('')
  session.setText('')
  detach()
  await session.flush()
  assert.equal(creates, 0)
  assert.equal(catalogue.noteEditorSnapshot('empty-new-note'), null)
})

test('in-flight edits drain with the returned version and share one save across consumers', async () => {
  const calls: Array<{ text: string; version: number }> = []
  let finish!: (value: LiteratureNote) => void
  const session = editor({
    update: async (id, draft) => {
      calls.push({ text: draft.text, version: draft.version })
      if (calls.length === 1)
        return new Promise<LiteratureNote>((resolve) => {
          finish = resolve
        })
      return { ...note(id), ...draft, version: draft.version + 1 }
    },
  })
  const releaseFirst = session.subscribe(() => {})
  const releaseSecond = session.subscribe(() => {})
  await session.requestOpen(note())
  session.setText('First edit')
  const first = session.flush()
  session.setText('Second edit')
  const second = session.flush()
  releaseFirst()
  assert.equal(calls.length, 1)
  finish(note('note-a', 'First edit', 2))
  assert.deepEqual(await Promise.all([first, second]), [true, true])
  assert.deepEqual(calls, [
    { text: 'First edit', version: 1 },
    { text: 'Second edit', version: 2 },
  ])
  assert.equal(session.getSnapshot().draft?.text, 'Second edit')
  assert.equal(session.getSnapshot().draft?.version, 3)
  assert.equal(session.getSnapshot().status, 'saved')
  releaseSecond()
})

test('unmounted failed drafts survive and a successful retry releases an unused session', async () => {
  let offline = true
  let released = 0
  const session = editor(
    {
      update: async (id, draft) => {
        if (offline) throw new Error('offline')
        return { ...note(id), ...draft, version: 2 }
      },
    },
    () => {
      released++
    }
  )
  const detach = session.subscribe(() => {})
  await session.requestOpen(note())
  session.setText('Keep across panels')
  detach()
  assert.equal(await session.flush(), false)
  assert.equal(released, 0)
  const remount = session.subscribe(() => {})
  assert.equal(session.getSnapshot().draft?.text, 'Keep across panels')
  offline = false
  assert.equal(await session.flush(), true)
  assert.equal(released, 0)
  remount()
  await session.flush()
  assert.ok(released > 0)
})

test('confirmed deletion waits for an in-flight save and cannot resurrect the note', async () => {
  let finish!: (value: LiteratureNote) => void
  const operations: string[] = []
  const session = editor({
    update: async () =>
      new Promise<LiteratureNote>((resolve) => {
        finish = resolve
      }),
    remove: async (id) => {
      operations.push(id)
    },
  })
  await session.requestOpen(note())
  session.setText('Pending')
  const save = session.flush()
  const deletion = session.remove('note-a')
  session.setText('Must not revive deleted note')
  assert.equal(await session.remove('note-a'), false)
  assert.deepEqual(operations, [])
  finish(note('note-a', 'Pending', 2))
  await save
  assert.equal(await deletion, true)
  assert.deepEqual(operations, ['note-a'])
  assert.equal(session.getSnapshot().draft, null)
  assert.equal(session.getSnapshot().selectedId, null)
  assert.equal(await session.flush(), true)
})

test('failed delete keeps the draft and concurrent navigation resolves to the latest request', async () => {
  const session = editor({
    remove: async () => {
      throw new Error('offline')
    },
  })
  await session.requestOpen(note())
  session.setText('Keep this')
  assert.equal(await session.remove('note-a'), false)
  assert.equal(session.getSnapshot().draft?.text, 'Keep this')
  assert.equal(session.getSnapshot().errorCode, 'deleteFailed')
  const results = await Promise.all([
    session.requestOpen(note('note-b')),
    session.requestOpen(note('note-c')),
  ])
  assert.deepEqual(results, [false, true])
  assert.equal(session.getSnapshot().selectedId, 'note-c')
})

test('opening the same note after saving never restores the caller stale snapshot', async () => {
  const session = editor()
  const original = note()
  await session.requestOpen(original)
  session.setText('Latest text')
  assert.equal(await session.requestOpen(original), true)
  assert.equal(session.getSnapshot().draft?.text, 'Latest text')
  assert.equal(session.getSnapshot().draft?.version, 2)
})

test('catalogue retains one session per literature across scope changes and releases saved unused sessions', async () => {
  const create = (unused: () => void) => editor({}, unused)
  const first = catalogue.noteEditor('editor-paper-a', create)
  const firstRelease = first.subscribe(() => {})
  const second = catalogue.noteEditor('editor-paper-b', create)
  const secondRelease = second.subscribe(() => {})
  await first.requestOpen(note())
  await second.requestOpen(note('note-b'))
  first.setText('Paper A')
  second.setText('Paper B')
  catalogue.scope('another-scope')
  assert.equal(catalogue.noteEditor('editor-paper-a', create), first)
  assert.equal(catalogue.noteEditor('editor-paper-b', create), second)
  assert.notEqual(first, second)
  assert.equal(first.getSnapshot().draft?.text, 'Paper A')
  assert.equal(catalogue.noteEditorSnapshot('editor-paper-a'), first.getSnapshot())
  assert.equal(catalogue.noteEditorSnapshot('missing-paper'), null)
  assert.equal(second.getSnapshot().draft?.text, 'Paper B')
  firstRelease()
  await first.flush()
  const reopened = catalogue.noteEditor('editor-paper-a', create)
  assert.notEqual(reopened, first)
  const reopenedRelease = reopened.subscribe(() => {})
  assert.equal(catalogue.noteEditor('editor-paper-a', create), reopened)
  reopenedRelease()
  secondRelease()
  await second.flush()
  catalogue.scope(null)
})
