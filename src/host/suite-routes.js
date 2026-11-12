import { readFileSync, statSync, createReadStream } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { buildSuiteShell } from './suite-shell.js'
import { rewriteSplash } from './suite.js'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''))
  const right = Buffer.from(String(b || ''))
  return left.length === right.length && timingSafeEqual(left, right)
}

function send(res, status, type, body, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': String(buf.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    ...extra,
  })
  res.end(buf)
}

function suffixOf(url) {
  const path = String(url || '').split('?')[0]
  const decoded = decodeURIComponent(path)
  return decoded
}

function inside(root, file) {
  const r = normalize(root + sep)
  const f = normalize(file)
  return f === normalize(root) || f.startsWith(r)
}

/**
 * One token-scoped read-only route family for the suite frame and its assets.
 *
 * The frame is a document navigation, so it cannot carry the host cookie the
 * regular trust fence expects; the 256-bit token in the path is the authority
 * here. Every path below is allowlisted and no user string is joined into a
 * path without segment validation.
 */
export function createSuiteRoutes({ base, getPlan, suiteRoot, splashSource, splashCss, home }) {
  return [{
    kind: 'prefix',
    path: base,
    handler: (req, res) => {
      const plan = getPlan()
      if (!plan || !plan.ok) { send(res, 404, 'text/plain; charset=utf-8', 'suite unavailable'); return }
      let decoded
      try { decoded = suffixOf(req.url) } catch { send(res, 400, 'text/plain; charset=utf-8', 'bad path'); return }
      const prefix = base
      if (!decoded.startsWith(prefix + '/')) { send(res, 404, 'text/plain; charset=utf-8', 'not found'); return }
      const rel = decoded.slice(prefix.length + 1)
      if (!rel || rel.includes('..') || rel.includes('\\') || rel.includes('\0')) {
        send(res, 404, 'text/plain; charset=utf-8', 'not found'); return
      }
      const parts = rel.split('/')
      if (!parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) {
        send(res, 404, 'text/plain; charset=utf-8', 'not found'); return
      }

      if (rel === 'frame') {
        const html = buildSuiteShell({
          base: prefix,
          nonce: plan.nonce,
          config: plan.config,
          template: plan.template,
          template2: plan.template2,
          jump: plan.jump,
        })
        send(res, 200, TYPES['.html'], html)
        return
      }
      if (rel === 'splash.js') {
        send(res, 200, TYPES['.js'], splashSource)
        return
      }
      if (rel === 'splash.css') {
        send(res, 200, TYPES['.css'], splashCss)
        return
      }
      if (rel === 'diag') {
        if (req.method !== 'POST') { send(res, 405, 'text/plain; charset=utf-8', 'method not allowed'); return }
        send(res, 204, 'text/plain; charset=utf-8', '')
        return
      }
      if (rel === 'frame-session' || rel === 'template-frame' || rel === 'template-file') {
        send(res, 501, 'text/plain; charset=utf-8', 'not supported by nexus suite host')
        return
      }
      if (rel === 'music/file') {
        const name = String((req.url.split('?')[1] || '')).replace(/^name=/, '')
        const file = join(home, 'startup-music', decodeURIComponent(name))
        if (!inside(join(home, 'startup-music'), file)) { send(res, 404, 'text/plain; charset=utf-8', 'not found'); return }
        return serve(res, file)
      }
      if (parts[0] === 'asset') {
        const file = join(suiteRoot, 'lib', 'assets', parts.slice(1).join('/'))
        if (!inside(join(suiteRoot, 'lib', 'assets'), file)) { send(res, 404, 'text/plain; charset=utf-8', 'not found'); return }
        return serve(res, file)
      }
      if (parts[0] === 'voice') {
        const file = join(suiteRoot, 'lib', 'assets', 'voices', parts.slice(1).join('/'))
        if (!inside(join(suiteRoot, 'lib', 'assets', 'voices'), file)) { send(res, 404, 'text/plain; charset=utf-8', 'not found'); return }
        return serve(res, file)
      }
      if (parts[0] === 'template-asset') {
        const id = parts[1]
        const tail = parts.slice(2).join('/')
        if (!id || !tail) { send(res, 404, 'text/plain; charset=utf-8', 'not found'); return }
        const roots = [
          join(home, 'startup-templates', id, 'assets'),
          join(suiteRoot, 'templates', id, 'assets'),
        ]
        for (const root of roots) {
          const file = join(root, tail)
          if (inside(root, file)) {
            try { if (statSync(file).isFile()) return serve(res, file) } catch { /* next */ }
          }
        }
        send(res, 404, 'text/plain; charset=utf-8', 'not found')
        return
      }
      send(res, 404, 'text/plain; charset=utf-8', 'not found')
    },
  }]
}

function serve(res, file) {
  let stat
  try { stat = statSync(file) } catch { send(res, 404, 'text/plain; charset=utf-8', 'not found'); return }
  if (!stat.isFile()) { send(res, 404, 'text/plain; charset=utf-8', 'not found'); return }
  const ext = (file.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()
  const type = TYPES[ext] || 'application/octet-stream'
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': String(stat.size),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
  })
  const stream = createReadStream(file)
  stream.on('error', () => { try { res.destroy() } catch { /* closed */ } })
  res.on('close', () => { try { stream.destroy() } catch { /* closed */ } })
  stream.pipe(res)
}

export { safeEqual, rewriteSplash }
