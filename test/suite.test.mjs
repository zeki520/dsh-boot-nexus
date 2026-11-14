import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { buildBootActs, buildSuitePlan, effectiveSuiteConfig, findSuitePackage, listSuiteTemplates, projectSuiteConfig, rewriteSplash } from '../src/host/suite.js'
import { createSuiteRoutes } from '../src/host/suite-routes.js'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SUITE_ROOT = process.env.DSH_SUITE_ROOT ||
  join(HOME, 'profiles', 'desktop', 'node_modules', 'dsh-boot-suite')
const available = existsSync(join(SUITE_ROOT, 'package.json'))

class Capture extends Writable {
  constructor() {
    super()
    this.status = 0
    this.headers = {}
    this.chunks = []
  }
  writeHead(status, headers) { this.status = status; this.headers = headers || {} }
  _write(chunk, _encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback() }
  get body() { return Buffer.concat(this.chunks).toString('utf8') }
}

function plan(overrides = {}) {
  return buildSuitePlan({
    home: HOME,
    suiteRoot: SUITE_ROOT,
    routeBase: '/dsh-boot-nexus',
    token: 'test-token',
    nonce: 'test-nonce',
    act1: 'auto',
    act2: 'auto',
    act2Ms: 3000,
    ...overrides,
  })
}

test('suite plan loads the original runtime and trims the second act only when asked', { skip: !available && 'suite not installed' }, () => {
  const full = plan({ act2Ms: 0 })
  assert.equal(full.ok, true)
  assert.equal(full.act1Id, 'archive-warm')
  assert.equal(full.act2Id, 'custom-mw4issgp')
  assert.equal(full.trimMs, 0)
  assert.equal(full.template2.duration, 8064)

  const built = plan({ act2Ms: 3000 })
  assert.equal(built.ok, true)
  assert.equal(built.template2.duration, 3000)
  assert.deepEqual(built.template2.segments, [{ name: 'trim', from: 0, to: 3000 }])
  assert.equal(built.base, '/dsh-boot-nexus/suite/test-token')
})

test('suite step hold can raise every text step above the template timing', { skip: !available && 'suite not installed' }, () => {
  const original = plan({ act2Ms: 0 })
  assert.equal(original.template.steps[0].hold, 900)

  const raised = plan({ act2Ms: 0, stepHoldMs: 3000 })
  assert.ok(raised.template.steps.length > 0)
  assert.ok(raised.template.steps.every((step) => step.hold >= 3000))

  const zero = plan({ act2Ms: 0, stepHoldMs: 0 })
  assert.equal(zero.template.steps[0].hold, 900)
})

test('popup hold raises only the confirm card, never the whole act', { skip: !available && 'suite not installed' }, () => {
  const original = plan({ act2Ms: 0 })
  const confirmIndex = original.template.steps.findIndex((step) => step.action === 'confirm')
  assert.ok(confirmIndex >= 0)
  const before = original.template.steps[confirmIndex].hold

  const raised = plan({ act2Ms: 0, popupMs: 3000 })
  assert.equal(raised.template.steps[confirmIndex].hold, Math.max(before, 3000))
  for (let i = 0; i < raised.template.steps.length; i++) {
    if (i === confirmIndex) continue
    assert.equal(raised.template.steps[i].hold, original.template.steps[i].hold)
  }

  const zero = plan({ act2Ms: 0, popupMs: 0 })
  assert.equal(zero.template.steps[confirmIndex].hold, before)
})

test('suite projection keeps sfx so the settings card can round-trip it', () => {
  const projected = projectSuiteConfig({ sfx: 'synth', identity: 'OP', noise: 'drop' })
  assert.equal(projected.sfx, 'synth')
  assert.equal(projected.identity, 'OP')
  assert.equal('noise' in projected, false)
})

test('voicePack always projects to a pack that ships, so a fresh install is not silent', () => {
  // splash.js falls back to 'a' when the key is missing, and no 'a' pack exists.
  assert.equal(projectSuiteConfig({}).voicePack, 'f')
  assert.equal(projectSuiteConfig({ voicePack: 'builtin' }).voicePack, 'f')
  assert.equal(projectSuiteConfig({ voicePack: 'a' }).voicePack, 'f')
  assert.equal(projectSuiteConfig({ voicePack: 'zzz' }).voicePack, 'f')
  assert.equal(projectSuiteConfig({ voicePack: '  ' }).voicePack, 'f')
  assert.equal(projectSuiteConfig({ voicePack: 'k' }).voicePack, 'k')
  assert.equal(projectSuiteConfig({ voicePack: 'g' }).voicePack, 'g')
})

