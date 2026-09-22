import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { ASSISTANT_TRANSLATION_TARGETS } from '../../../contracts/assistant.ts'
import { invokeFigure, pdfResponseLanguage, type PdfAiRequest, PDF_TRANSLATION_TARGETS } from './analysis.ts'

const request: PdfAiRequest = {
  literature_id: 'paper', project_id: '', revision: 'old', model_key: 'model',
  kind: 'figure_explanation', module: 'all', page: 2, text: '', rect: [0.1, 0.2, 0.3, 0.4],
  client_action_id: 'action', client_attempt_id: 'attempt', instruction: '解释趋势',
  response_language: 'zh'
}

function installFetch(fetch: typeof globalThis.fetch): () => void {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://service.test' }
  } as Window & typeof globalThis
  globalThis.fetch = fetch
  return () => {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
}

function stream(...events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' }
  })
}

test('PDF response language follows the supported interface locale', () => {
  assert.equal(pdfResponseLanguage('en'), 'en')
  assert.equal(pdfResponseLanguage('en-US'), 'en')
  assert.equal(pdfResponseLanguage('zh-CN'), 'zh')
  assert.equal(pdfResponseLanguage(undefined), 'zh')
})

test('figure invocation streams crop and markdown before authoritative result', async () => {
  const restore = installFetch(async () => stream(
    {
      type: 'prepared', source_id: 'paper', source_revision: 'revision', title: 'Paper',
      page: 2, rect: request.rect, crop: 'data:image/png;base64,crop'
    },
    { type: 'accepted', invocation_id: 'invocation', text: '', item_id: '' },
    { type: 'output_delta', invocation_id: 'invocation', text: '趋势上升', item_id: 'answer' },
    {
      type: 'result', result: {
        task_id: 'invocation', invocation_id: 'invocation', status: 'completed',
        output: '趋势上升，后期趋稳。', model_key: 'model', error_code: '', error_detail: '',
        source_id: 'paper', source_revision: 'revision', title: 'Paper', page: 2,
        rect: request.rect, crop: 'data:image/png;base64,crop'
      }
    }
  ))
  try {
    const previews: { crop: string; text: string }[] = []
    const result = await invokeFigure(
      request,
      new AbortController().signal,
      preview => previews.push(preview)
    )
    assert.deepEqual(previews, [
      { crop: 'data:image/png;base64,crop', text: '' },
      { crop: 'data:image/png;base64,crop', text: '趋势上升' }
    ])
    assert.equal(result.text, '趋势上升，后期趋稳。')
    assert.equal(result.revision, 'revision')
    assert.equal(result.crop, 'data:image/png;base64,crop')
  } finally { restore() }
})

test('PDF translation reuses the complete mainstream target catalog', () => {
  assert.deepEqual(PDF_TRANSLATION_TARGETS, ASSISTANT_TRANSLATION_TARGETS)
})

test('PDF translation only exposes a searchable target-language control', () => {
  const control = readFileSync(new URL('./Translation.tsx', import.meta.url), 'utf8')
  const reading = readFileSync(new URL('./Reading.tsx', import.meta.url), 'utf8')

  assert.match(control, /TranslationTargetPicker/)
  assert.doesNotMatch(control, /translation\.auto|translation\.toEnglish|translation\.toChinese/)
  assert.doesNotMatch(reading, /\?\? 'auto'|selected !== 'auto'/)
})
