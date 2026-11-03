import assert from 'node:assert/strict'
import test from 'node:test'
import { pdfeEnvironment } from '../pdfe.mjs'

test('PDFE launch preserves OS inputs without inheriting credentials, profile overrides or Node injection', () => {
  const result = pdfeEnvironment({ PATH: '/owned/bin', HOME: '/owned/home', LANG: 'zh_CN.UTF-8', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'never-inherit', SCHOLARSEED_HOME: '/personal/state', SCHOLARSEED_ACCOUNT_BASE_URL: 'https://personal.invalid', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require=personal.cjs', HTTP_PROXY: 'http://personal.invalid' })
  assert.deepEqual(result, { PATH: '/owned/bin', HOME: '/owned/home', LANG: 'zh_CN.UTF-8', SystemRoot: 'C:\\Windows' })
})
