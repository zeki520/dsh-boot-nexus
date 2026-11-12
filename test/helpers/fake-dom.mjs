/**
 * A deliberately small DOM + timer sandbox for the browser half.
 *
 * It implements only what `40-stage.js` / `30-media.js` / `50-boot.js` touch.
 * If the runtime grows a new DOM API, this file should grow with it — a fake
 * that silently ignores unknown calls would hide exactly the bugs the runtime
 * tests exist to catch.
 */
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const runtimeFile = fileURLToPath(new URL('../../lib/runtime.js', import.meta.url))

class ClassList {
  constructor() { this.values = new Set() }
  add(...names) { for (const name of names) this.values.add(name) }
  remove(...names) { for (const name of names) this.values.delete(name) }
  contains(name) { return this.values.has(name) }
  toggle(name, force) {
    const on = force === undefined ? !this.values.has(name) : !!force
    if (on) this.values.add(name); else this.values.delete(name)
    return on
  }
}

class FakeNode {
  constructor(tag, ownerDocument) {
    this.tagName = String(tag).toUpperCase()
    this.ownerDocument = ownerDocument
    this.children = []
    this.parentNode = null
    this.attributes = Object.create(null)
    this.style = {}
    this.classList = new ClassList()
    this.textContent = ''
    this.id = ''
    this._listeners = new Map()
  }

  appendChild(child) {
    if (!child) return child
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.children.push(child)
    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    if (child) child.parentNode = null
    return child
  }

  get firstChild() { return this.children[0] || null }
  get lastChild() { return this.children[this.children.length - 1] || null }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
    if (name === 'id') this.id = String(value)
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
  }

  removeAttribute(name) {
    delete this.attributes[name]
    if (name === 'id') this.id = ''
    if (name === 'src' || name === 'poster') {
      try { delete this[name] } catch { /* non-configurable in a real element */ }
    }
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, [])
    this._listeners.get(type).push(handler)
  }

  removeEventListener(type, handler) {
    const list = this._listeners.get(type)
    if (!list) return
    const index = list.indexOf(handler)
    if (index >= 0) list.splice(index, 1)
  }

  dispatch(type, extra = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() { this.propagationStopped = true },
      ...extra,
    }
    const list = (this._listeners.get(type) || []).slice()
    for (const handler of list) handler(event)
    return event
  }

  click() { return this.dispatch('click') }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }

  querySelectorAll() { return [] }
}

function videoNode(doc) {
  const node = new FakeNode('video', doc)
  node.src = ''
  node.muted = false
  node.volume = 1
  node.playsInline = false
  node.loop = false
  node.preload = ''
  node.poster = ''
  node.currentTime = 0
  node.duration = 0
  node.paused = true
  node._playImpl = null
  node.play = function play() {
    node.paused = false
    if (typeof node._playImpl === 'function') return node._playImpl(node)
    return Promise.resolve()
  }
  node.pause = function pause() { node.paused = true }
  node.load = function load() {}
  return node
}

function walk(node, id) {
  if (!node) return null
  if (node.id === id) return node
  for (const child of node.children) {
    const hit = walk(child, id)
    if (hit) return hit
  }
  return null
}

function storage() {
  const map = new Map()
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null },
    setItem(key, value) { map.set(key, String(value)) },
    removeItem(key) { map.delete(key) },
    clear() { map.clear() },
    get length() { return map.size },
  }
}

