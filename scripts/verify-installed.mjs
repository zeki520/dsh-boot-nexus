/**
 * Verify the *installed* package without restarting the desktop app.
 *
 * It loads the real installed entry, runs apply() against a fake Cordis
 * context, then exercises the same index-injection and route handlers the host
 * would. This proves the package on disk is coherent and that the media pool is
 * discoverable; it does not prove the desktop renderer executes the inline
 * script (that needs a restarted app).
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/* Point DSH_PROFILE_DIR at another profile directory to verify that install.
 * DSH_PROFILE is usually just the profile *name* ("desktop"), so ignore it. */
const override = process.env.DSH_PROFILE_DIR
const profile = override && isAbsolute(override) ? override : join(homedir(), '.dsh', 'profiles', 'desktop')
const packageRoot = join(profile, 'node_modules', 'dsh-boot-nexus')
const require = createRequire(join(profile, 'node_modules') + '/')
const mod = await import(pathToFileURL(join(packageRoot, 'src', 'index.js')).href)

const listeners = new Map()
const routes = []
const disposers = []
const ctx = {
  connection: { requestRejection: () => ({ reject: false }) },
  webServer: { register(route) { routes.push(route); return () => {} } },
  on(event, cb) { listeners.set(event, cb); return () => {} },
  effect(fn) { const d = fn(); disposers.push(d); return () => {} },
}

await mod.apply(ctx, {})
assert.equal(listeners.has('webserver/index-inject'), true, 'index listener registered')
assert.ok(routes.length >= 5, `routes registered (${routes.length})`)

const table = []
const contributed = listeners.get('webserver/index-inject')(table)
assert.deepEqual(contributed, { added: 4, skipped: null })
const rows = table
assert.equal(rows.length, 4, `expected 4 rows, got ${rows.length}`)
assert.deepEqual(rows.map((r) => r.kind), ['style', 'global', 'global', 'script'])
assert.equal(rows[1].name, '__DBN_PLAN__')
assert.equal(rows[2].name, '__DBN_VERSION__')
assert.match(rows[3].text, /function dbnBootMain/)
const pkg = require(join(packageRoot, 'package.json'))
const plan = rows[1].value
assert.equal(plan.version, pkg.version)
assert.equal(plan.base, '/dsh-boot-nexus')
assert.equal(typeof plan.sessionId, 'string')
assert.ok(plan.sessionId.length >= 8)
assert.equal(plan.media.clips.length, 5, `clips ${plan.media.clips.length}`)
assert.equal(plan.media.savers.length, 7, `savers ${plan.media.savers.length}`)
assert.equal(plan.media.clips[0].path, undefined, 'absolute path must not leak into the plan')
assert.equal(rows.some((r) => JSON.stringify(r).includes('dsh-startup-root')), false)
assert.equal(plan.acts.length >= 1, true, `acts ${plan.acts.length}`)
assert.ok(['pool', 'suite'].includes(plan.acts[0].kind), `first act ${plan.acts[0].kind}`)
if (plan.acts[0].kind === 'suite') {
  assert.match(plan.acts[0].suite.base, /\/dsh-boot-nexus\/suite\/[0-9a-f]{64}$/)
  assert.equal(plan.acts[0].suite.act1Id, 'archive-warm')
  assert.equal(typeof plan.acts[0].suite.act2Id, 'string')
  assert.ok(plan.acts[0].suite.act2Id.length > 0, 'suite act2 id must be configured')
  assert.equal(plan.acts[0].suite.trimMs, 0)
} else {
  assert.equal(plan.acts[0].pool, 'clips')
}

function call(route, method = 'GET', body = undefined) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url: route.path,
      headers: {},
      on(event, cb) {
        if (event === 'data' && body !== undefined) cb(Buffer.from(body))
        if (event === 'end') cb()
        if (event === 'error') { /* no-op */ }
        return req
      },
      destroy() {},
    }
    const chunks = []
    const res = {
      headersSent: false,
      status: 0,
      headers: {},
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; return this },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk))
        resolve({ status: this.status, headers: this.headers, body: Buffer.concat(chunks).toString('utf8') })
      },
    }
    route.handler(req, res).catch(reject)
  })
}

const byPath = new Map(routes.map((r) => [r.path, r]))
const config = await call(byPath.get('/dsh-boot-nexus/config'))
assert.equal(config.status, 200)
const configBody = JSON.parse(config.body)
assert.equal(configBody.config.schemaVersion, 2)
assert.equal(configBody.media.clips.length, 5)
assert.equal(configBody.media.savers.length, 7)
assert.equal(typeof configBody.paths.media, 'string')
assert.equal(configBody.paths.media.endsWith('boot-nexus\\media') || configBody.paths.media.endsWith('boot-nexus/media'), true)
assert.equal(configBody.paths.suite.endsWith('assets\\suite') || configBody.paths.suite.endsWith('assets/suite'), true)
assert.equal(Array.isArray(configBody.suiteTemplates) && configBody.suiteTemplates.length > 0, true)

const planRes = await call(byPath.get('/dsh-boot-nexus/plan.json'))
assert.equal(planRes.status, 200)
const planBody = JSON.parse(planRes.body)
assert.equal(planBody.media.clips.length, 5)
assert.equal(planBody.media.savers.length, 7)

const health = await call(byPath.get('/dsh-boot-nexus/health'))
assert.equal(health.status, 200)
const healthBody = JSON.parse(health.body)
assert.equal(healthBody.ok, true)
assert.equal(healthBody.clips, 5)
assert.equal(healthBody.savers, 7)

const boot = await call(byPath.get('/dsh-boot-nexus/boot.js'))
assert.equal(boot.status, 200)
assert.match(boot.body, /function dbnBootMain/)
assert.equal(boot.headers.ETag, '"dbn-' + pkg.version + '"')

console.log(JSON.stringify({
  ok: true,
  version: plan.version,
  rows: rows.map((r) => r.kind),
  clips: plan.media.clips.map((c) => c.id),
  savers: plan.media.savers.map((s) => s.id),
  routes: routes.map((r) => `${r.kind}:${r.path}`),
  bootBytes: Buffer.byteLength(boot.body),
}, null, 2))

for (const d of disposers.reverse()) {
  try { d() } catch { /* fake ctx */ }
}
