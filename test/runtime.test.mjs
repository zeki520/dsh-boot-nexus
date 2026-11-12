import test from 'node:test'
import assert from 'node:assert/strict'

import { createFakeDom, loadRuntime, makePlan } from './helpers/fake-dom.mjs'

function boot(options = {}) {
  const env = createFakeDom()
  const internals = loadRuntime(env)
  const plan = makePlan(options.plan || {})
  const api = internals.dbnBootMain(env.win, env.doc, { plan, ...(options.args || {}) })
  return { ...env, internals, plan, api }
}

test('boot arms, plays, waits for clientReady and clip end, then reveals', () => {
  const env = boot()
  assert.equal(env.api.state, 'arming')
  assert.ok(env.doc.getElementById('dbn-root'))
  assert.equal(env.doc.documentElement.classList.contains('dbn-lock'), true)

  env.advance(16)
  assert.equal(env.api.state, 'playing')
  const video = env.doc.getElementById('dbn-stage').firstChild
  assert.ok(video)
  assert.equal(video.tagName, 'VIDEO')
  assert.equal(
    env.doc.getElementById('dbn-caption').textContent,
    '',
    'the media file name must never be written into the boot overlay',
  )

  // The clip ends before the app is ready: the overlay must stay up.
  video.dispatch('ended')
  assert.equal(env.api.state, 'playing')

  env.api.clientReady()
  assert.equal(env.api.state, 'revealed')
  assert.equal(env.api.phase, 'off')

  const root = env.doc.getElementById('dbn-root')
  assert.ok(root, 'the root is reused, not unmounted')
  assert.equal(root.getAttribute('data-phase'), 'off')
  assert.equal(root.getAttribute('aria-modal'), null)
  assert.equal(env.doc.documentElement.classList.contains('dbn-lock'), false)

  env.api.dispose()
  assert.equal(env.doc.getElementById('dbn-root'), null)
  assert.equal(env.win.__BOOT_NEXUS__, undefined)
  assert.equal(env.pending(), 0)
})

test('a renderer failure still reveals instead of removing the layer early', () => {
  const env = boot()
  const createElement = env.doc.createElement
  let video = null
  env.doc.createElement = (tag) => {
    const node = createElement(tag)
    if (String(tag).toLowerCase() === 'video') video = node
    return node
  }
  env.advance(16)
  assert.ok(video, 'the boot created a video element')
  video.dispatch('error')
  env.advance(16)
  assert.equal(env.api.failed, true)
  assert.equal(env.api.state, 'revealed')
  assert.equal(env.doc.getElementById('dbn-root').getAttribute('data-phase'), 'off')

  // A second boot is refused; the first one is still the owner.
  const second = env.internals.dbnBootMain(env.win, env.doc, { plan: env.plan })
  assert.equal(second.skipped, 'already-running')
  env.api.dispose()
})

test('session mode skips a boot already played in this tab', () => {
  const env = createFakeDom()
  const internals = loadRuntime(env)
  env.win.sessionStorage.setItem('dbn:played:test-session', '1')
  const api = internals.dbnBootMain(env.win, env.doc, {
    plan: makePlan({ boot: { mode: 'session' } }),
  })
  assert.equal(api.skipped, 'played-session')
  assert.equal(env.doc.getElementById('dbn-root'), null)
})

test('the session marker is scoped to the host apply session', () => {
  const env = createFakeDom()
  const internals = loadRuntime(env)
  // A marker from an earlier app process must not suppress this one.
  env.win.sessionStorage.setItem('dbn:played:old-session', '1')
  const api = internals.dbnBootMain(env.win, env.doc, {
    plan: makePlan({ boot: { mode: 'session' }, sessionId: 'new-session' }),
  })
  assert.equal(api.state, 'arming')
  api.dispose()
})

test('an empty media pool fails open without burning the session', () => {
  const env = boot({
    plan: { boot: { mode: 'session' }, media: { clips: [], savers: [] } },
  })
  env.advance(16)
  assert.equal(env.api.state, 'playing')
  env.api.clientReady()
  assert.equal(env.api.state, 'revealed')
  assert.equal(env.win.sessionStorage.getItem('dbn:played:test-session'), null)
  env.api.dispose()
})

test('?dbn=off leaves the app alone', () => {
  const env = createFakeDom()
  const internals = loadRuntime(env)
  env.win.location.search = '?dbn=off'
  const api = internals.dbnBootMain(env.win, env.doc, { plan: makePlan() })
  assert.equal(api.skipped, 'query-off')
  assert.equal(env.doc.getElementById('dbn-root'), null)
})

test('saver enters after idle and wakes on pointer input', () => {
  const env = boot({ plan: { saver: { enabled: true, idleMs: 1000 } } })
  env.advance(16)
  env.doc.getElementById('dbn-stage').firstChild.dispatch('ended')
  env.api.clientReady()
  assert.equal(env.api.state, 'revealed')

  env.advance(1000)
  assert.equal(env.api.state, 'saver')
  assert.equal(env.api.phase, 'saver')
  assert.equal(env.doc.getElementById('dbn-root').getAttribute('data-phase'), 'saver')
  assert.equal(env.doc.getElementById('dbn-saver').style.display, 'block')

  env.doc.dispatch('pointermove', { type: 'pointermove' })
  assert.equal(env.api.state, 'revealed')
  assert.equal(env.api.phase, 'off')
  assert.equal(env.doc.getElementById('dbn-saver').style.display, 'none')

  env.api.dispose()
  assert.equal(env.doc.getElementById('dbn-root'), null)
  assert.equal(env.pending(), 0)
})

