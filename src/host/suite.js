import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const VENDOR_ROOT = resolve(HERE, '..', '..', 'assets', 'suite')
const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
const SUITE_VERSION_RE = /^2\.16\./

/**
 * Locate the installed suite package without importing it.
 *
 * suite is a sibling dependency in the profile; Node's resolver finds it when
 * the package exports are permissive, and the ancestor walk covers profiles
 * where the package has an `exports` map that hides package.json.
 */
export function findSuitePackage() {
  /* The vendored copy is the supported runtime: it survives the user deleting
     the original dsh-boot-suite package, and it is the copy we can test. */
  if (existsSync(join(VENDOR_ROOT, 'lib', 'splash.js'))) {
    const vendored = finishSuite(VENDOR_ROOT)
    if (vendored.ok) return { ...vendored, vendored: true }
  }
  try {
    const pkg = require.resolve('dsh-boot-suite/package.json')
    return finishSuite(dirname(pkg))
  } catch { /* fall through */ }
  let dir = HERE
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'node_modules', 'dsh-boot-suite', 'package.json')
    if (existsSync(candidate)) return finishSuite(dirname(candidate))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { ok: false, reason: 'suite-package-not-found' }
}

function finishSuite(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const version = String(pkg.version || '')
    if (!SUITE_VERSION_RE.test(version)) {
      return { ok: false, reason: `suite-version-unsupported:${version}`, root, version }
    }
    if (!existsSync(join(root, 'lib', 'splash.js'))) {
      return { ok: false, reason: 'suite-splash-missing', root, version }
    }
    return { ok: true, root, version }
  } catch (error) {
    return { ok: false, reason: `suite-package-invalid:${error.message}`, root }
  }
}

export function readSuiteConfig(home) {
  const file = join(home, 'dsh-startup.json')
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export function loadTemplate(id, { home, suiteRoot }) {
  if (!TEMPLATE_ID_RE.test(String(id || ''))) return null
  const roots = [
    join(home, 'startup-templates', id),
    join(suiteRoot, 'templates', id),
  ]
  for (const root of roots) {
    const file = join(root, 'template.json')
    try {
      if (!statSync(file).isFile()) continue
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (!raw || raw.id !== id) continue
      if (!Array.isArray(raw.steps) && !Array.isArray(raw.layers)) continue
      return { template: raw, root }
    } catch { /* next root */ }
  }
  return null
}

/**
 * Voice packs shipped in assets/suite/lib/assets/voices (see manifest.json):
 * f is the English default, g..k are Japanese. splash.js falls back to the
 * literal 'a' when voicePack is unset, and no such pack ships — the frame then
 * requests /suite/<token>/voice/a/line-1.mp3 and the route answers 404, so a
 * fresh install plays the six acts silently. Normalise here so every plan
 * carries a pack that actually exists.
 */
export function normalizeVoicePack(value) {
  const pack = typeof value === 'string' ? value.trim() : ''
  if (pack === 'builtin') return 'f'
  return /^[f-k]$/.test(pack) ? pack : 'f'
}

/** The subset of suite settings nexus is willing to carry into the frame. */
export function projectSuiteConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const keys = [
    'theme', 'speed', 'requireInteraction', 'allowSkip', 'sound', 'soundVolume',
    'bedNoise', 'sfx', 'voice', 'voiceLang', 'voiceName', 'voiceRate', 'voicePitch',
    'voiceVolume', 'voiceCue', 'voiceSource', 'voicePack', 'voiceFx', 'voiceLead',
    'welcomeDelay', 'identity', 'identityId', 'accessLevel', 'brand1', 'brand2',
    'brand3a', 'brand3b', 'orgZh', 'orgEn', 'orgSub', 'welcomeBox', 'footer',
    'accent', 'glitchA', 'glitchB', 'transitionIn', 'transitionJoin', 'transitionOut',
    'transitionMs', 'transitionDir', 'bgmEnabled', 'bgmLoop', 'bgmFile', 'bgmFile2',
    'bgmVolume', 'bgmDuck', 'bgmFade', 'act1VideoSound', 'act2VideoSound',
    'bigfishUsername', 'bigfishTitle', 'bigfishDesc', 'bigfishForceEgg',
    'bigfishVoiceFx', 'bigfishVoiceVolume',
    'bgmBpm', 'bgmBeats1', 'bgmBeats2', 'bgm1Start', 'bgm2Start',
    'bgm1FadeIn', 'bgm1FadeOut', 'bgm2FadeIn', 'bgm2FadeOut',
    'bgmCrossfade', 'bgm2Loop',
  ]
  const out = {}
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  out.voicePack = normalizeVoicePack(source.voicePack)
  return out
}

