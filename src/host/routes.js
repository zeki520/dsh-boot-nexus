/**
 * Host routes: four surfaces, one mount, one disposer.
 *
 *   GET /dsh-boot-nexus/boot.js     the runtime (immutable per version)
 *   GET /dsh-boot-nexus/plan.json   the live plan (no-store)
 *   GET /dsh-boot-nexus/health      a cheap liveness probe
 *   GET /dsh-boot-nexus/media/:id   one allowlisted clip, with Range support
 *
 * The route table is static. Nothing here registers a prefix that could swallow
 * `/plugins/<package>/client.js` — the failure the animation plugin hit when it
 * mounted its route as a prefix. `/media/` is a prefix, but its handler resolves
 * the id through the pool allowlist and never joins it onto a path.
 *
 * Every handler runs behind the trust fence: if `connection.requestRejection`
 * is missing or throws, the answer is 403, not "serve it anyway".
 */

import { createReadStream, promises as fsp } from 'node:fs'
import { ROUTE_BASE } from '../shared/constants.js'
import { parseRange, resolveMedia } from './assets.js'

export function sendJson(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(body)
}

/**
 * Fail-closed bridge to the host's connection service.
 *
 * `requestRejection` is the host's own decision (origin, auth, loopback rules);
 * Nexus does not re-implement it and does not weaken it. A missing service is a
 * rejection, because the alternative — serving a 100 MB video to any origin
 * because a dependency disappeared — is the wrong default for a boot overlay.
 */
export function createTrustFence(connection, { enabled = true } = {}) {
  return function check(req) {
    if (!enabled) return null
    if (!connection || typeof connection.requestRejection !== 'function') {
      return { reject: true, status: 403, reason: 'connection-unavailable' }
    }
    try {
      const result = connection.requestRejection(req)
      if (result === undefined || result === null || result === false) return null
      if (typeof result === 'string') return { reject: true, status: 403, reason: result }
      if (result.reject === false) return null
      return {
        reject: true,
        status: Number.isInteger(result.status) ? result.status : 403,
        reason: typeof result.reason === 'string' ? result.reason : 'request rejected',
      }
    } catch (error) {
      return { reject: true, status: 403, reason: `trust-check-failed: ${error.message}` }
    }
  }
}

export function sendRejection(res, rejection) {
  sendJson(res, rejection.status || 403, { ok: false, error: rejection.reason || 'request rejected' })
}

/** Read a small JSON body. The settings card sends one config document. */
export function readJsonBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        const error = new Error('request body too large')
        error.status = 413
        reject(error)
        try { req.destroy() } catch { /* already gone */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text.trim() === '' ? {} : JSON.parse(text))
      } catch (error) {
        const invalid = new Error('invalid JSON body')
        invalid.status = 400
        reject(invalid)
      }
    })
    req.on('error', reject)
  })
}

/**
 * Stream one file, honouring a single byte range.
 *
 * The `readFile` seam exists so tests can exercise status/headers without a
 * real 100 MB video; production always streams.
 */
