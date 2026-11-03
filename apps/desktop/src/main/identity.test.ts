import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { configureNotificationIdentity } from './identity.ts'
import { SCHOLARSEED_PRODUCT_ID } from './product.ts'

test('Windows notifications use the Velopack shortcut identity', () => {
  const calls: string[] = []
  configureNotificationIdentity({ setAppUserModelId: (id) => calls.push(id) }, 'win32')
  assert.deepEqual(calls, [`velopack.${SCHOLARSEED_PRODUCT_ID}`])
})

for (const platform of ['darwin', 'linux'] as const) {
  test(`${platform} does not invoke the Windows identity API`, () => {
    configureNotificationIdentity(
      { setAppUserModelId: () => assert.fail('Windows API invoked') },
      platform
    )
  })
}

test('identity registration errors are not hidden', () => {
  const error = new Error('identity registration failed')
  assert.throws(
    () =>
      configureNotificationIdentity(
        {
          setAppUserModelId: () => {
            throw error
          },
        },
        'win32'
      ),
    error
  )
})

test('notification identity uses the shipped Windows package ID', () => {
  const product = JSON.parse(
    readFileSync(new URL('../../resources/product.json', import.meta.url), 'utf8')
  )
  assert.equal(product.product_id, SCHOLARSEED_PRODUCT_ID)
  const calls: string[] = []
  configureNotificationIdentity({ setAppUserModelId: (id) => calls.push(id) }, 'win32')
  assert.equal(calls[0], `velopack.${product.product_id}`)
})

test('main entry configures Electron notification identity', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  assert.match(source, /configureNotificationIdentity\(app, process.platform\)/)
})
