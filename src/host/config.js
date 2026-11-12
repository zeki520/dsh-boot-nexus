/**
 * The single configuration truth for dsh-boot-nexus.
 *
 * One file: `$DSH_HOME/dsh-boot-nexus.json`, `schemaVersion: 2`.
 *
 * The two legacy plugins each owned a config file (and the animation plugin
 * owned a second, declarative settings namespace). Nexus reads those files
 * ONCE at first start, maps only the keys it understands, keeps every unknown
 * key under `legacy.*`, and never writes them back. If migration is ever run
 * again with unchanged sources the digest makes it a no-op.
 *
 * This module is pure except for the two small IO helpers at the bottom; the
 * pure half is what the tests exercise.
 */

import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { promises as fsp } from 'node:fs'

export const CONFIG_VERSION = 2

export const MODES = Object.freeze(['session', 'daily', 'always'])
export const TRIGGERS = Object.freeze(['auto', 'click'])
export const REDUCED_MOTION = Object.freeze(['auto', 'on', 'off'])
export const BREAK_STYLES = Object.freeze(['random', 'particles', 'fall', 'glitch'])
export const POINTER_EFFECTS = Object.freeze(['none', 'random', 'ripples', 'attract', 'lens'])

export const DEFAULTS = Object.freeze({
  schemaVersion: CONFIG_VERSION,
  enabled: true,
  boot: Object.freeze({
    mode: 'session',
    clip: 'auto',
    choice: 'random',
    suiteAct1: 'auto',
    suiteAct2: 'auto',
    suiteAct2Ms: 0,
    suiteHoldMs: 0,
    suitePopupMs: 0,
    holdMs: 0,
    fadeMs: 900,
    sound: false,
    volume: 0.6,
    trigger: 'auto',
    clickToEnter: true,
    showHint: true,
    hintAfterMs: 12000,
    maxMs: 30000,
    reducedMotion: 'auto',
  }),
  saver: Object.freeze({
    enabled: false,
    idleMs: 180000,
    pool: 'auto',
    breakEffect: true,
    breakStyle: 'random',
    hint: true,
    pointerEffect: 'random',
    sound: false,
    volume: 0.5,
    rotateMs: 0,
  }),
  wallpaper: Object.freeze({
    enabled: false,
    image: '',
    color: '',
    opacity: 1,
  }),
  media: Object.freeze({
    disabledClips: Object.freeze([]),
    disabledSavers: Object.freeze([]),
  }),
  advanced: Object.freeze({
    diag: false,
    trace: false,
  }),
  extensions: Object.freeze({}),
})

const BOOT_KEYS = ['mode', 'clip', 'choice', 'suiteAct1', 'suiteAct2', 'suiteAct2Ms', 'suiteHoldMs', 'suitePopupMs', 'holdMs', 'fadeMs', 'sound', 'volume', 'trigger',
  'clickToEnter', 'showHint', 'hintAfterMs', 'maxMs', 'reducedMotion']
const SAVER_KEYS = ['enabled', 'idleMs', 'pool', 'breakEffect', 'breakStyle', 'hint',
  'pointerEffect', 'sound', 'volume', 'rotateMs']
const WALLPAPER_KEYS = ['enabled', 'image', 'color', 'opacity']
const TOP_KEYS = ['schemaVersion', 'enabled', 'boot', 'saver', 'wallpaper', 'media',
  'advanced', 'extensions', 'legacy']

/** Keys the migration consumes from each legacy source. Everything else is kept. */
const SUITE_CONSUMED = ['enabled', 'sound', 'voice', 'volume', 'holdMs', 'fadeMs', 'mode', 'clip']
const ANIMATION_CONSUMED = [
  'enabled', 'fadeMs', 'enterMode', 'disabledClips', 'sound', 'clickToEnter', 'showHint',
  'screensaverEnabled', 'screensaverIdleMs', 'screensaverBreakEffect',
  'screensaverBreakStyle', 'screensaverHint', 'screensaverPointerEffect',
  'disabledScreensaver', 'screensaverSound', 'screensaverVolume', 'screensaverRotateMs',
]
const WALLPAPER_CONSUMED = ['enabled', 'image', 'color', 'opacity']

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const has = (o, k) => isObject(o) && Object.prototype.hasOwnProperty.call(o, k)