/**
 * Rewrite the one hard-coded URL family in splash.js. The assertion is the
 * point: a future suite release that changes the shape must fail closed into
 * the animation-only branch instead of serving a broken frame.
 */
export function rewriteSplash(source, base) {
  if (typeof source !== 'string' || !source) throw new Error('empty splash source')
  const matches = source.match(/\/dsh-startup/g)
  const count = matches ? matches.length : 0
  if (count < 1) throw new Error('splash has no /dsh-startup prefix')
  const rewritten = source.split('/dsh-startup').join(base)
  if (/\/dsh-startup/.test(rewritten)) throw new Error('splash prefix rewrite incomplete')
  if ((rewritten.match(new RegExp(escapeRe(base), 'g')) || []).length < count) {
    throw new Error('splash prefix rewrite lost occurrences')
  }
  return rewritten
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const SUITE_TEMPLATE_ID_RE = TEMPLATE_ID_RE

/**
 * The template picker's source of truth: user templates first (a user copy
 * overrides a built-in id), then the suite package. Only id/name/duration are
 * exposed; a template's own files stay behind the suite token route.
 */
export function listSuiteTemplates({ home, suiteRoot } = {}) {
  const out = new Map()
  const roots = []
  if (home) roots.push(join(home, 'startup-templates'))
  if (suiteRoot) roots.push(join(suiteRoot, 'templates'))
  for (const root of roots) {
    let entries = []
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory() || !TEMPLATE_ID_RE.test(entry.name)) continue
      const file = join(root, entry.name, 'template.json')
      let template
      try { template = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
      if (!template || template.id !== entry.name) continue
      const duration = Number(template.duration)
      out.set(entry.name, {
        id: entry.name,
        name: String(template.name || entry.name),
        duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
        kind: Array.isArray(template.layers) && template.layers.length ? 'timeline'
          : Array.isArray(template.steps) && template.steps.length ? 'steps'
            : 'other',
      })
    }
  }
  return Array.from(out.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

/**
 * Merge the three suite configuration layers without requiring a template.
 * The settings card needs the effective values even when the selected act2
 * template is missing, so this stays independent from buildSuitePlan.
 */
function mergeSuiteConfig(home, config) {
  const raw = readSuiteConfig(home)
  const legacy = config && config.legacy && config.legacy.suite && typeof config.legacy.suite === 'object'
    ? config.legacy.suite : {}
  const overrides = config && config.extensions && config.extensions.suite && typeof config.extensions.suite === 'object'
    ? config.extensions.suite : {}
  return { ...legacy, ...raw, ...overrides }
}

/** The values the settings card should display for the original suite fields. */
export function effectiveSuiteConfig({ home, config }) {
  return projectSuiteConfig(mergeSuiteConfig(home, config))
}

/** Build one immutable suite plan; the shell is rendered from it per request. */
export function buildSuitePlan({ home, suiteRoot, routeBase, token, nonce, act1, act2, act2Ms, stepHoldMs = 0, popupMs = 0, config }) {
  if (!suiteRoot) return { ok: false, reason: 'suite-root-missing' }
  const merged = mergeSuiteConfig(home, config)
  const firstId = String(act1 && act1 !== 'auto' ? act1 : (merged.template || 'archive-warm'))
  const first = loadTemplate(firstId, { home, suiteRoot })
  if (!first) return { ok: false, reason: `act1-not-found:${firstId}` }

  let secondId = act2 && act2 !== 'auto' ? act2 : (merged.act2 || '')
  if (secondId === 'none' || secondId === 'off' || secondId === '') secondId = ''
  let second = secondId ? loadTemplate(secondId, { home, suiteRoot }) : null
  if (secondId && !second) return { ok: false, reason: `act2-not-found:${secondId}` }
  const trimMs = Math.max(0, Math.min(120000, Number(act2Ms) || 0))
  const template = applyPopupHold(applyStepHold(first.template, stepHoldMs), popupMs)
  const template2 = second ? applyPopupHold(applyStepHold(trimTemplate(second.template, trimMs), stepHoldMs), popupMs) : null
  const firstDuration = Math.max(0, Number(first.template && first.template.duration) || 0)
  const secondDuration = Math.max(0, Number(template2 && template2.duration) || 0)

  const base = `${routeBase}/suite/${token}`
  return {
    ok: true,
    base,
    token,
    nonce,
    template,
    template2,
    act1Id: firstId,
    act2Id: second ? secondId : '',
    trimMs,
    config: projectSuiteConfig(merged),
    durationMs: Math.min(600000, Math.max(30000, firstDuration + secondDuration + 15000)),
  }
}

/**
 * Suite v1 templates drive each text step with `steps[].hold`. The original
 * engine never waits longer than the template says, so an unattended boot can
 * flash past the first two steps. Raise every hold to the user's floor without
 * touching the template on disk.
 */
function applyStepHold(template, holdMs) {
  const hold = Math.max(0, Math.min(60000, Number(holdMs) || 0))
  if (!template || !hold || !Array.isArray(template.steps)) return template
  const copy = JSON.parse(JSON.stringify(template))
  for (const step of copy.steps) {
    const current = Number(step && step.hold) || 0
    step.hold = Math.max(current, hold)
  }
  return copy
}

/**
 * The identity card is an action step: the original engine hides it as soon as
 * the confirmation gate resolves, so `steps[].hold` never applied to it. Raise
 * only the confirm step's hold; the configured dwell is consumed by the patched
 * action branch in `assets/suite/lib/splash.js`.
 */
function applyPopupHold(template, popupMs) {
  const hold = Math.max(0, Math.min(60000, Number(popupMs) || 0))
  if (!template || !hold || !Array.isArray(template.steps)) return template
  const copy = JSON.parse(JSON.stringify(template))
  for (const step of copy.steps) {
    if (!step || step.action !== 'confirm') continue
    const current = Number(step.hold) || 0
    step.hold = Math.max(current, hold)
  }
  return copy
}

function trimTemplate(template, maxMs) {
  if (!template || !maxMs) return template
  const duration = Number(template.duration) || 0
  if (duration > 0 && duration <= maxMs) return template
  const copy = JSON.parse(JSON.stringify(template))
  copy.duration = maxMs
  if (Array.isArray(copy.segments)) {
    copy.segments = [{ name: 'trim', from: 0, to: maxMs }]
  }
  if (Array.isArray(copy.layers)) {
    for (const layer of copy.layers) {
      if (!Array.isArray(layer.keyframes)) continue
      for (const frame of layer.keyframes) {
        if (typeof frame.t === 'number' && frame.t > maxMs) frame.t = maxMs
      }
    }
  }
  return copy
}

/**
 * A suite choice is self-contained: splash.js plays act1 and act2 itself.
 * Appending a pool act after it produced a third, unrelated video, so the
 * normal path is exactly one suite act. Only the clip choice uses the pool.
 */
export function buildBootActs(choice, suite) {
  if (choice === 'suite' && suite) return [{ kind: 'suite', suite }]
  return [{ kind: 'pool', pool: 'clips' }]
}