test('nexus suite overrides win over the legacy suite config', { skip: !available && 'suite not installed' }, () => {
  const built = plan({
    act2Ms: 0,
    config: { extensions: { suite: { identity: 'NEXUS OPERATOR', bgmBpm: 123 } } },
  })
  assert.equal(built.ok, true)
  assert.equal(built.config.identity, 'NEXUS OPERATOR')
  assert.equal(built.config.bgmBpm, 123)
})

test('the settings card can show effective legacy values without a template', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbn-suite-config-'))
  try {
    writeFileSync(join(dir, 'dsh-startup.json'), JSON.stringify({
      identity: 'JOYCE MOORE',
      identityId: '0087',
      accessLevel: '3',
      bgmBpm: 100,
    }))
    const shown = effectiveSuiteConfig({
      home: dir,
      config: { extensions: { suite: { identity: 'NEXUS OPERATOR' } } },
    })
    assert.equal(shown.identity, 'NEXUS OPERATOR')
    assert.equal(shown.identityId, '0087')
    assert.equal(shown.accessLevel, '3')
    assert.equal(shown.bgmBpm, 100)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the template picker lists suite and user templates', { skip: !available && 'suite not installed' }, () => {
  const list = listSuiteTemplates({ home: HOME, suiteRoot: SUITE_ROOT })
  const ids = list.map((item) => item.id)
  assert.ok(ids.includes('archive-warm'))
  assert.ok(ids.includes('custom-mw4issgp'))
  assert.ok(list.every((item) => item.id && item.name))
})

test('splash rewrite replaces every suite URL and leaves no old prefix', { skip: !available && 'suite not installed' }, () => {
  const source = readFileSync(join(SUITE_ROOT, 'lib', 'splash.js'), 'utf8')
  const rewritten = rewriteSplash(source, '/dsh-boot-nexus/suite/test-token')
  assert.equal(/\/dsh-startup/.test(rewritten), false)
  assert.ok(rewritten.includes('/dsh-boot-nexus/suite/test-token/splash.js'))
})

test('the frame document carries the suite globals and no old prefix', { skip: !available && 'suite not installed' }, async () => {
  const built = plan()
  const base = built.base
  const routes = createSuiteRoutes({
    base,
    getPlan: () => built,
    suiteRoot: SUITE_ROOT,
    splashSource: rewriteSplash(readFileSync(join(SUITE_ROOT, 'lib', 'splash.js'), 'utf8'), base),
    splashCss: readFileSync(join(SUITE_ROOT, 'lib', 'splash.css'), 'utf8'),
    home: HOME,
  })
  const route = routes[0]
  assert.equal(route.path, base)

  const frame = new Capture()
  route.handler({ url: base + '/frame', method: 'GET' }, frame)
  assert.equal(frame.status, 200)
  assert.match(frame.body, /__DSH_STARTUP_TEMPLATE__/)
  assert.match(frame.body, /archive-warm/)
  assert.doesNotMatch(frame.body, /\/dsh-startup/)

  const js = new Capture()
  route.handler({ url: base + '/splash.js', method: 'GET' }, js)
  assert.equal(js.status, 200)
  assert.match(js.body, /\/dsh-boot-nexus\/suite\/test-token\/splash\.js/)
  assert.doesNotMatch(js.body, /\/dsh-startup/)

  const asset = new Capture()
  const finished = new Promise((resolve) => asset.on('finish', resolve))
  route.handler({ url: base + '/asset/sfx-tick.mp3', method: 'GET' }, asset)
  await finished
  assert.equal(asset.status, 200)
  assert.ok(asset.chunks.length > 0)
})

test('a suite choice owns both acts and never appends the animation pool', () => {
  const suite = { url: '/dsh-boot-nexus/suite/t/frame' }
  assert.deepEqual(buildBootActs('suite', suite), [{ kind: 'suite', suite }])
  assert.deepEqual(buildBootActs('clip', suite), [{ kind: 'pool', pool: 'clips' }])
  assert.deepEqual(buildBootActs('suite', null), [{ kind: 'pool', pool: 'clips' }])
})

test('the vendored suite engine is found without the original package', () => {
  const found = findSuitePackage()
  assert.equal(found.ok, true)
  assert.equal(found.vendored, true)
  assert.ok(existsSync(join(found.root, 'lib', 'splash.js')))
  assert.ok(existsSync(join(found.root, 'templates', 'archive-warm', 'template.json')))
})