function clampNumber(value, min, max, fallback, warnings, label) {
  if (value === undefined || value === null || value === '') return fallback
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) {
    warnings.push(`${label}: not a number (${String(value)}), using ${fallback}`)
    return fallback
  }
  const clamped = Math.min(max, Math.max(min, n))
  if (clamped !== n) warnings.push(`${label}: ${n} clamped to ${clamped}`)
  return clamped
}

function asBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1 || value === '1') return true
  if (value === 'false' || value === 0 || value === '0') return false
  return fallback
}

function asEnum(value, allowed, fallback, warnings, label) {
  if (typeof value === 'string' && allowed.includes(value)) return value
  if (value !== undefined && value !== null && value !== '') {
    warnings.push(`${label}: ${String(value)} is not one of ${allowed.join(', ')}; using ${fallback}`)
  }
  return fallback
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function asStringArray(value, warnings, label) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    warnings.push(`${label}: expected an array, ignoring`)
    return []
  }
  return [...new Set(value.filter((v) => typeof v === 'string' && v.length > 0 && v.length <= 200))]
    .slice(0, 500)
}

function extras(source, known) {
  if (!isObject(source)) return {}
  const out = {}
  for (const key of Object.keys(source)) if (!known.includes(key)) out[key] = source[key]
  return out
}

/**
 * Coerce a partial document into a complete, bounded config.
 *
 * Never throws: a file written by a future version, a hand-edited typo or a
 * legacy shape all come out as a usable config plus warnings. Runtime already
 * has to survive a bad config; making the parser throw would turn a bad field
 * into a black screen.
 */
export function normalize(raw) {
  return normalizeDetailed(raw).config
}

/**
 * Same coercion, but keeps the warnings for the caller that is about to write
 * the result or show it in diagnostics. `normalize` is the convenience wrapper
 * used anywhere a plain config is enough.
 */
