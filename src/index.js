/**
 * dsh-boot-nexus — Host half.
 *
 * One plugin, one index row set, one full-screen layer, one config truth.
 *
 * The Host half does not draw anything. It resolves the plan, serves the media
 * allowlist, mounts the runtime and contributes the one script row. The browser
 * half (lib/runtime.js) owns every pixel and every timer after that.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

import {
  PLUGIN_NAME,
  PLUGIN_VERSION,
  ROUTE_BASE,
  INJECT,
} from './shared/constants.js'
import {
  normalize,
  migrateLegacy,
  readConfigFile,
  writeConfigFileAtomic,
  configDigest,
  toRuntimePlan,
} from './host/config.js'
import { CRITICAL_CSS } from './host/css.js'
import { buildRows, contribute } from './host/rows.js'
import { buildMediaPlan, mediaIds, mimeOf } from './host/assets.js'
import { seedBundledMedia } from './host/seed.js'
import { buildBootActs, buildSuitePlan, effectiveSuiteConfig, findSuitePackage, listSuiteTemplates, rewriteSplash } from './host/suite.js'
import { createSuiteRoutes } from './host/suite-routes.js'
import { createRoutes, createTrustFence, mountRoutes } from './host/routes.js'

const packageRoot = fileURLToPath(new URL('.', import.meta.url))
const runtimePath = join(packageRoot, '..', 'lib', 'runtime.js')
/* A new host apply means a new app session, so the session marker must differ. */
const installSessionId = randomUUID()
const mediaToken = randomUUID()
const suiteToken = randomBytes(32).toString('hex')
const suiteNonce = randomBytes(16).toString('hex')

const VOLATILE_REF = Symbol.for('cosmokit.volatile.write')
const isLive = (value) => typeof value === 'object' && value !== null && VOLATILE_REF in value

function readField(config, key) {
  const value = config?.[key]
  return isLive(value) && typeof value.get === 'function' ? value.get() : value
}

function materialize(value) {
  if (isLive(value)) {
    return typeof value.get === 'function' ? materialize(value.get()) : undefined
  }
  if (Array.isArray(value)) return value.map(materialize)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) out[key] = materialize(value[key])
    return out
  }
  return value
}

/**
 * Only two host-side paths are configurable. Everything the user sees lives in
 * `$DSH_HOME/dsh-boot-nexus.json`; putting behaviour fields here as well would
 * recreate the two-truths bug this plugin exists to remove.
 */
export const Config = z.object({
  configFile: z.string().default(''),
  mediaDir: z.string().default(''),
})

async function readJsonFile(file, log) {
  try {
    const st = await fsp.stat(file)
    if (!st.isFile()) return null
    const text = await fsp.readFile(file, 'utf8')
    return { value: JSON.parse(text), mtimeMs: st.mtimeMs, size: st.size }
  } catch (error) {
    if (error && error.code !== 'ENOENT') log(`legacy read failed ${file}: ${error.message}`)
    return null
  }
}

async function readFirstJson(files, log) {
  for (const file of files) {
    const hit = await readJsonFile(file, log)
    if (hit) return hit
  }
  return null
}

