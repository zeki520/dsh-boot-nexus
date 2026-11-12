/**
 * The media pool: a name -> absolute path allowlist.
 *
 * Legacy animation served `/plugins/dsh-boot-animation/<file>` by joining a
 * user-controlled URL segment onto its package directory, then had to add a
 * `..` check. Nexus never joins request input onto a filesystem path. The URL
 * carries an opaque id; the id resolves through this table, and nothing else.
 *
 * The pool lives under `$DSH_HOME/boot-nexus/media` (user-writable), not under
 * `node_modules` (read-only in a packaged profile). The legacy `/optimize`
 * route rewrote files inside its own package; that is exactly the behaviour
 * this table is designed to make impossible.
 */

import { extname, basename } from 'node:path'

const MIME = Object.freeze({
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
})

export function mimeOf(name) {
  return MIME[extname(String(name)).toLowerCase()] || 'application/octet-stream'
}

export function kindOf(mime) {
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('image/')) return 'image'
  return 'binary'
}

/** Opaque, URL-safe id. Never derived from a request. */
export function safeId(value) {
  const id = String(value || '')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(id)) return null
  if (id.includes('..')) return null
  return id
}

/**
 * Build the two pools from explicit file lists.
 *
 * @param {{clips?: Array<{name: string, path: string, size?: number}>,
 *          savers?: Array<{name: string, path: string, size?: number}>}} input
 */
export function buildMediaPlan({ clips = [], savers = [] } = {}) {
  const used = new Set()
  const make = (prefix, entries) => {
    const out = []
    entries.forEach((entry, index) => {
      if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) return
      const name = typeof entry.name === 'string' && entry.name ? entry.name : basename(entry.path)
      let base = `${prefix}-${index + 1}`
      let id = base
      let n = 2
      while (used.has(id)) id = `${base}-${n++}`
      used.add(id)
      const mime = mimeOf(name)
      out.push({
        id,
        name,
        path: entry.path,
        mime,
        kind: kindOf(mime),
        size: Number.isFinite(entry.size) ? entry.size : undefined,
      })
    })
    return out
  }
  return { clips: make('clip', clips), savers: make('saver', savers) }
}

export function resolveMedia(plan, id) {
  const safe = safeId(id)
  if (!safe) return null
  const pools = [plan?.clips, plan?.savers]
  for (const pool of pools) {
    if (!Array.isArray(pool)) continue
    const hit = pool.find((entry) => entry && entry.id === safe)
    if (hit) return hit
  }
  return null
}

/**
 * Parse a single-range `Range` header.
 *
 * Returns `null` for "serve the whole file", `{start,end}` for a satisfiable
 * range, and `{invalid:true}` for a malformed or unsatisfiable one. Multi-range
 * requests are refused rather than silently downgraded: a video element only
 * needs one range, and answering the wrong bytes is worse than a 416.
 */
export function parseRange(header, size) {
  if (!Number.isFinite(size) || size < 0) return { invalid: true }
  if (header === undefined || header === null || header === '') return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!match) return { invalid: true }
  const [, startRaw, endRaw] = match
  if (startRaw === '' && endRaw === '') return { invalid: true }

  let start
  let end
  if (startRaw === '') {
    const suffix = Number(endRaw)
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true }
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(startRaw)
    end = endRaw === '' ? size - 1 : Number(endRaw)
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) return { invalid: true }
  if (start < 0 || start >= size || end < start) return { invalid: true }
  end = Math.min(end, size - 1)
  return { start, end }
}

/** Ids a settings card can offer for the disable lists. */
export function mediaIds(plan) {
  return {
    clips: (plan?.clips || []).map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
    savers: (plan?.savers || []).map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
  }
}
