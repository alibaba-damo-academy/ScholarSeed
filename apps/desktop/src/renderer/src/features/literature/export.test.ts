import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { BIBTEX_SUGGESTED_NAME, saveBibtex, type SaveCopyBridge } from './export.ts'

const BIBTEX = '@article{Research2026,\n  title = {Research},\n}\n'

type SaveCopyPayload = { suggestedName: string; bytes: Uint8Array }
type SaveCopyReply = Awaited<ReturnType<SaveCopyBridge['saveFileCopy']>>

const fakeBridge = (reply: SaveCopyReply, calls: SaveCopyPayload[] = []): SaveCopyBridge => ({
  saveFileCopy: async (payload) => {
    calls.push(payload)
    return reply
  }
})

test('导出成功只在文件真的落盘之后成立', async () => {
  const calls: SaveCopyPayload[] = []
  const saved = await saveBibtex(BIBTEX, fakeBridge({ ok: true, path: '/tmp/literature.bib' }, calls))

  assert.deepEqual(saved, { kind: 'saved', path: '/tmp/literature.bib' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].suggestedName, BIBTEX_SUGGESTED_NAME)
  assert.equal(new TextDecoder().decode(calls[0].bytes), `${BIBTEX}\n`)
})

test('用户在保存对话框里取消时既不算成功也不算失败', async () => {
  assert.deepEqual(await saveBibtex(BIBTEX, fakeBridge({ ok: false, canceled: true })), { kind: 'canceled' })
})

test('写盘失败与桥缺失都保留可展示的原因', async () => {
  assert.deepEqual(await saveBibtex(BIBTEX, fakeBridge({ ok: false, error: 'disk full' })), {
    kind: 'failed',
    error: 'disk full'
  })
  // 没有另存通道 (既非桌面也非浏览器形态) 时不能静默成功, 否则提示会说谎。
  Reflect.set(globalThis, 'window', {})
  assert.deepEqual(await saveBibtex(BIBTEX), { kind: 'failed', error: 'desktop save bridge unavailable' })
})

test('保存通道抛异常不冒泡到列表, 只落成一次失败', async () => {
  const throwing: SaveCopyBridge = {
    saveFileCopy: async () => {
      throw new Error('ipc gone')
    }
  }

  assert.deepEqual(await saveBibtex(BIBTEX, throwing), { kind: 'failed', error: 'ipc gone' })
})

test('列表不再自行拼 Blob 下载, 成功提示只跟落盘结果绑定', () => {
  const listSource = readFileSync(new URL('./LiteratureList.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(listSource, /URL\.createObjectURL/)
  assert.doesNotMatch(listSource, /anchor\.download/)
  assert.match(listSource, /const saved = await saveBibtex\(result\.bibtex\)/)
  assert.match(listSource, /if \(saved\.kind === 'saved'\) \{\s+toast\(\{\s+title: literature\('batch\.exportSucceeded'/)
})