async function scanPool(dir) {
  let names
  try {
    names = await fsp.readdir(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    const mime = mimeOf(name)
    if (mime === 'application/octet-stream') continue
    // SVG is a document that can carry script; it does not belong in a
    // same-origin boot pool. Raster images and video only.
    if (name.toLowerCase().endsWith('.svg')) continue
    const path = join(dir, name)
    try {
      const st = await fsp.stat(path)
      if (!st.isFile() || st.size > 512 * 1024 * 1024) continue
      out.push({ name, path, size: st.size })
    } catch {
      /* a file that vanished between readdir and stat is not an error */
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

function publicEntry(entry) {
  return { id: entry.id, name: entry.name, mime: entry.mime, kind: entry.kind, size: entry.size }
}

export async function apply(ctx, config) {
  const options = materialize(config) || {}
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const suiteBase = `${ROUTE_BASE}/suite/${suiteToken}`
  const suitePkg = findSuitePackage()
  let splashSource = ''
  let splashCss = ''
  if (suitePkg.ok) {
    try {
      splashSource = rewriteSplash(readFileSync(join(suitePkg.root, 'lib', 'splash.js'), 'utf8'), suiteBase)
      splashCss = readFileSync(join(suitePkg.root, 'lib', 'splash.css'), 'utf8')
    } catch (error) {
      diag(`suite: disabled (${error && error.message ? error.message : error})`)
    }
  } else {
    diag(`suite: disabled (${suitePkg.reason})`)
  }
  const configFile = readField(options, 'configFile') || join(home, 'dsh-boot-nexus.json')
  const mediaRoot = readField(options, 'mediaDir') || join(home, 'boot-nexus', 'media')
  const clipsDir = join(mediaRoot, 'clips')
  const saversDir = join(mediaRoot, 'savers')
  const diagFile = join(home, 'dsh-boot-nexus-diag.log')
  let runtime
  try {
    runtime = readFileSync(runtimePath, 'utf8')
  } catch (error) {
    throw new Error(`dsh-boot-nexus: cannot read ${runtimePath}; run "npm run build" before installing (${error.message})`)
  }
  let iconPng = null
  try {
    iconPng = readFileSync(join(packageRoot, '..', 'assets', 'icon', 'icon-64.png'))
  } catch {
    /* the card falls back to the slot's default artwork */
  }

  let diagStarted = false
  function diag(line) {
    try {
      if (!diagStarted) {
        writeFileSync(diagFile, '')
        diagStarted = true
      }
      appendFileSync(diagFile, `${new Date().toISOString()} ${line}\n`)
    } catch {
      /* diagnostics are best effort by design */
    }
  }

  diag(`apply ${PLUGIN_NAME}@${PLUGIN_VERSION} home=${home}`)
  if (!runtime.includes('function dbnBootMain')) {
    throw new Error('dsh-boot-nexus: lib/runtime.js is missing the runtime; run `npm run build`')
  }

  await fsp.mkdir(clipsDir, { recursive: true })
  await fsp.mkdir(saversDir, { recursive: true })
  /**
   * A fresh install has no media anywhere on disk, and an empty pool means no
   * intro and no screensaver at all. The package ships a small default set
   * under assets/media; copy it in once so the first launch already animates.
   */
  await seedBundledMedia({
    bundleDir: join(packageRoot, '..', 'assets', 'media'),
    mediaRoot,
    log: (line) => diag(line),
  })

  let state
  let configWarnings = []
  const loaded = await readConfigFile(configFile)
  if (loaded.exists) {
    state = loaded.config
    configWarnings = loaded.warnings
    if (loaded.corrupt) {
      await writeConfigFileAtomic(configFile, state)
      diag('config: corrupt file backed up and defaults restored')
    }
    diag(`config: loaded ${configFile}`)
  } else {
    const suite = await readJsonFile(join(home, 'dsh-startup.json'), diag)
    const wallpaper = await readJsonFile(join(home, 'chat-wallpaper.json'), diag)
    const animation = await readFirstJson([
      join(home, 'dsh-boot-animation.json'),
      join(home, 'boot-animation.json'),
      join(home, 'settings', 'boot-animation.json'),
      join(home, 'boot-nexus', 'legacy-animation.json'),
    ], diag)
    const migrated = migrateLegacy({
      suite: suite?.value,
      animation: animation?.value,
      wallpaper: wallpaper?.value,
      mtimes: {
        suite: suite?.mtimeMs,
        animation: animation?.mtimeMs,
        wallpaper: wallpaper?.mtimeMs,
      },
    })
    state = migrated.config
    configWarnings = migrated.warnings
    await writeConfigFileAtomic(configFile, state)
    diag(`config: migrated suite=${!!suite} animation=${!!animation} wallpaper=${!!wallpaper}`)
    for (const warning of configWarnings) diag(`config warning: ${warning}`)
  }

  const mediaPlan = { clips: [], savers: [] }
  async function refreshMedia() {
    const clips = await scanPool(clipsDir)
    const savers = await scanPool(saversDir)
    const next = buildMediaPlan({ clips, savers })
    mediaPlan.clips = next.clips
    mediaPlan.savers = next.savers
    diag(`media: ${mediaPlan.clips.length} clips, ${mediaPlan.savers.length} savers under ${mediaRoot}`)
  }
  await refreshMedia()

  function buildCurrentSuite() {
    if (!suitePkg.ok || !splashSource) return { ok: false, reason: suitePkg.reason || 'suite-runtime-missing' }
    const current = normalize(state)
    return buildSuitePlan({
      home,
      suiteRoot: suitePkg.root,
      routeBase: ROUTE_BASE,
      token: suiteToken,
      nonce: suiteNonce,
      act1: current.boot.suiteAct1,
      act2: current.boot.suiteAct2,
      act2Ms: current.boot.suiteAct2Ms,
      stepHoldMs: current.boot.suiteHoldMs,
      popupMs: current.boot.suitePopupMs,
      config: current,
    })
  }

  function getPlan() {
    const current = normalize(state)
    const plan = toRuntimePlan(current, {
      version: PLUGIN_VERSION,
      media: mediaPlan,
      sessionId: installSessionId,
    })
    plan.base = ROUTE_BASE
    plan.mediaToken = mediaToken
    plan.media.clips = mediaPlan.clips.map(publicEntry)
    plan.media.savers = mediaPlan.savers.map(publicEntry)
    plan.media.ids = mediaIds(mediaPlan)

    let choice = current.boot.choice
    if (choice === 'random') choice = randomInt(2) === 0 ? 'clip' : 'suite'
    let suite = null
    let choiceFallback = null
    if (choice === 'suite') {
      const built = buildCurrentSuite()
      if (built.ok) {
        suite = {
          base: built.base,
          url: built.base + '/frame',
          nonce: built.nonce,
          act1Id: built.act1Id,
          act2Id: built.act2Id,
          trimMs: built.trimMs,
          durationMs: built.durationMs,
        }
      } else {
        choice = 'clip'
        choiceFallback = built.reason || 'suite-unavailable'
        diag(`suite: fallback to clip (${choiceFallback})`)
      }
    }
    plan.choice = choice
    plan.choiceFallback = choiceFallback
    /* A suite choice owns its own two acts. It must never hand over to the
       animation pool: that produced a third, unrelated video after suite's
       act2. If the frame fails, fail open to the desktop instead. */
    plan.acts = buildBootActs(choice, suite)
    if (choice === 'suite') plan.boot.maxMs = Math.max(plan.boot.maxMs, 180000)
    return plan
  }

  function getConfigPayload() {
    const current = normalize(state)
    let suiteConfig = {}
    try {
      suiteConfig = effectiveSuiteConfig({ home, config: current })
    } catch {
      /* an unavailable suite must not make the settings card unreadable */
    }
    return {
      config: current,
      warnings: configWarnings,
      media: mediaIds(mediaPlan),
      suiteTemplates: listSuiteTemplates({ home, suiteRoot: suitePkg.ok ? suitePkg.root : null }),
      suiteConfig,
      paths: {
        home,
        media: mediaRoot,
        clips: join(mediaRoot, 'clips'),
        savers: join(mediaRoot, 'savers'),
        config: configFile,
        suite: suitePkg.ok ? suitePkg.root : '',
      },
      digest: configDigest(current),
      version: PLUGIN_VERSION,
    }
  }

  async function persist(input) {
    const raw = input && typeof input === 'object' && input.config ? input.config : input
    const next = normalize(raw)
    const current = normalize(state)
    if (configDigest(next) === configDigest(current)) {
      return { ok: true, unchanged: true, config: current, media: mediaIds(mediaPlan) }
    }
    const saved = await writeConfigFileAtomic(configFile, next)
    state = next
    configWarnings = []
    diag(`config: saved ${saved.file} digest=${saved.digest}`)
    return { ok: true, config: normalize(state), media: mediaIds(mediaPlan), digest: saved.digest }
  }

  let writeChain = Promise.resolve()
  function saveConfig(input) {
    const run = writeChain.catch(() => {}).then(() => persist(input))
    writeChain = run.catch(() => {})
    return run
  }

  const trust = createTrustFence(ctx.connection, { enabled: true })
  const routes = createRoutes({
    getPlan,
    mediaPlan,
    runtime,
    version: PLUGIN_VERSION,
    trust,
    mediaToken,
    iconPng,
    getConfig: async () => {
      await refreshMedia()
      return getConfigPayload()
    },
    saveConfig,
    appendDiag: (payload) => diag(`client ${JSON.stringify(payload)}`),
  })
  const suiteRoutes = suitePkg.ok && splashSource
    ? createSuiteRoutes({
        base: suiteBase,
        getPlan: buildCurrentSuite,
        suiteRoot: suitePkg.root,
        splashSource,
        splashCss,
        home,
      })
    : []
  const allRoutes = routes.concat(suiteRoutes)

  function onIndexInject(table) {
    if (!normalize(state).enabled) return { added: 0, skipped: 'disabled' }
    try {
      const rows = buildRows({ plan: getPlan(), runtime, css: CRITICAL_CSS, version: PLUGIN_VERSION })
      const result = contribute(table, rows)
      diag(`inject: ${JSON.stringify(result)}`)
      return result
    } catch (error) {
      diag(`inject failed: ${error && error.stack ? error.stack : error}`)
      return { added: 0, skipped: 'error' }
    }
  }

  ctx.effect(() => {
    const off = ctx.on('webserver/index-inject', onIndexInject)
    return () => off()
  })

  ctx.effect(() => {
    const dispose = mountRoutes(ctx.webServer, allRoutes)
    diag(`routes: mounted ${allRoutes.length} under ${ROUTE_BASE}`)
    return () => {
      dispose()
      diag('routes: removed')
    }
  })

  diag('apply: ready')
}

export const name = PLUGIN_NAME
export const inject = INJECT

export default { name, inject, apply, Config }
