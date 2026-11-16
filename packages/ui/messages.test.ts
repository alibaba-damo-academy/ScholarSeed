import assert from 'node:assert/strict'
import test from 'node:test'
import { validationIssue } from './messages.ts'

test('upstream validation messages preserve rule identity and constraint values', () => {
  for (const [message, code] of [
    ['This field is required', 'required'], ['At least one option is required', 'choice'],
    ['Please enter a valid email', 'email'], ['Please enter a valid URL', 'url'], ['Must be a number', 'numeric'],
  ]) assert.deepEqual(validationIssue(message), { code })
  assert.deepEqual(validationIssue('Must be at least 3 characters'), { code: 'minLength', value: '3' })
  assert.deepEqual(validationIssue('Must be no more than 40 characters'), { code: 'maxLength', value: '40' })
  assert.deepEqual(validationIssue('Must be at least -1.5'), { code: 'min', value: '-1.5' })
  assert.deepEqual(validationIssue('Must be no more than 12'), { code: 'max', value: '12' })
  assert.equal(validationIssue('unknown failure'), undefined)
})