export function normalizeDetailed(raw) {
  const warnings = []
  const input = isObject(raw) ? raw : {}
  if (raw !== undefined && !isObject(raw)) warnings.push('config is not an object; using defaults')

  const bootIn = isObject(input.boot) ? input.boot : {}
  const saverIn = isObject(input.saver) ? input.saver : {}
  const wallpaperIn = isObject(input.wallpaper) ? input.wallpaper : {}
  const mediaIn = isObject(input.media) ? input.media : {}
  const advancedIn = isObject(input.advanced) ? input.advanced : {}

  const boot = {
    mode: asEnum(bootIn.mode, MODES, DEFAULTS.boot.mode, warnings, 'boot.mode'),
    clip: asString(bootIn.clip, DEFAULTS.boot.clip) || DEFAULTS.boot.clip,
    choice: asEnum(bootIn.choice, ['random', 'clip', 'suite'], DEFAULTS.boot.choice, warnings, 'boot.choice'),
    suiteAct1: asString(bootIn.suiteAct1, DEFAULTS.boot.suiteAct1) || DEFAULTS.boot.suiteAct1,
    suiteAct2: asString(bootIn.suiteAct2, DEFAULTS.boot.suiteAct2) || DEFAULTS.boot.suiteAct2,
    suiteAct2Ms: clampNumber(bootIn.suiteAct2Ms, 0, 120000, DEFAULTS.boot.suiteAct2Ms, warnings, 'boot.suiteAct2Ms'),
    suiteHoldMs: clampNumber(bootIn.suiteHoldMs, 0, 60000, DEFAULTS.boot.suiteHoldMs, warnings, 'boot.suiteHoldMs'),
    suitePopupMs: clampNumber(bootIn.suitePopupMs, 0, 60000, DEFAULTS.boot.suitePopupMs, warnings, 'boot.suitePopupMs'),
    holdMs: clampNumber(bootIn.holdMs, 0, 120000, DEFAULTS.boot.holdMs, warnings, 'boot.holdMs'),
    fadeMs: clampNumber(bootIn.fadeMs, 200, 5000, DEFAULTS.boot.fadeMs, warnings, 'boot.fadeMs'),
    sound: asBool(bootIn.sound, DEFAULTS.boot.sound),
    volume: clampNumber(bootIn.volume, 0, 1, DEFAULTS.boot.volume, warnings, 'boot.volume'),
    trigger: asEnum(bootIn.trigger, TRIGGERS, DEFAULTS.boot.trigger, warnings, 'boot.trigger'),
    clickToEnter: asBool(bootIn.clickToEnter, DEFAULTS.boot.clickToEnter),
    showHint: asBool(bootIn.showHint, DEFAULTS.boot.showHint),
    hintAfterMs: clampNumber(bootIn.hintAfterMs, 3000, 60000, DEFAULTS.boot.hintAfterMs, warnings, 'boot.hintAfterMs'),
    maxMs: clampNumber(bootIn.maxMs, 5000, 120000, DEFAULTS.boot.maxMs, warnings, 'boot.maxMs'),
    reducedMotion: asEnum(bootIn.reducedMotion, REDUCED_MOTION, DEFAULTS.boot.reducedMotion, warnings, 'boot.reducedMotion'),
  }

  const saver = {
    enabled: asBool(saverIn.enabled, DEFAULTS.saver.enabled),
    idleMs: clampNumber(saverIn.idleMs, 30000, 3600000, DEFAULTS.saver.idleMs, warnings, 'saver.idleMs'),
    pool: asString(saverIn.pool, DEFAULTS.saver.pool) || DEFAULTS.saver.pool,
    breakEffect: asBool(saverIn.breakEffect, DEFAULTS.saver.breakEffect),
    breakStyle: asEnum(saverIn.breakStyle, BREAK_STYLES, DEFAULTS.saver.breakStyle, warnings, 'saver.breakStyle'),
    hint: asBool(saverIn.hint, DEFAULTS.saver.hint),
    pointerEffect: asEnum(saverIn.pointerEffect, POINTER_EFFECTS, DEFAULTS.saver.pointerEffect, warnings, 'saver.pointerEffect'),
    sound: asBool(saverIn.sound, DEFAULTS.saver.sound),
    volume: clampNumber(saverIn.volume, 0, 1, DEFAULTS.saver.volume, warnings, 'saver.volume'),
    rotateMs: clampNumber(saverIn.rotateMs, 0, 600000, DEFAULTS.saver.rotateMs, warnings, 'saver.rotateMs'),
  }

  const wallpaper = {
    enabled: asBool(wallpaperIn.enabled, DEFAULTS.wallpaper.enabled),
    image: asString(wallpaperIn.image, DEFAULTS.wallpaper.image).slice(0, 2048),
    color: asString(wallpaperIn.color, DEFAULTS.wallpaper.color).slice(0, 64),
    opacity: clampNumber(wallpaperIn.opacity, 0, 1, DEFAULTS.wallpaper.opacity, warnings, 'wallpaper.opacity'),
  }

  const media = {
    disabledClips: asStringArray(mediaIn.disabledClips, warnings, 'media.disabledClips'),
    disabledSavers: asStringArray(mediaIn.disabledSavers, warnings, 'media.disabledSavers'),
  }

  const advanced = {
    diag: asBool(advancedIn.diag, DEFAULTS.advanced.diag),
    trace: asBool(advancedIn.trace, DEFAULTS.advanced.trace),
  }

  const extensions = {
    ...(isObject(input.extensions) ? input.extensions : {}),
    ...extras(input, TOP_KEYS),
    ...(Object.keys(extras(bootIn, BOOT_KEYS)).length ? { boot: extras(bootIn, BOOT_KEYS) } : {}),
    ...(Object.keys(extras(saverIn, SAVER_KEYS)).length ? { saver: extras(saverIn, SAVER_KEYS) } : {}),
    ...(Object.keys(extras(wallpaperIn, WALLPAPER_KEYS)).length ? { wallpaper: extras(wallpaperIn, WALLPAPER_KEYS) } : {}),
  }

  const config = {
    schemaVersion: CONFIG_VERSION,
    enabled: asBool(input.enabled, DEFAULTS.enabled),
    boot,
    saver,
    wallpaper,
    media,
    advanced,
    extensions,
    ...(isObject(input.legacy) ? { legacy: input.legacy } : {}),
  }
  return { config, warnings }
}

function firstDefined(sources, key) {
  for (const source of sources) if (has(source, key) && source[key] !== undefined) return source[key]
  return undefined
}