test('dispose removes every listener it added', () => {
  const env = boot()
  env.advance(16)
  env.api.dispose()
  // No throw and no root after disposal.
  env.doc.dispatch('pointermove', { type: 'pointermove' })
  env.doc.dispatch('keydown', { type: 'keydown', key: 'Escape' })
  assert.equal(env.doc.getElementById('dbn-root'), null)
  assert.equal(env.doc.documentElement.classList.contains('dbn-lock'), false)
})

test('the boot overlay renders no diagnostic or skip copy', () => {
  const env = boot()
  assert.equal(env.doc.getElementById('dbn-diag'), null)
  const skip = env.doc.getElementById('dbn-skip')
  assert.ok(skip)
  assert.equal(skip.textContent || '', '')
  assert.equal(skip.style.display, 'none')
})

test('a missing or disabled explicit clip falls back to the usable pool', () => {
  const env = createFakeDom()
  const internals = loadRuntime(env)
  const plan = makePlan({ boot: { clip: 'does-not-exist' } })
  const picked = internals.dbnPickMedia(plan, 'clips')
  assert.equal(picked.id, 'clip-1')

  const disabled = makePlan({ boot: { clip: 'clip-1' }, media: { disabledClips: ['clip-1'] } })
  assert.equal(internals.dbnPickMedia(disabled, 'clips'), null)
})

test('a suite scene act runs first and hands over to the animation pool', () => {
  const scene = {
    id: 'archive-warm-fixture',
    theme: { accent: '#ff7500' },
    steps: [
      { zh: '需要访问许可', en: 'ACCESS PERMISSION REQUIRED', hold: 100, progress: 0.34 },
      { zh: '读取完毕', en: 'READ COMPLETE', hold: 100, progress: 0.93 },
    ],
  }
  const env = boot({
    plan: {
      acts: [
        { kind: 'scene', id: 'suite:archive-warm', scene },
        { kind: 'pool', pool: 'clips' },
      ],
    },
  })
  env.advance(16)
  assert.equal(env.api.state, 'playing')
  const stage = env.doc.getElementById('dbn-stage')
  const sceneEl = stage.firstChild
  assert.equal(sceneEl.className, 'dbn-scene')
  assert.equal(sceneEl.children[2].children[1].textContent, '需要访问许可')

  env.advance(300)
  assert.equal(env.doc.getElementById('dbn-stage').firstChild.tagName, 'VIDEO')
  assert.equal(env.api.state, 'playing')

  env.doc.getElementById('dbn-stage').firstChild.dispatch('ended')
  env.api.clientReady()
  assert.equal(env.api.state, 'revealed')
})

test('the scene renderer owns one timeline and cancels it on dispose', () => {
  const env = createFakeDom()
  const internals = loadRuntime(env)
  const clock = internals.dbnCreateClock(env.win)
  let done = 0
  const renderer = internals.dbnCreateSceneRenderer({
    doc: env.doc,
    win: env.win,
    clock,
    scene: {
      id: 's',
      steps: [
        { zh: '一', hold: 100, progress: 0.5 },
        { zh: '二', hold: 100, progress: 1 },
      ],
    },
    onDone: () => { done += 1 },
  })
  env.doc.body.appendChild(renderer.el)
  renderer.start()
  assert.equal(renderer.duration, 200)
  env.advance(100)
  assert.equal(renderer.el.children[2].children[1].textContent, '二')
  env.advance(100)
  assert.equal(done, 1)
  renderer.dispose()
  assert.equal(env.pending(), 0)
})

test('preview inherits client-ready and reveals without a second announce', async () => {
  const env = boot()
  env.advance(16)
  assert.equal(env.api.state, 'playing')

  const fresh = makePlan({ acts: [{ kind: 'scene', scene: { id: 'test', steps: [] } }] })
  env.win.fetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(fresh),
  })

  env.api.preview()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  env.advance(0)
  env.advance(16)
  assert.notEqual(env.win.__BOOT_NEXUS__, env.api, 'preview creates a fresh runtime instance')
  assert.equal(env.win.__BOOT_NEXUS__.state, 'revealed')
  assert.equal(env.win.__BOOT_NEXUS__.phase, 'off')
  env.win.__BOOT_NEXUS__.dispose()
})

test('the suite renderer validates nonce and source before finishing', () => {
  const env = createFakeDom()
  const internals = loadRuntime(env)
  const clock = internals.dbnCreateClock(env.win)
  let done = 0
  const renderer = internals.dbnCreateSuiteRenderer({
    doc: env.doc,
    win: env.win,
    clock,
    suite: { url: '/dsh-boot-nexus/suite/token/frame', nonce: 'nonce', timeoutMs: 8000 },
    onDone: () => { done += 1 },
  })
  env.doc.body.appendChild(renderer.el)
  renderer.el.contentWindow = {}
  renderer.start()
  assert.equal(renderer.el.src, '/dsh-boot-nexus/suite/token/frame')

  env.win.dispatch('message', { source: {}, data: { ns: 'dbn-suite', v: 1, nonce: 'nonce', type: 'done' } })
  assert.equal(done, 0)
  env.win.dispatch('message', { source: renderer.el.contentWindow, data: { ns: 'dbn-suite', v: 1, nonce: 'wrong', type: 'done' } })
  assert.equal(done, 0)
  env.win.dispatch('message', { source: renderer.el.contentWindow, data: { ns: 'dbn-suite', v: 1, nonce: 'nonce', type: 'done' } })
  assert.equal(done, 1)

  renderer.dispose()
  assert.equal(env.pending(), 0)
})
