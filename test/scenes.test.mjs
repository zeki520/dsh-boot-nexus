import test from 'node:test'
import assert from 'node:assert/strict'

import { loadScene, listScenes } from '../src/host/scenes.js'

test('the bundled suite scene is readable and sanitized', () => {
  const scene = loadScene('archive-warm')
  assert.ok(scene)
  assert.equal(scene.id, 'archive-warm')
  assert.equal(scene.steps.length, 5)
  assert.equal(scene.steps[0].zh, '需要访问许可')
  assert.equal(scene.steps[4].progress, 0.93)
  assert.ok(scene.steps.every((step) => typeof step.hold === 'number'))
})

test('scene ids are an allowlist, not a path', () => {
  assert.equal(loadScene('../package'), null)
  assert.equal(loadScene('does-not-exist'), null)
  assert.ok(listScenes().includes('archive-warm'))
})
