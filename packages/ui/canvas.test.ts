import assert from 'node:assert/strict'
import test from 'node:test'
import { canvasInteractive, canvasValues } from './canvas.ts'

test('OpenUI submission removes field wrappers without dropping empty values or nested forms', () => {
  assert.deepEqual(canvasValues({
    name: { value: '', componentType: 'Input' },
    form: { selected: { value: false, componentType: 'CheckBoxGroup' } },
    count: 0,
    restored: { value: 'JSON-persisted field' },
    ids: [],
    $remark: 'local binding',
  }, {}), { name: '', form: { selected: false }, count: 0, restored: 'JSON-persisted field', ids: [] })
})

test('OpenUI bindings submit current values under field names, not local variable names', () => {
  assert.deepEqual(canvasValues({$remark:'当前值',$unused:42,metadata:{value:{$schema:'retained'}}}, {remark:'$remark'}), {remark:'当前值',metadata:{$schema:'retained'}})
})

test('display canvases do not enter a user-decision lifecycle', () => {
  assert.equal(canvasInteractive({ format: 'html', version: 1, source: '<main>Read only</main>' }), false)
  assert.equal(canvasInteractive({ format: 'openui-lang', version: 1, source: 'root = Stack([])', interaction: { actions: ['submit'] } }), true)
})