export async function serveFile(req, res, entry, options = {}) {
  const {
    cache = 'public, max-age=86400',
    readFile = fsp.readFile,
    createStream = createReadStream,
  } = options

  let stat
  try {
    stat = await fsp.stat(entry.path)
  } catch {
    sendJson(res, 404, { ok: false, error: 'media not found' })
    return
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { ok: false, error: 'media not a file' })
    return
  }

  const size = stat.size
  const range = parseRange(req.headers?.range, size)
  const common = {
    'Content-Type': entry.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
  }

  if (range && range.invalid) {
    res.writeHead(416, { ...common, 'Content-Range': `bytes */${size}` })
    res.end()
    return
  }

  if (range) {
    const length = range.end - range.start + 1
    res.writeHead(206, {
      ...common,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Length': String(length),
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = createStream(entry.path, { start: range.start, end: range.end })
    stream.on('error', (error) => { try { res.destroy(error) } catch { /* response gone */ } })
    res.on('close', () => { try { stream.destroy() } catch { /* already gone */ } })
    stream.pipe(res)
    return
  }

  res.writeHead(200, { ...common, 'Content-Length': String(size) })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createStream(entry.path)
  stream.on('error', (error) => { try { res.destroy(error) } catch { /* response gone */ } })
  res.on('close', () => { try { stream.destroy() } catch { /* already gone */ } })
  stream.pipe(res)
}

/**
 * @param {{ getPlan: () => object, mediaPlan: object, runtime: string,
 *           version: string, trust: (req: object) => object|null,
 *           enabled?: () => boolean, uptime?: () => number,
 *           getConfig?: () => object, saveConfig?: (input: object) => Promise<object> }} deps
 */
export function createRoutes(deps) {
  const {
    getPlan,
    mediaPlan,
    runtime,
    version,
    trust,
    enabled = () => true,
    uptime = () => Math.round(process.uptime()),
    getConfig = () => ({}),
    saveConfig = async () => ({}),
    appendDiag = () => {},
    mediaToken = '',
    iconPng = null,
  } = deps

  const guard = (handler) => async (req, res) => {
    const rejection = trust(req)
    if (rejection) {
      sendRejection(res, rejection)
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message || error) })
      else try { res.end() } catch { /* response already gone */ }
    }
  }

  const route = (path, handler, kind = 'exact') => ({ kind, path, handler: guard(handler) })

  /*
   * Media is fetched by the runtime and played from a Blob URL, so the request
   * carries the same headers as /config. It still passes the host trust fence;
   * the token is a second factor that proves the request came from the page
   * that received this plan. The id is resolved through the allowlist.
   */
  const mediaRoute = (handler) => {
    const guarded = guard(handler)
    return async (req, res) => {
      if (mediaToken) {
        let token = ''
        try { token = new URL(String(req.url || ''), 'http://localhost').searchParams.get('t') || '' } catch { token = '' }
        if (token !== mediaToken) {
          sendJson(res, 403, { ok: false, error: 'media token rejected' })
          return
        }
      }
      return guarded(req, res)
    }
  }

  return [
    route(`${ROUTE_BASE}/boot.js`, (req, res) => {
      const body = Buffer.from(runtime, 'utf8')
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': String(body.length),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'ETag': `"dbn-${version}"`,
        'X-Content-Type-Options': 'nosniff',
      })
      if (req.method === 'HEAD') res.end()
      else res.end(body)
    }),

    route(`${ROUTE_BASE}/plan.json`, (req, res) => {
      sendJson(res, 200, getPlan(), { 'Cache-Control': 'no-store' })
    }),

    route(`${ROUTE_BASE}/health`, (req, res) => {
      const plan = getPlan()
      sendJson(res, 200, {
        ok: true,
        version,
        enabled: plan.enabled,
        clips: mediaPlan.clips.length,
        savers: mediaPlan.savers.length,
        uptime: uptime(),
      })
    }),

    route(`${ROUTE_BASE}/config`, async (req, res) => {
      if (req.method === 'GET') {
        sendJson(res, 200, await getConfig())
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' }, { Allow: 'GET, POST' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const saved = await saveConfig(body)
        /* The settings card consumes the POST response as its new payload and
           reads it with the GET shape. Returning the narrow save result dropped
           suiteConfig/suiteTemplates/paths and made untouched suite fields
           render as '' or 0. Re-read the same payload GET serves. */
        const payload = await getConfig()
        sendJson(res, 200, { ...payload, ok: true, unchanged: saved && saved.unchanged === true })
      } catch (error) {
        sendJson(res, error.status || 500, { ok: false, error: String(error.message || error) })
      }
    }),

    /*
     * Browser-side evidence sink. The runtime's inline script cannot write to
     * the host log directly, and DevTools is not always reachable on the
     * desktop shell. A same-origin beacon gives the Host one factual line per
     * client boot without adding a second configuration surface.
     */
    route(`${ROUTE_BASE}/diag`, async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' }, { Allow: 'POST' })
        return
      }
      try {
        const body = await readJsonBody(req, 16384)
        appendDiag(body)
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendJson(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    }),

    ...(Buffer.isBuffer(iconPng) ? [route(`${ROUTE_BASE}/icon/icon-64.png`, (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(iconPng.length),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      })
      if (req.method === 'HEAD') res.end()
      else res.end(iconPng)
    })] : []),

    {
      kind: 'prefix',
      path: `${ROUTE_BASE}/media`,
      handler: mediaRoute((req, res) => {
        let pathname
        try {
          pathname = new URL(String(req.url || ''), 'http://localhost').pathname
        } catch {
          sendJson(res, 400, { ok: false, error: 'bad url' })
          return
        }
        const tail = pathname.slice(`${ROUTE_BASE}/media/`.length)
        const entry = resolveMedia(mediaPlan, decodeURIComponent(tail))
        if (!entry) {
          sendJson(res, 404, { ok: false, error: 'unknown media id' })
          return
        }
        return serveFile(req, res, entry, { cache: 'no-store' })
      }),
    },
  ]
}

/**
 * Mount a route table; on any failure, unwind the routes already mounted.
 *
 * The returned disposer is the only cleanup path the caller needs. It is
 * idempotent and disposes in reverse registration order, which is the order the
 * host's own registry expects.
 */
export function mountRoutes(webServer, routes) {
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('mountRoutes: webServer.register is required')
  }
  const disposers = []
  try {
    for (const route of routes) disposers.push(webServer.register(route))
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* keep unwinding */ }
    }
    throw error
  }
  let disposed = false
  return function disposeRoutes() {
    if (disposed) return
    disposed = true
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* one bad route must not strand the rest */ }
    }
  }
}
