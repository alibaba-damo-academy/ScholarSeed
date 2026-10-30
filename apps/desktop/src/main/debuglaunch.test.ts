import assert from 'node:assert/strict'
import { test } from 'node:test'
import { restoreUpdateDebugPort, updateDebugArguments } from './debuglaunch.ts'

test('update preserves explicit CDP port in both argument forms', () => {
  for (const port of [0, 9222, 65535]) {
    const expected = ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`]
    assert.deepEqual(updateDebugArguments([`--remote-debugging-port=${port}`]), expected)
    assert.deepEqual(updateDebugArguments(['--remote-debugging-port', String(port)]), expected)
  }
})

test('update never enables absent, invalid, non-local or pipe-only debugging', () => {
  for (const argv of [[], ['--remote-debugging-pipe'], ['--remote-debugging-port'],
    ['--remote-debugging-port=-1'], ['--remote-debugging-port=65536'],
    ['--remote-debugging-port=1.5'], ['--remote-debugging-port=NaN'],
    ['--remote-debugging-port=9222', '--remote-debugging-address=0.0.0.0']]) {
    assert.deepEqual(updateDebugArguments(argv), [])
  }
})

test('update normalizes local listening and excludes unrelated arguments', () => {
  for (const address of ['127.0.0.1', 'localhost', '::1']) {
    assert.deepEqual(updateDebugArguments(['--remote-debugging-port=9222', '--remote-debugging-address', address,
      '--disable-web-security', '--token=secret', '--user-data-dir=C:\\Users\\test user\\profile']),
    ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222'])
  }
})

test('macOS CDP restoration stays local and preserves explicit launch overrides', () => {
  for (const existing of [undefined, 'remote-debugging-port', 'remote-debugging-pipe']) {
    const switches: string[][] = []
    const commandLine = {
      hasSwitch: (name: string) => name === existing,
      appendSwitch: (name: string, value: string) => { switches.push([name, value]) },
    }
    restoreUpdateDebugPort(commandLine, { debugPort: 9222 })
    assert.deepEqual(switches, existing ? [] : [['remote-debugging-address', '127.0.0.1'], ['remote-debugging-port', '9222']])
    switches.length = 0
    restoreUpdateDebugPort(commandLine, {})
    assert.deepEqual(switches, [])
  }
})
