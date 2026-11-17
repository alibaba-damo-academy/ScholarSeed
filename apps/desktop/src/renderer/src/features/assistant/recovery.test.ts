import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance } from 'i18next'

import zh from '../../../../localization/locales/zh/assistant.json' with { type: 'json' }
import en from '../../../../localization/locales/en/assistant.json' with { type: 'json' }
import {
  searchRecovery,
  fileRecovery,
  saveRecovery,
  externalReadAuthorization,
} from './recovery.ts'

const question = {
  id: 'search-recovery:request',
  header: 'search_failed',
  question: 'original query',
  options: [
    { label: 'retry_search', description: 'provider_unavailable' },
    { label: 'dismiss_search' },
  ],
}

test('external file approval shows the exact file, read scope and stable decisions', async () => {
  const localization = createInstance()
  await localization.init({
    lng: 'zh',
    interpolation: { escapeValue: false },
    resources: { zh: { assistant: zh }, en: { assistant: en } },
  })
  const request = {
    id: 'external-read:request',
    header: 'external_file_read',
    question: '/Users/example/report.txt',
    options: [{ label: 'allow_file_read' }, { label: 'deny_file_read' }],
  }
  assert.equal(externalReadAuthorization.matches([request]), true)
  assert.equal(externalReadAuthorization.matches([{ ...request, id: 'untrusted' }]), false)
  assert.equal(externalReadAuthorization.directPresentation, 'high-risk')
  const presented = externalReadAuthorization.presentQuestion?.(request, localization)
  assert.match(presented?.question ?? '', /\/Users\/example\/report.txt/)
  assert.match(presented?.question ?? '', /仅.*当前任务/)
  assert.match(presented?.question ?? '', /只读/)
  assert.equal(presented?.options[0].label, '允许本次读取')
  assert.equal(presented?.options[1].label, '拒绝')
  assert.equal(request.options[0].label, 'allow_file_read')
  await localization.changeLanguage('en')
  assert.match(
    externalReadAuthorization.presentQuestion?.(request, localization)?.question ?? '',
    /read-only/
  )
})

test('file recovery policies distinguish owner-issued read and immutable save failures', () => {
  const read = {
    id: 'file-recovery:request',
    header: 'file_read_failed',
    question: 'resources/broken.pdf',
    options: [{ label: 'retry_file' }, { label: 'remove_file' }],
  }
  assert.equal(fileRecovery.matches([read]), true)
  assert.equal(fileRecovery.directPresentation, 'high-risk')
  assert.equal(saveRecovery.matches([read]), false)
  assert.equal(fileRecovery.directDecision?.(read, read.options[0]), 'respond')
  assert.equal(fileRecovery.directDecision?.(read, read.options[1]), 'respond')
  assert.equal(fileRecovery.prepareDecision, undefined)
  const save = {
    ...read,
    header: 'file_write_denied',
    options: [{ label: 'retry_file' }, { label: 'cancel_save' }],
  }
  assert.equal(saveRecovery.matches([save]), true)
  assert.equal(saveRecovery.directPresentation, 'high-risk')
  assert.equal(saveRecovery.directDecision?.(save, save.options[1]), 'respond')
  assert.equal(fileRecovery.matches([save]), false)
  assert.equal(typeof saveRecovery.prepareDecision, 'function')
  assert.equal(saveRecovery.matches([{ ...save, id: 'untrusted' }]), false)
})

test('search recovery only matches its exact owner-issued interaction shape', () => {
  assert.equal(searchRecovery.matches([question]), true)
  assert.equal(searchRecovery.matches([{ ...question, id: 'ordinary-question' }]), false)
  assert.equal(searchRecovery.matches([{ ...question, header: 'other' }]), false)
  assert.equal(
    searchRecovery.matches([{ ...question, options: [{ label: 'retry_search' }] }]),
    false
  )
  assert.equal(searchRecovery.matches([question, question]), false)
  assert.equal(searchRecovery.directPresentation, 'failure-strip')
  assert.equal(searchRecovery.directDecision?.(question, question.options[0]), 'respond')
  assert.equal(searchRecovery.directDecision?.(question, question.options[1]), 'respond')
})

test('translated recovery labels never change the submitted native decision or query', async () => {
  const localization = createInstance()
  await localization.init({
    lng: 'zh',
    fallbackLng: false,
    resources: { zh: { assistant: zh }, en: { assistant: en } },
  })
  const presented = searchRecovery.presentQuestion?.(question, localization)
  assert.equal(presented?.options[0].label, '重新检索')
  assert.match(presented?.question ?? '', /original query/)
  assert.match(presented?.question ?? '', /provider_unavailable/)
  assert.equal(question.options[0].label, 'retry_search')
  await localization.changeLanguage('en')
  assert.notEqual(
    searchRecovery.presentQuestion?.(question, localization)?.options[0].label,
    '重新检索'
  )
  assert.equal(question.question, 'original query')
})

test('file recovery replies use the actual file and distinguish saving from reading', async () => {
  const localization = createInstance()
  await localization.init({ lng: 'zh', resources: { zh: { assistant: zh } } })
  const read = {
    id: 'file-recovery:test',
    header: 'file_read_failed',
    question: 'broken.pdf',
    options: [{ label: 'retry_file' }, { label: 'remove_file' }],
  }
  assert.equal(fileRecovery.replyTitle?.(read, 'retry_file', localization), 'broken.pdf 无法读取')
  assert.match(fileRecovery.replyText?.(read, 'retry_file', localization) ?? '', /重新读取/)
  assert.match(saveRecovery.replyText?.(read, 'retry_file', localization) ?? '', /原保存操作/)
})
