import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildRows,
  tableHasNexus,
  tableHasLegacy,
  contribute,
  rowSignature,
} from '../src/host/rows.js'

const runtime = 'var x = 1; /* __BOOT_NEXUS__ */'
const css = '#dbn-root{position:fixed}'
const plan = { version: '0.1.0', enabled: true, boot: { mode: 'session' } }

test('buildRows emits one style, two globals and one inline script', () => {
  const rows = buildRows({ plan, runtime, css, version: '0.1.0' })
  assert.equal(rows.length, 4)
  assert.equal(rows[0].kind, 'style')
  assert.equal(rows[0].text, css)
  assert.deepEqual(rows[1], { kind: 'global', name: '__DBN_PLAN__', value: plan })
  assert.deepEqual(rows[2], { kind: 'global', name: '__DBN_VERSION__', value: '0.1.0' })
  assert.equal(rows[3].kind, 'script')
  assert.equal(rows[3].placement, 'head')
  assert.equal(rows[3].text, runtime)
  assert.equal(rowSignature(rows), `style:${css.length}|global:__DBN_PLAN__|global:__DBN_VERSION__|script:head:${runtime.length}`)
})

test('buildRows refuses to emit an empty runtime', () => {
  assert.throws(() => buildRows({ plan, runtime: '', css, version: '0.1.0' }), /runtime source is required/)
})

test('contribute adds the rows once and is a no-op afterwards', () => {
  const table = []
  assert.deepEqual(contribute(table, buildRows({ plan, runtime, css, version: '0.1.0' })), {
    added: 4,
    skipped: null,
  })
  assert.equal(table.length, 4)
  assert.deepEqual(contribute(table, buildRows({ plan, runtime, css, version: '0.1.0' })), {
    added: 0,
    skipped: 'nexus-already-present',
  })
  assert.equal(table.length, 4)
})

test('contribute yields when a legacy plugin is still injecting', () => {
  const table = [{ kind: 'global', name: '__DSH_STARTUP_BOOT__', value: {} }]
  assert.equal(tableHasLegacy(table), true)
  assert.deepEqual(contribute(table, buildRows({ plan, runtime, css, version: '0.1.0' })), {
    added: 0,
    skipped: 'legacy-present',
  })
  assert.equal(table.length, 1)
})

test('legacy detection also catches an old script URL and root node', () => {
  assert.equal(tableHasLegacy([{ kind: 'script-src', src: '/dsh-startup/splash.js' }]), true)
  assert.equal(tableHasLegacy([{ kind: 'html', html: '<div id="dsh-startup-root"></div>' }]), true)
  assert.equal(tableHasLegacy([{ kind: 'html', html: '<div id="dbn-root"></div>' }]), false)
  assert.equal(tableHasNexus([{ kind: 'html', html: '<div id="dbn-root"></div>' }]), true)
})

test('contribute does not throw on a missing table', () => {
  assert.deepEqual(contribute(null, []), { added: 0, skipped: 'not-an-array' })
})
