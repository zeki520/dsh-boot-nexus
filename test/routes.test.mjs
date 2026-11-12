import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createTrustFence,
  createRoutes,
  mountRoutes,
} from '../src/host/routes.js'

function response() {
  const chunks = []
  const res = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  res.statusCode = 0
  res.headers = {}
  res.headersSent = false
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status
    res.headers = { ...headers }
    res.headersSent = true
  }
  res.body = () => Buffer.concat(chunks)
  return res
}

async function call(route, req) {
  const res = response()
  const finished = new Promise((resolve, reject) => {
    res.on('finish', resolve)
    res.on('error', reject)
  })
  await route.handler(req, res)
  await finished
  return res
}

function get(url, headers = {}) {
  return { url, method: 'GET', headers }
}

function post(url, body, headers = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.url = url
  req.method = 'POST'
  req.headers = headers
  return req
}

function fixture() {
  const plan = { version: '1.0.0', enabled: true, media: { clips: [], savers: [] } }
  const saved = []
  const diag = []
  const mediaPlan = {
    clips: [{ id: 'clip-1', name: 'one.mp4', path: '/not/read/by/routes', mime: 'video/mp4', kind: 'video', size: 100 }],
    savers: [],
  }
  const routes = createRoutes({
    getPlan: () => plan,
    mediaPlan,
    runtime: 'var x = 1',
    version: '1.0.0',
    trust: () => null,
    uptime: () => 123,
    getConfig: () => ({
      config: { enabled: true },
      warnings: [],
      suiteConfig: { identity: 'JOYCE MOORE' },
      suiteTemplates: [{ id: 'archive-warm', name: 'Archive Warm' }],
      paths: { media: '/tmp/media' },
      media: { clips: [], savers: [] },
      digest: 'test-digest',
    }),
    saveConfig: async (body) => {
      saved.push(body)
      return { ok: true, config: body.config || body }
    },
    appendDiag: (body) => diag.push(body),
  })
  return { routes, plan, mediaPlan, saved, diag }
}

const route = (routes, path) => routes.find((r) => r.path === path)

test('trust fence is fail-closed when the connection service is absent or throws', () => {
  assert.deepEqual(createTrustFence(undefined)({}), {
    reject: true,
    status: 403,
    reason: 'connection-unavailable',
  })
  assert.deepEqual(createTrustFence({ requestRejection: () => { throw new Error('boom') } })({}), {
    reject: true,
    status: 403,
    reason: 'trust-check-failed: boom',
  })
  assert.equal(createTrustFence({ requestRejection: () => null })({}), null)
  assert.equal(createTrustFence({ requestRejection: () => false })({}), null)
  assert.deepEqual(
    createTrustFence({ requestRejection: () => ({ reject: true, status: 401, reason: 'no' }) })({}),
    { reject: true, status: 401, reason: 'no' },
  )
  assert.equal(createTrustFence(undefined, { enabled: false })({}), null)
})

test('boot.js, plan.json and health are served from the route table', async () => {
  const { routes, plan } = fixture()
  const boot = await call(route(routes, '/dsh-boot-nexus/boot.js'), get('/dsh-boot-nexus/boot.js'))
  assert.equal(boot.statusCode, 200)
  assert.equal(boot.headers['Content-Type'], 'text/javascript; charset=utf-8')
  assert.equal(boot.headers['ETag'], '"dbn-1.0.0"')
  assert.equal(boot.body().toString(), 'var x = 1')

  const planRes = await call(route(routes, '/dsh-boot-nexus/plan.json'), get('/dsh-boot-nexus/plan.json'))
  assert.equal(planRes.statusCode, 200)
  assert.deepEqual(JSON.parse(planRes.body().toString()), plan)

  const health = await call(route(routes, '/dsh-boot-nexus/health'), get('/dsh-boot-nexus/health'))
  assert.deepEqual(JSON.parse(health.body().toString()), {
    ok: true,
    version: '1.0.0',
    enabled: true,
    clips: 1,
    savers: 0,
    uptime: 123,
  })
})

test('config GET and POST round-trip through the same route', async () => {
  const { routes, saved } = fixture()
  const configRoute = route(routes, '/dsh-boot-nexus/config')
  const read = await call(configRoute, get('/dsh-boot-nexus/config'))
  assert.deepEqual(JSON.parse(read.body().toString()), {
    config: { enabled: true },
    warnings: [],
    suiteConfig: { identity: 'JOYCE MOORE' },
    suiteTemplates: [{ id: 'archive-warm', name: 'Archive Warm' }],
    paths: { media: '/tmp/media' },
    media: { clips: [], savers: [] },
    digest: 'test-digest',
  })

  const write = await call(configRoute, post('/dsh-boot-nexus/config', { config: { enabled: false } }))
  assert.equal(write.statusCode, 200)
  assert.deepEqual(saved, [{ config: { enabled: false } }])
  assert.deepEqual(JSON.parse(write.body().toString()), {
    config: { enabled: true },
    warnings: [],
    suiteConfig: { identity: 'JOYCE MOORE' },
    suiteTemplates: [{ id: 'archive-warm', name: 'Archive Warm' }],
    paths: { media: '/tmp/media' },
    media: { clips: [], savers: [] },
    digest: 'test-digest',
    ok: true,
    unchanged: false,
  })

  const wrong = await call(configRoute, { url: '/dsh-boot-nexus/config', method: 'DELETE', headers: {} })
  assert.equal(wrong.statusCode, 405)
})