function consumedFilter(source, consumed, warnings, label) {
  const kept = {}
  if (!isObject(source)) return kept
  for (const key of Object.keys(source)) {
    if (!consumed.includes(key)) kept[key] = source[key]
  }
  return kept
}

/**
 * Merge the three legacy documents into one config.
 *
 * Ownership is per field, not per file, because the two plugins overlap only
 * partially. Animation owns the settings it declared (fade, sound, hint,
 * screensaver); suite owns the fields it alone had (hold/clip/mode). `enabled`
 * is the one field where either plugin saying "yes" keeps the boot screen:
 * disabling one of two formerly-independent plugins must not silently remove
 * the feature the other one provided.
 */
export function migrateLegacy({ suite, animation, wallpaper, mtimes = {}, now = Date.now() } = {}) {
  const warnings = []
  const a = isObject(animation) ? animation : {}
  const s = isObject(suite) ? suite : {}
  const w = isObject(wallpaper) ? wallpaper : {}

  const enabledVotes = [a.enabled, s.enabled].filter((v) => typeof v === 'boolean')
  const enabled = enabledVotes.length ? enabledVotes.some(Boolean) : DEFAULTS.enabled

  const animationEnter = a.enterMode
  const trigger = animationEnter === 'click' ? 'click' : DEFAULTS.boot.trigger

  const raw = {
    schemaVersion: CONFIG_VERSION,
    enabled,
    boot: {
      mode: asEnum(s.mode, MODES, DEFAULTS.boot.mode, warnings, 'legacy.suite.mode'),
      clip: asString(s.clip, DEFAULTS.boot.clip) || DEFAULTS.boot.clip,
      holdMs: clampNumber(s.holdMs, 0, 120000, DEFAULTS.boot.holdMs, warnings, 'legacy.suite.holdMs'),
      fadeMs: clampNumber(
        firstDefined([a, s], 'fadeMs'), 200, 5000, DEFAULTS.boot.fadeMs, warnings, 'legacy.fadeMs'),
      sound: asBool(firstDefined([a, s], 'sound'), DEFAULTS.boot.sound),
      volume: clampNumber(firstDefined([s, a], 'volume'), 0, 1, DEFAULTS.boot.volume, warnings, 'legacy.volume'),
      trigger,
      clickToEnter: asBool(a.clickToEnter, DEFAULTS.boot.clickToEnter),
      showHint: asBool(a.showHint, DEFAULTS.boot.showHint),
      reducedMotion: DEFAULTS.boot.reducedMotion,
    },
    saver: {
      enabled: asBool(a.screensaverEnabled, DEFAULTS.saver.enabled),
      idleMs: clampNumber(a.screensaverIdleMs, 30000, 3600000, DEFAULTS.saver.idleMs, warnings, 'legacy.screensaverIdleMs'),
      pool: DEFAULTS.saver.pool,
      breakEffect: asBool(a.screensaverBreakEffect, DEFAULTS.saver.breakEffect),
      breakStyle: asEnum(a.screensaverBreakStyle, BREAK_STYLES, DEFAULTS.saver.breakStyle, warnings, 'legacy.screensaverBreakStyle'),
      hint: asBool(a.screensaverHint, DEFAULTS.saver.hint),
      pointerEffect: asEnum(a.screensaverPointerEffect, POINTER_EFFECTS, DEFAULTS.saver.pointerEffect, warnings, 'legacy.screensaverPointerEffect'),
      sound: asBool(a.screensaverSound, DEFAULTS.saver.sound),
      volume: clampNumber(a.screensaverVolume, 0, 1, DEFAULTS.saver.volume, warnings, 'legacy.screensaverVolume'),
      rotateMs: clampNumber(a.screensaverRotateMs, 0, 600000, DEFAULTS.saver.rotateMs, warnings, 'legacy.screensaverRotateMs'),
    },
    wallpaper: {
      enabled: asBool(w.enabled, DEFAULTS.wallpaper.enabled),
      image: asString(w.image, DEFAULTS.wallpaper.image).slice(0, 2048),
      color: asString(w.color, DEFAULTS.wallpaper.color).slice(0, 64),
      opacity: clampNumber(w.opacity, 0, 1, DEFAULTS.wallpaper.opacity, warnings, 'legacy.wallpaper.opacity'),
    },
    media: {
      disabledClips: asStringArray(a.disabledClips, warnings, 'legacy.disabledClips'),
      disabledSavers: asStringArray(a.disabledScreensaver, warnings, 'legacy.disabledScreensaver'),
    },
    advanced: { ...DEFAULTS.advanced },
    legacy: {
      migratedAt: now,
      suite: consumedFilter(s, SUITE_CONSUMED, warnings, 'suite'),
      animation: consumedFilter(a, ANIMATION_CONSUMED, warnings, 'animation'),
      wallpaper: consumedFilter(w, WALLPAPER_CONSUMED, warnings, 'wallpaper'),
      sourceMtimes: { ...mtimes },
    },
  }

  const normalized = normalizeDetailed(raw)
  return { config: normalized.config, warnings: [...warnings, ...normalized.warnings] }
}

