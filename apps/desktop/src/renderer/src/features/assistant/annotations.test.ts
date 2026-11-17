import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { expressions } from '../../../../test-helpers/syntax.ts'

const source = readFileSync(new URL('./Annotations.tsx', import.meta.url), 'utf8')

test('annotations require an explicit remote image callback instead of enabling tools or thinking', () => {
  const root = ts.createSourceFile(
    'Annotations.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const declaration = root.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'AnnotatedAnswer'
  )
  assert.ok(declaration)
  const parameter = declaration.parameters[0].name
  assert.ok(ts.isObjectBindingPattern(parameter))
  const binding = parameter.elements.find(
    (element) => element.name.getText(root) === 'loadRemoteImage'
  )
  assert.ok(binding)
  assert.equal(binding.initializer, undefined)
  expressions(source)('loadRemoteImage', { attribute: 'loadRemoteImage' })
})

test('annotation hover uses the standard tooltip and disables it while editing', () => {
  const notes = readFileSync(new URL('./Notes.tsx', import.meta.url), 'utf8')
  const badge = notes.slice(
    notes.indexOf('export function AnnotationBadgeNote'),
    notes.indexOf('export interface AnnotationDisplay')
  )
  assert.match(badge, /<Tooltip\s+content=\{noteText\}/)
  assert.match(badge, /disabled=\{editOpen\}/)
  assert.doesNotMatch(badge, /HoverCard|NOTE_TOOLTIP_CLASS|NOTE_TOOLTIP_CONTENT_CLASS/)
  assert.match(badge, /<Popover open=\{editOpen\} onOpenChange=\{changeEditOpen\}>/)
})

test('inline annotation badges import their rendered component', () => {
  const notesImport = source.match(/import\s*{([^}]*)}\s*from '\.\/Notes'/)
  assert.ok(notesImport)
  assert.match(notesImport[1], /\bAnnotationBadgeNote\b/)
  assert.match(source, /<AnnotationBadgeNote\b/)
})

test('adding to conversation opens the same badge editor instead of a second input', () => {
  assert.match(source, /setEditingAnnotationId\(annotationId\)/)
  assert.match(
    source,
    /open=\{editingAnnotationId === annotation.annotation_id \? true : undefined\}/
  )
  assert.match(source, /if \(!open && editingAnnotationId === annotation.annotation_id\)/)
  assert.doesNotMatch(source, /<Input|<ArrowUp|saveAnnotation/)
  const notes = readFileSync(new URL('./Notes.tsx', import.meta.url), 'utf8')
  assert.match(notes, /const editOpen = open \?\? internalEditOpen/)
})

test('answer entrance animation releases its stacking context before the annotation toolbar is used', () => {
  const stream = readFileSync(
    new URL('../../components/business/Stream.tsx', import.meta.url),
    'utf8'
  )
  assert.match(stream, /animate-\[vds-answer-in_[^\]]+_backwards\]/)
  assert.doesNotMatch(stream, /animate-\[vds-answer-in_[^\]]+_both\]/)
  assert.match(source, /answer-selection-anchor[^`]+!z-\[var\(--vds-z-inline-flyout\)\]/)
})

test('annotation recall editor uses the design surface and an unframed five-line editable field', () => {
  const notes = readFileSync(new URL('./Notes.tsx', import.meta.url), 'utf8')
  const editor = notes.slice(
    notes.indexOf('function AnnotationCommentEditor'),
    notes.indexOf('export function AnnotationBadgeNote')
  )
  assert.match(notes, /!w-\[var\(--vds-answer-annotation-editor-width\)\]/)
  assert.match(notes, /!shadow-\[var\(--vds-shadow-aidialog-2\)\]/)
  assert.match(editor, /\[field-sizing:content\]/)
  assert.match(editor, /vds-answer-annotation-editor-max-height/)
  assert.match(editor, /text-\[length:var\(--vds-font-body-lv2\)\]/)
  assert.match(editor, /rows=\{2\}/)
  assert.doesNotMatch(editor, /focus-visible:border-/)
  assert.match(editor, /variant="tertiary"/)
  assert.match(editor, /data-testid="annotation-editor-fade"/)
  assert.match(editor, /autoFocus/)
  assert.match(editor, /placeholder=\{t\('remaining.optionalComment'\)\}/)
})