test('config POST reports invalid JSON as 400 and oversized bodies as 413', async () => {
  const { routes } = fixture()
  const configRoute = route(routes, '/dsh-boot-nexus/config')

  const invalid = Readable.from([Buffer.from('{ nope')])
  invalid.url = '/dsh-boot-nexus/config'
  invalid.method = 'POST'
  invalid.headers = {}
  const bad = await call(configRoute, invalid)
  assert.equal(bad.statusCode, 400)

  const huge = Readable.from([Buffer.alloc(70000, 0x61)])
  huge.url = '/dsh-boot-nexus/config'
  huge.method = 'POST'
  huge.headers = {}
  const tooLarge = await call(configRoute, huge)
  assert.equal(tooLarge.statusCode, 413)
})

test('diag POST appends browser evidence and rejects other methods', async () => {
  const { routes, diag } = fixture()
  const diagRoute = route(routes, '/dsh-boot-nexus/diag')
  const evidence = { hasPlan: true, hasApi: false, reason: 'apply' }
  const posted = await call(diagRoute, post('/dsh-boot-nexus/diag', evidence))
  assert.equal(posted.statusCode, 200)
  assert.deepEqual(diag, [evidence])

  const wrong = await call(diagRoute, get('/dsh-boot-nexus/diag'))
  assert.equal(wrong.statusCode, 405)
})

test('media route streams 200, 206, HEAD and refuses unknown ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dbn-routes-'))
  try {
    const file = join(dir, 'one.mp4')
    await writeFile(file, Buffer.alloc(100, 0x61))
    const mediaPlan = { clips: [{ id: 'clip-1', name: 'one.mp4', path: file, mime: 'video/mp4', kind: 'video', size: 100 }], savers: [] }
    const local = createRoutes({
      getPlan: () => ({ enabled: true }),
      mediaPlan,
      runtime: 'x',
      version: '1.0.0',
      trust: () => null,
    })
    const localMedia = route(local, '/dsh-boot-nexus/media')
    /*
     * The host's prefix matcher appends its own slash. A registered prefix that
     * already ends in "/" becomes "...//" and can never match a real request.
     */
    for (const item of local) {
      if (item.kind === 'prefix') assert.equal(item.path.endsWith('/'), false, item.path)
    }
    const mediaPrefix = local.find((item) => item.kind === 'prefix')
    const hostMatches = (pathname) => pathname === mediaPrefix.path || pathname.startsWith(mediaPrefix.path + '/')
    assert.equal(hostMatches('/dsh-boot-nexus/media/clip-1'), true)
    assert.equal(hostMatches('/dsh-boot-nexus/media'), true)

    const whole = await call(localMedia, get('/dsh-boot-nexus/media/clip-1'))
    assert.equal(whole.statusCode, 200)
    assert.equal(whole.headers['Content-Type'], 'video/mp4')
    assert.equal(whole.headers['Content-Length'], '100')
    assert.equal(whole.body().length, 100)

    const part = await call(localMedia, get('/dsh-boot-nexus/media/clip-1', { range: 'bytes=0-9' }))
    assert.equal(part.statusCode, 206)
    assert.equal(part.headers['Content-Range'], 'bytes 0-9/100')
    assert.equal(part.body().length, 10)

    const head = await call(localMedia, { url: '/dsh-boot-nexus/media/clip-1', method: 'HEAD', headers: {} })
    assert.equal(head.statusCode, 200)
    assert.equal(head.body().length, 0)

    const badRange = await call(localMedia, get('/dsh-boot-nexus/media/clip-1', { range: 'bytes=200-' }))
    assert.equal(badRange.statusCode, 416)
    assert.equal(badRange.headers['Content-Range'], 'bytes */100')

    const unknown = await call(localMedia, get('/dsh-boot-nexus/media/nope'))
    assert.equal(unknown.statusCode, 404)

    const traversal = await call(localMedia, get('/dsh-boot-nexus/media/%2e%2e%2fsecret'))
    assert.equal(traversal.statusCode, 404)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a rejected request never reaches the handler', async () => {
  const routes = createRoutes({
    getPlan: () => ({ enabled: true }),
    mediaPlan: { clips: [], savers: [] },
    runtime: 'x',
    version: '1.0.0',
    trust: createTrustFence(undefined),
  })
  const res = await call(route(routes, '/dsh-boot-nexus/health'), get('/dsh-boot-nexus/health'))
  assert.equal(res.statusCode, 403)
  assert.deepEqual(JSON.parse(res.body().toString()), { ok: false, error: 'connection-unavailable' })
})

test('mountRoutes unwinds on failure and disposes in reverse order', () => {
  const registered = []
  const disposed = []
  const failing = {
    register(route) {
      registered.push(route.path)
      if (registered.length === 2) throw new Error('boom')
      return () => disposed.push(route.path)
    },
  }
  assert.throws(() => mountRoutes(failing, [{ path: 'a' }, { path: 'b' }, { path: 'c' }]), /boom/)
  assert.deepEqual(registered, ['a', 'b'])
  assert.deepEqual(disposed, ['a'])

  const order = []
  const webServer = {
    register(route) {
      return () => order.push(route.path)
    },
  }
  const dispose = mountRoutes(webServer, [{ path: 'a' }, { path: 'b' }, { path: 'c' }])
  dispose()
  dispose()
  assert.deepEqual(order, ['c', 'b', 'a'])
})
