/**
 * Index injection: exactly one row set, exactly one subscriber.
 *
 * The legacy suite and animation each subscribed to `webserver/index-inject`
 * and each pushed a full-screen layer. Row order is subscriber activation order,
 * which neither plugin controlled, so which one won was an accident of startup
 * timing. Nexus removes the race at the source: one subscriber, one static row
 * array, one root node.
 *
 * Idempotency is checked at three levels:
 *   1. row level  — the table already carries `__DBN_PLAN__` (or an old sentinel);
 *   2. script level — the runtime's first statement bails if `__BOOT_NEXUS__` exists;
 *   3. node level  — the stage reuses `#dbn-root` instead of appending a second one.
 *
 * Level 1 is the one that matters for the "subscribed twice" failure the legacy
 * suite hit; levels 2 and 3 cover a host that injects the same rows twice by
 * different channels (web server and desktop IPC).
 */

import { GLOBAL_PLAN, GLOBAL_VERSION, LEGACY_SENTINELS, ROOT_ID } from '../shared/constants.js'

/** Build the immutable row set for one index response. */
export function buildRows({ plan, runtime, css, version }) {
  if (typeof runtime !== 'string' || runtime.length === 0) {
    throw new Error('buildRows: runtime source is required')
  }
  return [
    { kind: 'style', text: css },
    { kind: 'global', name: GLOBAL_PLAN, value: plan },
    { kind: 'global', name: GLOBAL_VERSION, value: version },
    { kind: 'script', placement: 'head', text: runtime },
  ]
}

/** True when this table already carries a Nexus row set. */
export function tableHasNexus(table) {
  if (!Array.isArray(table)) return false
  return table.some((row) => {
    if (!row || typeof row !== 'object') return false
    if (row.kind === 'global' && row.name === GLOBAL_PLAN) return true
    if (typeof row.text === 'string' && row.text.includes('__BOOT_NEXUS__')) return true
    if (typeof row.html === 'string' && row.html.includes(ROOT_ID)) return true
    return false
  })
}

/**
 * True when an old plugin is still contributing. Nexus yields instead of
 * stacking another full-screen layer: the user gets the old animation and a
 * warning, not two animations fighting over z-index.
 */
export function tableHasLegacy(table) {
  if (!Array.isArray(table)) return false
  return table.some((row) => {
    if (!row || typeof row !== 'object') return false
    if (row.kind === 'global' && LEGACY_SENTINELS.includes(row.name)) return true
    const haystack = `${typeof row.text === 'string' ? row.text : ''}${typeof row.html === 'string' ? row.html : ''}${typeof row.src === 'string' ? row.src : ''}`
    return LEGACY_SENTINELS.some((sentinel) => haystack.includes(sentinel))
  })
}

/**
 * Contribute rows to a table, once.
 *
 * Returns a diagnostic object instead of throwing: this runs inside another
 * plugin's event dispatch, and a throw here would take down the subscriber
 * chain for every other plugin in the index response.
 */
export function contribute(table, rows) {
  if (!Array.isArray(table)) return { added: 0, skipped: 'not-an-array' }
  if (tableHasNexus(table)) return { added: 0, skipped: 'nexus-already-present' }
  if (tableHasLegacy(table)) return { added: 0, skipped: 'legacy-present' }
  table.push(...rows)
  return { added: rows.length, skipped: null }
}

/** Stable description used by diagnostics and tests. */
export function rowSignature(rows) {
  if (!Array.isArray(rows)) return ''
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return 'invalid'
    if (row.kind === 'global') return `global:${row.name}`
    if (row.kind === 'script') return `script:${row.placement || 'body'}:${row.text ? row.text.length : 0}`
    if (row.kind === 'style') return `style:${row.text ? row.text.length : 0}`
    if (row.kind === 'html') return `html:${row.placement || 'body'}`
    return String(row.kind)
  }).join('|')
}
