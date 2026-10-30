import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('empty conversations show atomic skeletons while resuming, not the new-session welcome', () => {
  const source = readFileSync(new URL('./Stream.tsx', import.meta.url), 'utf8')
  assert.match(
    source,
    /conv\.length === 0 &&\s*\(thread\.resumeState === 'pending' \? <Loading \/> : <Empty home=\{home\} \/>\)/
  )
  assert.match(source, /function Loading\([\s\S]*?<Skeleton/)
  assert.match(source, /data-testid="conversation-loading"/)
})
