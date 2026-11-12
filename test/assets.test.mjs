import test from 'node:test'
import assert from 'node:assert/strict'

import {
  mimeOf,
  kindOf,
  safeId,
  buildMediaPlan,
  resolveMedia,
  parseRange,
  mediaIds,
} from '../src/host/assets.js'

test('mime and kind are derived from the extension, never from the request', () => {
  assert.equal(mimeOf('A.MP4'), 'video/mp4')
  assert.equal(mimeOf('x.webm'), 'video/webm')
  assert.equal(mimeOf('x.png'), 'image/png')
  assert.equal(mimeOf('x.exe'), 'application/octet-stream')
  assert.equal(kindOf('video/mp4'), 'video')
  assert.equal(kindOf('image/png'), 'image')
  assert.equal(kindOf('application/octet-stream'), 'binary')
})

test('safeId accepts opaque ids and refuses traversal-shaped input', () => {
  assert.equal(safeId('clip-1'), 'clip-1')
  assert.equal(safeId('a.b_c-1'), 'a.b_c-1')
  assert.equal(safeId('../x'), null)
  assert.equal(safeId('a/b'), null)
  assert.equal(safeId('.hidden'), null)
  assert.equal(safeId(''), null)
  assert.equal(safeId('x'.repeat(121)), null)
})

test('buildMediaPlan assigns stable ids and keeps the absolute path host-side', () => {
  const plan = buildMediaPlan({
    clips: [
      { name: 'b.mp4', path: '/pool/b.mp4', size: 10 },
      { name: 'a.png', path: '/pool/a.png' },
    ],
    savers: [{ name: 's.mp4', path: '/pool/s.mp4' }],
  })
  assert.deepEqual(plan.clips.map((c) => c.id), ['clip-1', 'clip-2'])
  assert.deepEqual(plan.savers.map((c) => c.id), ['saver-1'])
  assert.equal(plan.clips[0].mime, 'video/mp4')
  assert.equal(plan.clips[0].kind, 'video')
  assert.equal(plan.clips[0].path, '/pool/b.mp4')
  assert.equal(plan.clips[1].kind, 'image')
  assert.equal(plan.savers[0].id, 'saver-1')
})

test('resolveMedia only resolves ids that exist in the allowlist', () => {
  const plan = buildMediaPlan({
    clips: [{ name: 'b.mp4', path: '/pool/b.mp4' }],
    savers: [{ name: 's.mp4', path: '/pool/s.mp4' }],
  })
  assert.equal(resolveMedia(plan, 'clip-1').name, 'b.mp4')
  assert.equal(resolveMedia(plan, 'saver-1').name, 's.mp4')
  assert.equal(resolveMedia(plan, 'clip-2'), null)
  assert.equal(resolveMedia(plan, '../b.mp4'), null)
})

test('parseRange handles closed, open and suffix ranges', () => {
  assert.equal(parseRange(undefined, 100), null)
  assert.equal(parseRange('', 100), null)
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 })
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=90-200', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=0-0', 1), { start: 0, end: 0 })
})

test('parseRange refuses malformed, multi-range and unsatisfiable requests', () => {
  assert.deepEqual(parseRange('bytes=0-9,20-29', 100), { invalid: true })
  assert.deepEqual(parseRange('bytes=100-', 100), { invalid: true })
  assert.deepEqual(parseRange('bytes=9-8', 100), { invalid: true })
  assert.deepEqual(parseRange('bytes=-0', 100), { invalid: true })
  assert.deepEqual(parseRange('bytes=abc-def', 100), { invalid: true })
  assert.deepEqual(parseRange('bytes=', 100), { invalid: true })
})

test('mediaIds returns only what a settings card needs', () => {
  const plan = buildMediaPlan({ clips: [{ name: 'b.mp4', path: '/pool/b.mp4' }], savers: [] })
  assert.deepEqual(mediaIds(plan), {
    clips: [{ id: 'clip-1', name: 'b.mp4', kind: 'video' }],
    savers: [],
  })
})
