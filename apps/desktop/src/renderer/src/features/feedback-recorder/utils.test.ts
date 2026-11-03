import assert from 'node:assert/strict'
import test from 'node:test'

import {
  responseFileMetadata,
  summarizeBody,
  summarizeText,
  screenshotLayerPlacement,
  summarizeBodyText,
  redactUrl,
} from './utils.ts'

test('body summaries preserve text at the UTF-8 boundary', () => {
  assert.equal(summarizeText('a'.repeat(199)), 'a'.repeat(199))
  assert.equal(summarizeText('a'.repeat(200)), 'a'.repeat(200))
  assert.equal(summarizeText('a'.repeat(201)), `${'a'.repeat(200)}…[已截断，省略 1 字节]`)
})

test('native screenshot placement scales DIP bounds to screenshot pixels', () => {
  assert.deepEqual(
    screenshotLayerPlacement(
      { width: 1280, height: 840 },
      { width: 2560, height: 1680 },
      { x: 20, y: 30, width: 100, height: 50 }
    ),
    { x: 40, y: 60, width: 200, height: 100 }
  )
})

test('body summaries do not split Chinese or emoji and count omitted bytes', () => {
  assert.equal(summarizeText('中'.repeat(67)), `${'中'.repeat(66)}…[已截断，省略 3 字节]`)
  assert.equal(summarizeText(`${'a'.repeat(199)}😀`), `${'a'.repeat(199)}…[已截断，省略 4 字节]`)
  assert.equal(summarizeText('😀'.repeat(51)), `${'😀'.repeat(50)}…[已截断，省略 4 字节]`)
})

test('small JSON retains its original whitespace and escapes', () => {
  const body = '{ "message": "\\"你好\\"" }'
  assert.equal(summarizeText(body), body)
})

test('body summaries hide credential fields without changing ordinary JSON formatting', () => {
  const ordinary = '{ "message": "hello" }'
  assert.equal(summarizeBodyText(ordinary), ordinary)
  const credentials = JSON.parse(
    summarizeBodyText('{"access_token":"private-token","nested":{"password":"private-password"}}')
  )
  assert.equal(credentials.access_token, '[已隐藏凭据]')
  assert.equal(credentials.nested.password, '[已隐藏凭据]')
  const form = new FormData()
  form.append('api_key', 'private-key')
  form.append('note', 'ordinary')
  assert.deepEqual(JSON.parse(summarizeBody(form) || ''), [
    ['api_key', '[已隐藏凭据]'],
    ['note', 'ordinary'],
  ])
})

test('recorded URLs hide credentials without changing ordinary parameters', () => {
  const ordinary = 'https://example.test/items?page=2#details'
  assert.equal(redactUrl(ordinary), ordinary)
  const redacted = new URL(
    redactUrl(
      'https://user:private-password@example.test/items?access_token=private-token&page=2#api_key=private-key'
    )
  )
  assert.equal(redacted.username, '')
  assert.equal(redacted.password, '')
  assert.equal(redacted.searchParams.get('access_token'), '[已隐藏凭据]')
  assert.equal(redacted.searchParams.get('page'), '2')
  assert.equal(new URLSearchParams(redacted.hash.slice(1)).get('api_key'), '[已隐藏凭据]')
  assert.doesNotMatch(redacted.href, /private-/)
})

test('URL-encoded request bodies hide credentials and preserve ordinary fields', () => {
  const body = new URLSearchParams({ password: 'private-password', note: 'ordinary' })
  const recorded = new URLSearchParams(summarizeBody(body))
  assert.equal(recorded.get('password'), '[已隐藏凭据]')
  assert.equal(recorded.get('note'), 'ordinary')
  assert.equal(body.get('password'), 'private-password')
  assert.equal(summarizeBodyText('note=ordinary'), 'note=ordinary')
  assert.doesNotMatch(
    summarizeBodyText('password=private-password&note=ordinary'),
    /private-password/
  )
})

test('file bodies retain only name and byte size without reading', () => {
  const file = new File(['secret'], 'evidence.txt')
  file.text = async () => {
    throw new Error('must not read')
  }
  file.arrayBuffer = async () => {
    throw new Error('must not read')
  }
  assert.equal(summarizeBody(file), '[File evidence.txt 6 bytes]')
  assert.equal(summarizeBody(new Blob(['hidden'])), '[File unknown 6 bytes]')
  assert.equal(summarizeBody(new Uint8Array([1, 2, 3])), '[File unknown 3 bytes]')
})

test('multipart summarizes text fields and file metadata independently', () => {
  const form = new FormData()
  form.append('note', 'x'.repeat(201))
  form.append('attachment', new File(['secret'], 'proof.txt'))
  const body = JSON.parse(summarizeBody(form) || '')
  assert.deepEqual(body, [
    ['note', `${'x'.repeat(200)}…[已截断，省略 1 字节]`],
    ['attachment', '[File proof.txt 6 bytes]'],
  ])
})

test('download metadata prefers encoded disposition names and validates sizes', () => {
  assert.equal(
    responseFileMetadata(
      new Headers({
        'content-type': 'application/pdf',
        'content-encoding': 'gzip',
        'content-length': '42',
      }),
      'https://example.test/file.pdf'
    ),
    '[File file.pdf unknown bytes]'
  )
  assert.equal(
    responseFileMetadata(
      new Headers({
        'content-disposition': "attachment; filename*=UTF-8''%E6%96%87%E4%BB%B6.pdf",
        'content-length': '42',
      }),
      'https://example.test/fallback.pdf'
    ),
    '[File 文件.pdf 42 bytes]'
  )
  assert.equal(
    responseFileMetadata(
      new Headers({ 'content-type': 'application/pdf' }),
      'https://example.test/fallback.pdf?token=private'
    ),
    '[File fallback.pdf unknown bytes]'
  )
  assert.equal(
    responseFileMetadata(
      new Headers({
        'content-type': 'application/octet-stream',
        'content-length': '-1',
      }),
      ''
    ),
    '[File unknown unknown bytes]'
  )
  assert.equal(
    responseFileMetadata(new Headers({ 'content-type': 'application/json' }), ''),
    undefined
  )
})
