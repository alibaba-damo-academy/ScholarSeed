import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { MACOS_HDIUTIL, mountPointsOfImage, readHdiutilInfoPlist } from './mounts.ts'

const INFO_FIXTURE = {
  images: [
    {
      'image-path': '/Users/lj/Library/Caches/scholarseed-update/pkg.dmg',
      'system-entities': [
        { 'content-hint': 'GUID_partition_scheme', 'dev-entry': '/dev/disk4' },
        { 'dev-entry': '/dev/disk4s1', 'mount-point': '/Volumes/ScholarSeed' }
      ]
    },
    {
      'image-path': '/private/tmp/other.dmg',
      'system-entities': [{ 'dev-entry': '/dev/disk5s1', 'mount-point': '/Volumes/Other' }]
    },
    {
      'image-path': '/tmp/unmounted.dmg',
      'system-entities': [{ 'dev-entry': '/dev/disk6' }]
    }
  ]
}

test('mountPointsOfImage picks only mount points of the named image', () => {
  assert.deepEqual(
    mountPointsOfImage(INFO_FIXTURE, ['/Users/lj/Library/Caches/scholarseed-update/pkg.dmg']),
    ['/Volumes/ScholarSeed']
  )
})

test('mountPointsOfImage matches the realpath form hdiutil records', () => {
  assert.deepEqual(
    mountPointsOfImage(INFO_FIXTURE, ['/tmp/other.dmg', '/private/tmp/other.dmg']),
    ['/Volumes/Other']
  )
})

test('mountPointsOfImage ignores entities without a mount point and unknown shapes', () => {
  assert.deepEqual(mountPointsOfImage(INFO_FIXTURE, ['/tmp/unmounted.dmg']), [])
  assert.deepEqual(mountPointsOfImage({}, ['/tmp/unmounted.dmg']), [])
  assert.deepEqual(mountPointsOfImage(null, ['/tmp/unmounted.dmg']), [])
})

// 真 hdiutil 闭环：先钉死「同一镜像二次 attach 恒报 resource busy」这条缺陷不变量（RED），
// 再走 updater.mountDmg 的同款恢复序列 —— 探针、detach、重新 attach —— 证明它能恢复（GREEN）。
test('readHdiutilInfoPlist sees a live mount and the sweep sequence re-attaches', {
  skip: process.platform === 'darwin' ? false : 'hdiutil exists only on macOS'
}, async () => {
  const work = mkdtempSync(join(tmpdir(), 'mounts-probe-'))
  const dmg = join(work, 'probe.dmg')
  const mount = join(work, 'mount')
  mkdirSync(mount, { recursive: true })
  const attachTo = (target: string) =>
    spawnSync(
      MACOS_HDIUTIL,
      ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', target, dmg],
      { encoding: 'utf8' }
    )
  try {
    const created = spawnSync(
      MACOS_HDIUTIL,
      ['create', '-size', '10m', '-fs', 'HFS+', '-volname', 'ProbeVol', dmg],
      { encoding: 'utf8' }
    )
    assert.equal(created.status, 0, created.stderr)
    const attached = attachTo(mount)
    assert.equal(attached.status, 0, attached.stderr)

    const stale = join(work, 'stale')
    mkdirSync(stale, { recursive: true })
    const busy = attachTo(stale)
    assert.notEqual(busy.status, 0, 'second attach of a mounted image must be resource busy')

    const info = await readHdiutilInfoPlist()
    const points = mountPointsOfImage(info, [dmg, realpathSync(dmg)])
    assert.deepEqual(points, [realpathSync(mount)])

    for (const point of points) {
      const detached = spawnSync(MACOS_HDIUTIL, ['detach', point, '-force'], { encoding: 'utf8' })
      assert.equal(detached.status, 0, detached.stderr)
    }
    const reattached = attachTo(mount)
    assert.equal(reattached.status, 0, reattached.stderr)
  } finally {
    spawnSync(MACOS_HDIUTIL, ['detach', mount, '-force'], { encoding: 'utf8' })
    rmSync(work, { recursive: true, force: true })
  }
})