/** Stable hash of the config, used to skip no-op writes. */
export function configDigest(config) {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex')
}

/**
 * Digest of the legacy sources, used for migration idempotency.
 *
 * Includes mtime and size, so a file edited in place re-triggers migration even
 * when its path is unchanged. Content is not read here: metadata is enough to
 * detect "the user touched it", and avoids hashing multi-megabyte wallpapers.
 */
export function legacyDigest({ suite, animation, wallpaper } = {}) {
  const describe = (source) => {
    if (!isObject(source)) return null
    return {
      path: typeof source.__path === 'string' ? source.__path : '',
      mtimeMs: typeof source.__mtimeMs === 'number' ? source.__mtimeMs : 0,
      size: typeof source.__size === 'number' ? source.__size : 0,
    }
  }
  return createHash('sha256')
    .update(JSON.stringify([describe(suite), describe(animation), describe(wallpaper)]))
    .digest('hex')
}

/** Build the plain, JSON-safe plan handed to the browser. */
export function toRuntimePlan(config, { version, media = {}, base = '', sessionId = '' } = {}) {
  const c = normalize(config)
  return {
    version: version || '0.0.0',
    ...(base ? { base } : {}),
    ...(sessionId ? { sessionId } : {}),
    enabled: c.enabled,
    boot: { ...c.boot },
    saver: { ...c.saver },
    wallpaper: { ...c.wallpaper },
    media: {
      clips: Array.isArray(media.clips) ? media.clips : [],
      savers: Array.isArray(media.savers) ? media.savers : [],
      disabledClips: c.media.disabledClips.slice(),
      disabledSavers: c.media.disabledSavers.slice(),
    },
    advanced: { diag: c.advanced.diag, trace: c.advanced.trace },
  }
}

/** Read a config file; a corrupt file is preserved as `.corrupt-<ts>` and defaults win. */
export async function readConfigFile(file, { fs = fsp, now = Date.now } = {}) {
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { config: normalize({}), exists: false, warnings: [] }
    }
    return {
      config: normalize({}),
      exists: false,
      warnings: [`config read failed: ${error.message}`],
    }
  }
  try {
    const parsed = JSON.parse(text)
    const result = normalizeDetailed(parsed)
    return { config: result.config, exists: true, warnings: result.warnings }
  } catch (error) {
    const backup = `${file}.corrupt-${now()}`
    try { await fs.copyFile(file, backup) } catch { /* best effort */ }
    return {
      config: normalize({}),
      exists: true,
      corrupt: true,
      backup,
      warnings: [`config corrupted (${error.message}); original kept at ${backup}`],
    }
  }
}

/** Write the config through a same-directory temp file + rename. */
export async function writeConfigFileAtomic(file, config, { fs = fsp, now = Date.now } = {}) {
  const normalized = normalize(config)
  const payload = { ...normalized }
  delete payload.warnings
  const text = `${JSON.stringify(payload, null, 2)}\n`
  const tmp = `${file}.tmp-${process.pid}-${now()}`
  await fs.mkdir(dirname(file), { recursive: true })
  try {
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, file)
  } catch (error) {
    try { await fs.rm(tmp, { force: true }) } catch { /* best effort */ }
    throw error
  }
  return { file, bytes: Buffer.byteLength(text), digest: configDigest(payload) }
}