export function createFakeDom() {
  let now = 0
  let sequence = 1
  const timers = new Map()

  function setTimeoutFake(fn, ms = 0) {
    const id = sequence++
    timers.set(id, { fn, at: now + Math.max(0, Number(ms) || 0), every: 0 })
    return id
  }

  function setIntervalFake(fn, ms = 16) {
    const id = sequence++
    const step = Math.max(16, Number(ms) || 16)
    timers.set(id, { fn, at: now + step, every: step })
    return id
  }

  function clearFake(id) { timers.delete(id) }

  function advance(ms) {
    const target = now + Math.max(0, ms)
    let guard = 0
    for (;;) {
      let best = null
      for (const [id, timer] of timers) {
        if (timer.at > target) continue
        if (!best || timer.at < best.timer.at || (timer.at === best.timer.at && id < best.id)) {
          best = { id, timer }
        }
      }
      if (!best) break
      now = best.timer.at
      if (best.timer.every > 0) best.timer.at += best.timer.every
      else timers.delete(best.id)
      best.timer.fn()
      if (++guard > 10000) throw new Error('fake timer storm')
    }
    now = target
  }

  class FakeDate extends Date {
    static now() { return now }
  }

  const documentElement = new FakeNode('html', null)
  const doc = {
    documentElement,
    body: new FakeNode('body', null),
    activeElement: null,
    createElement(tag) {
      if (String(tag).toLowerCase() === 'video') return videoNode(doc)
      return new FakeNode(tag, doc)
    },
    getElementById(id) { return walk(documentElement, id) },
    addEventListener: (...args) => documentElement.addEventListener(...args),
    removeEventListener: (...args) => documentElement.removeEventListener(...args),
    dispatch: (...args) => documentElement.dispatch(...args),
  }
  doc.body.ownerDocument = doc

  const win = {
    location: { search: '' },
    sessionStorage: storage(),
    localStorage: storage(),
    matchMedia: () => ({ matches: false }),
    _listeners: new Map(),
    addEventListener(name, fn) {
      const list = this._listeners.get(name) || []
      list.push(fn)
      this._listeners.set(name, list)
    },
    removeEventListener(name, fn) {
      const list = this._listeners.get(name) || []
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    dispatch(name, event) {
      const list = this._listeners.get(name) || []
      for (const fn of list.slice()) fn(event)
    },
    setTimeout: setTimeoutFake,
    clearTimeout: clearFake,
    setInterval: setIntervalFake,
    clearInterval: clearFake,
    requestAnimationFrame: (fn) => setTimeoutFake(() => fn(now), 16),
    cancelAnimationFrame: clearFake,
    console,
    __DBN_TEST__: true,
  }

  return {
    win,
    doc,
    now: () => now,
    advance,
    pending: () => timers.size,
    Date: FakeDate,
  }
}

export function loadRuntime(env) {
  const code = readFileSync(runtimeFile, 'utf8')
  const sandbox = {
    window: env.win,
    document: env.doc,
    console: { log() {}, error() {}, warn() {} },
    Date: env.Date,
    Math,
    JSON,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    RegExp,
    setTimeout: env.win.setTimeout,
    clearTimeout: env.win.clearTimeout,
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'runtime.js' })
  return env.win.__DBN_INTERNALS__
}

export function makePlan(overrides = {}) {
  const plan = {
    schemaVersion: 2,
    version: '0.1.2',
    base: '/dsh-boot-nexus',
    sessionId: 'test-session',
    enabled: true,
    boot: {
      mode: 'always',
      clip: 'auto',
      holdMs: 0,
      fadeMs: 0,
      sound: false,
      volume: 0.6,
      trigger: 'auto',
      clickToEnter: true,
      showHint: false,
      hintAfterMs: 12000,
      maxMs: 30000,
      reducedMotion: 'off',
    },
    saver: {
      enabled: false,
      idleMs: 1000,
      pool: 'auto',
      breakEffect: true,
      breakStyle: 'random',
      hint: true,
      pointerEffect: 'random',
      sound: false,
      volume: 0.5,
      rotateMs: 0,
    },
    media: {
      clips: [{ id: 'clip-1', name: 'one.mp4', mime: 'video/mp4', kind: 'video', size: 1024 }],
      savers: [{ id: 'saver-1', name: 'rest.mp4', mime: 'video/mp4', kind: 'video', size: 1024 }],
      disabledClips: [],
      disabledSavers: [],
    },
    advanced: { diag: false, trace: false },
  }
  return {
    ...plan,
    ...overrides,
    boot: { ...plan.boot, ...(overrides.boot || {}) },
    saver: { ...plan.saver, ...(overrides.saver || {}) },
    media: { ...plan.media, ...(overrides.media || {}) },
  }
}
