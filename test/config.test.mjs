import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CONFIG_VERSION,
  DEFAULTS,
  normalize,
  normalizeDetailed,
  migrateLegacy,
  configDigest,
  toRuntimePlan,
  readConfigFile,
  writeConfigFileAtomic,
} from '../src/host/config.js'

test('normalize clamps numbers and records a warning without throwing', () => {
  const { config, warnings } = normalizeDetailed({
    boot: { fadeMs: 99999, mode: 'nope', volume: 3, suiteHoldMs: 99999 },
    foo: 1,
    extensions: { suite: { identity: 'JOYCE MOORE', bgmBpm: 100 } },
  })
  assert.equal(config.schemaVersion, CONFIG_VERSION)
  assert.equal(config.boot.fadeMs, 5000)
  assert.equal(config.boot.mode, 'session')
  assert.equal(config.boot.volume, 1)
  assert.equal(config.boot.suiteHoldMs, 60000)
  assert.equal(config.extensions.foo, 1)
  assert.equal(config.extensions.suite.identity, 'JOYCE MOORE')
  assert.equal(config.extensions.suite.bgmBpm, 100)
  assert.ok(warnings.some((w) => w.includes('boot.fadeMs')))
  assert.ok(warnings.some((w) => w.includes('boot.mode')))
})

test('normalize is total: junk becomes a usable config', () => {
  const config = normalize(null)
  assert.equal(config.enabled, true)
  assert.equal(config.boot.mode, DEFAULTS.boot.mode)
  assert.deepEqual(config.media.disabledClips, [])
  assert.equal(normalize('not an object').boot.fadeMs, DEFAULTS.boot.fadeMs)
})

test('migration ORs enabled and maps each owner\'s fields', () => {
  const { config, warnings } = migrateLegacy({
    suite: {
      enabled: true,
      holdMs: 5000,
      clip: 'c1',
      mode: 'daily',
      sound: true,
      volume: 0.4,
      unknownSuiteKey: 'kept',
    },
    animation: {
      enabled: false,
      fadeMs: 2000,
      enterMode: 'click',
      sound: false,
      clickToEnter: false,
      screensaverEnabled: true,
      screensaverIdleMs: 60000,
      screensaverBreakStyle: 'glitch',
      disabledClips: ['clip-2'],
      unknownAnimationKey: 7,
    },
    wallpaper: { enabled: true, image: 'a.png', opacity: 0.5 },
    mtimes: { suite: 1, animation: 2, wallpaper: 3 },
    now: 42,
  })
  assert.equal(config.enabled, true, 'one legacy plugin saying yes keeps the boot')
  assert.equal(config.boot.mode, 'daily')
  assert.equal(config.boot.holdMs, 5000)
  assert.equal(config.boot.clip, 'c1')
  assert.equal(config.boot.fadeMs, 2000)
  assert.equal(config.boot.sound, false, 'animation is the later owner of sound')
  assert.equal(config.boot.trigger, 'click')
  assert.equal(config.boot.clickToEnter, false)
  assert.equal(config.saver.enabled, true)
  assert.equal(config.saver.idleMs, 60000)
  assert.equal(config.saver.breakStyle, 'glitch')
  assert.deepEqual(config.media.disabledClips, ['clip-2'])
  assert.equal(config.wallpaper.enabled, true)
  assert.equal(config.wallpaper.opacity, 0.5)
  assert.equal(config.legacy.suite.unknownSuiteKey, 'kept')
  assert.equal(config.legacy.animation.unknownAnimationKey, 7)
  assert.equal(config.legacy.animation.fadeMs, undefined)
  assert.equal(config.legacy.migratedAt, 42)
  assert.deepEqual(config.legacy.sourceMtimes, { suite: 1, animation: 2, wallpaper: 3 })
  assert.ok(Array.isArray(warnings))
})

test('both legacy plugins disabled means the boot stays disabled', () => {
  const { config } = migrateLegacy({ suite: { enabled: false }, animation: { enabled: false } })
  assert.equal(config.enabled, false)
})

test('no legacy votes means the default is enabled', () => {
  assert.equal(migrateLegacy({}).config.enabled, true)
})

test('configDigest is stable and changes with the config', () => {
  const a = normalize({ boot: { fadeMs: 900 } })
  const b = normalize({ boot: { fadeMs: 900 } })
  assert.equal(configDigest(a), configDigest(b))
  assert.notEqual(configDigest(a), configDigest(normalize({ boot: { fadeMs: 901 } })))
})

test('toRuntimePlan is JSON-safe and carries the route base', () => {
  const plan = toRuntimePlan(normalize({ boot: { fadeMs: 99999 } }), {
    version: '9.9.9',
    base: '/dsh-boot-nexus',
    media: { clips: [{ id: 'c1' }], savers: [] },
  })
  assert.equal(plan.version, '9.9.9')
  assert.equal(plan.base, '/dsh-boot-nexus')
  assert.equal(plan.boot.fadeMs, 5000)
  assert.deepEqual(plan.media.clips, [{ id: 'c1' }])
  assert.doesNotThrow(() => JSON.stringify(plan))
})

test('readConfigFile reports missing, corrupt and valid files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dbn-config-'))
  try {
    const file = join(dir, 'dsh-boot-nexus.json')
    const missing = await readConfigFile(file)
    assert.equal(missing.exists, false)
    assert.equal(missing.config.enabled, true)

    await writeFile(file, '{ not json', 'utf8')
    const corrupt = await readConfigFile(file, { now: () => 123 })
    assert.equal(corrupt.exists, true)
    assert.equal(corrupt.corrupt, true)
    assert.equal(corrupt.backup, `${file}.corrupt-123`)
    assert.equal(await readFile(corrupt.backup, 'utf8'), '{ not json')

    const saved = await writeConfigFileAtomic(file, { boot: { fadeMs: 1000 } })
    assert.ok(saved.bytes > 0)
    const valid = await readConfigFile(file)
    assert.equal(valid.exists, true)
    assert.equal(valid.corrupt, undefined)
    assert.equal(valid.config.boot.fadeMs, 1000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
