/*
 * The browser orchestrator: gate, arm, play, hand off, rest.
 *
 * It owns no pixels. Every visible thing is done by the stage; every timing
 * decision is delegated to the machine; every clip is drawn by a renderer.
 * This file is the only place that knows the composition, which is why it is
 * also the only place that needs to change when the boot flow changes.
 *
 * Failure policy: fail OPEN, but only at the end. A broken clip, a decode
 * error, a missing pool or a codec the machine refuses all land in `handoff`
 * and the overlay fades out. Nothing in this file removes the layer while the
 * app is still booting underneath it, because that is how the old suite
 * produced a black flash followed by a half-built shell.
 */
function dbnBootMain(win, doc, options) {
  options = options || {}
  var plan = options.plan || win.__DBN_PLAN__
  if (!plan || typeof plan !== 'object') return { skipped: 'no-plan' }
  if (win.__BOOT_NEXUS__ && options.force !== true) return { skipped: 'already-running' }
  if (plan.enabled === false) return { skipped: 'disabled' }

  var search = ''
  try { search = String((win.location && win.location.search) || '') } catch (error) { search = '' }
  var queryMode = ''
  var match = /[?&]dbn=([^&]+)/.exec(search)
  if (match) {
    try { queryMode = decodeURIComponent(match[1]) } catch (error) { queryMode = match[1] }
  }
  if (queryMode === 'off') return { skipped: 'query-off' }
  if (queryMode === 'diag' && plan.advanced) plan.advanced.diag = true
  var force = options.force === true || queryMode === 'preview' || queryMode === 'force'

  /*
   * A desktop webview's sessionStorage survives an app restart in some Electron
   * configurations. Key the "already played" marker by the host-side apply
   * session instead, so a fresh process always gets a fresh boot. Older builds
   * wrote the bare key; keep reading it as a fallback.
   */
  var sessionKey = plan.sessionId
    ? DBN.STORAGE_SESSION + ':' + String(plan.sessionId)
    : DBN.STORAGE_SESSION

  var day = ''
  try { day = new Date(Date.now()).toISOString().slice(0, 10) } catch (error) { day = '' }

  if (!force) {
    try {
      if (plan.boot.mode === 'session' && win.sessionStorage.getItem(sessionKey) === '1') {
        return { skipped: 'played-session' }
      }
      if (plan.boot.mode === 'daily' && win.localStorage.getItem(DBN.STORAGE_DAY) === day) {
        return { skipped: 'played-day' }
      }
    } catch (error) { /* storage unavailable: showing the boot is the safer default */ }
  }

  var clock = dbnCreateClock(win)
  var stage = dbnCreateStage({ doc: doc, win: win, clock: clock, plan: plan })
  var machine = dbnCreateBootMachine({
    /*
     * A hidden or occluded Electron window can pause requestAnimationFrame
     * indefinitely. The old runtime armed through `clock.frame(startBoot)`, so
     * on such a window the first frame never ran, the 4 s arm deadline expired,
     * and the machine fail-opened to `revealed` before the user ever saw it.
     * Start through a timer instead; rAF is still available for paint work.
     */
    deadlines: { armMs: 8000, handoffMs: 4000, hardCapMs: plan.boot.maxMs || 30000 }
  })
  var media = dbnCreateMediaHost(doc, clock, plan)
  var listeners = []
  var shown = false
  var renderer = null
  var saverRenderer = null
  var saverRotateCancel = null
  var hintCancel = null
  var saverIdleCancel = null
  var activityOff = null
  var disposed = false
  var history = []
  var lastError = null

  function log(line) {
    var text = String(line)
    history.push(text)
    if (history.length > 60) history.shift()
    try { stage.diag(text) } catch (error) { /* diagnostics must never break the boot */ }
    if (plan.advanced && plan.advanced.trace) {
      try { if (win.console && win.console.log) win.console.log('[dbn] ' + text) } catch (error) { /* no console */ }
    }
  }

  function emit(event) {
    var copy = listeners.slice()
    for (var i = 0; i < copy.length; i++) {
      try { copy[i](event) } catch (error) {
        try { if (win.console && win.console.error) win.console.error('[dbn] listener failed', error) } catch (ignored) { /* no console */ }
      }
    }
  }

  function phaseEvent(phase) {
    emit({ type: 'phase', phase: phase, state: machine.state, failed: machine.failed })
  }

  function stopSaver() {
    if (saverRotateCancel) { saverRotateCancel(); saverRotateCancel = null }
    if (saverRenderer) {
      try { saverRenderer.dispose() } catch (error) { /* one element, one failure */ }
      saverRenderer = null
    }
    try { stage.clearSaver() } catch (error) { /* stage already gone */ }
  }

  function armSaverIdle() {
    if (saverIdleCancel) { saverIdleCancel(); saverIdleCancel = null }
    if (!plan.saver.enabled || disposed) return
    saverIdleCancel = clock.after(plan.saver.idleMs, function () {
      saverIdleCancel = null
      machine.send('saver', Date.now())
    })
  }

  function nextSaver() {
    if (disposed || !plan.saver.enabled) {
      machine.send('wake', Date.now())
      return
    }
    var entry = dbnPickMedia(plan, 'savers')
    if (!entry) {
      log('saver: no media')
      machine.send('wake', Date.now())
      return
    }
    if (saverRenderer) {
      try { saverRenderer.dispose() } catch (error) { /* next one */ }
      saverRenderer = null
    }
    saverRenderer = media.create(entry, {
      blob: true,
      sound: plan.saver.sound,
      volume: plan.saver.volume,
      holdMs: plan.saver.rotateMs || 60000,
      loop: true,
      onEnd: function () {
        if (disposed) return
        if (plan.saver.rotateMs > 0) nextSaver()
        else if (saverRenderer) saverRenderer.start()
      },
      onError: function (error) {
        lastError = String((error && error.message) || error || 'saver failed')
        log('saver-failed ' + lastError)
        machine.send('wake', Date.now())
      },
      onBlocked: function (error) {
        log('saver-blocked ' + String((error && error.message) || error || 'autoplay'))
      },
      onDiag: log
    })
    stage.setSaverMedia(saverRenderer)
    saverRenderer.start()
    log('saver ' + entry.id)
    if (plan.saver.rotateMs > 0) {
      if (saverRotateCancel) saverRotateCancel()
      saverRotateCancel = clock.after(plan.saver.rotateMs, nextSaver)
    }
  }

  function onSaver() {
    if (disposed) return
    try { stage.enterSaver() } catch (error) { log('saver-stage-failed') ; machine.send('wake', Date.now()); return }
    phaseEvent('saver')
    log('saver: enter')
    nextSaver()
  }

  function onRevealed(why) {
    if (disposed) return
    if (hintCancel) { hintCancel(); hintCancel = null }
    try { stage.hint(false) } catch (error) { /* stage gone */ }
    if (renderer) {
      try { renderer.dispose() } catch (error) { /* element already detached */ }
      renderer = null
    }
    try { media.stop() } catch (error) { /* already stopped */ }
    try { stage.clearStage() } catch (error) { /* stage gone */ }
    try { stage.caption('') } catch (error) { /* stage gone */ }
    try {
      /*
       * An empty pool reaches `revealed` through the fail-open path. That is a
       * successful handoff, but nothing was shown, so it must not burn the
       * session: the next launch should still try.
       */
      if (shown && !machine.failed && plan.boot.mode === 'session') win.sessionStorage.setItem(sessionKey, '1')
      if (shown && !machine.failed && plan.boot.mode === 'daily' && day) win.localStorage.setItem(DBN.STORAGE_DAY, day)
    } catch (error) { /* private mode: not fatal */ }
    log('revealed:' + why)
    phaseEvent('revealed')
    armSaverIdle()
  }

  function beginHandoff() {
    if (hintCancel) { hintCancel(); hintCancel = null }
    try { stage.hint(false) } catch (error) { /* stage gone */ }
    var fade = machine.failed ? 0 : plan.boot.fadeMs
    log('handoff' + (machine.failed ? ' (failed)' : ''))
    try {
      stage.reveal(fade, function () {
        if (!disposed) machine.send('reveal', Date.now())
      })
    } catch (error) {
      log('reveal-failed ' + (error && error.message ? error.message : 'unknown'))
      if (!disposed) machine.send('reveal', Date.now())
    }
    phaseEvent('handoff')
  }

  var acts = []
  var actIndex = 0

  function finishActs() {
    if (disposed) return
    machine.send('clip-done', Date.now())
  }

  function nextAct() {
    if (disposed) return
    startAct(actIndex + 1)
  }

  function startAct(index) {
    if (disposed || machine.state !== 'playing') return
    actIndex = index
    if (index >= acts.length) {
      finishActs()
      return
    }
    var act = acts[index]
    if (act && act.kind === 'suite' && act.suite && typeof dbnCreateSuiteRenderer === 'function') {
      shown = true
      renderer = dbnCreateSuiteRenderer({
        doc: doc,
        win: win,
        clock: clock,
        suite: act.suite,
        onDone: function () {
          if (disposed) return
          if (renderer) { try { renderer.dispose() } catch (error) { /* detached */ } }
          renderer = null
          finishActs()
        },
        onError: function (error) {
          lastError = String((error && error.message) || error || 'suite failed')
          log('suite-failed ' + lastError)
          if (renderer) { try { renderer.dispose() } catch (e2) { /* detached */ } }
          renderer = null
          finishActs()
        },
        onBlocked: function (error) {
          log('suite-audio-blocked ' + String((error && error.message) || error || 'autoplay'))
        },
        onDiag: log,
      })
      stage.setMedia(renderer)
      renderer.start()
      log('suite ' + String(act.suite.act1Id || '') + (act.suite.act2Id ? ' + ' + act.suite.act2Id : ''))
      return
    }
    if (act && act.kind === 'scene' && act.scene && typeof dbnCreateSceneRenderer === 'function') {
      shown = true
      renderer = dbnCreateSceneRenderer({
        doc: doc,
        win: win,
        clock: clock,
        scene: act.scene,
        onDone: function () {
          if (disposed) return
          if (renderer) { try { renderer.dispose() } catch (error) { /* detached */ } }
          renderer = null
          nextAct()
        },
        onError: function (error) {
          log('scene-failed ' + String((error && error.message) || error || 'scene'))
          if (renderer) { try { renderer.dispose() } catch (e2) { /* detached */ } }
          renderer = null
          nextAct()
        },
      })
      stage.setMedia(renderer)
      renderer.start()
      log('scene ' + String(act.id || act.scene.id || 'suite'))
      return
    }

    var entry = dbnPickMedia(plan, 'clips')
    if (!entry) {
      log('clip: none')
      nextAct()
      return
    }
    shown = true
    var hold = plan.boot.holdMs || 0
    renderer = media.create(entry, {
      blob: true,
      sound: plan.boot.sound,
      volume: plan.boot.volume,
      holdMs: 6000,
      onEnd: function () {
        if (disposed) return
        var advance = function () {
          if (disposed) return
          if (renderer) { try { renderer.dispose() } catch (error) { /* detached */ } }
          renderer = null
          nextAct()
        }
        if (hold > 0) clock.after(hold, advance)
        else advance()
      },
      onError: function (error) {
        lastError = String((error && error.message) || error || 'clip failed')
        log('clip-failed ' + lastError)
        machine.send('fail', Date.now())
      },
      onBlocked: function (error) {
        log('clip-blocked ' + String((error && error.message) || error || 'autoplay'))
        clock.after(1200, function () {
          if (!disposed && machine.state === 'playing') {
            if (renderer) { try { renderer.dispose() } catch (e2) { /* detached */ } }
            renderer = null
            nextAct()
          }
        })
      },
      onDiag: log
    })
    stage.setMedia(renderer)
    renderer.start()
    log('clip ' + entry.id + ' (' + entry.mime + ')')
  }

  function startBoot() {
    if (disposed || machine.state !== 'arming') return
    machine.send('start', Date.now())
    acts = (Array.isArray(plan.acts) && plan.acts.length)
      ? plan.acts
      : [{ kind: 'pool', pool: 'clips' }]
    startAct(0)
    if (plan.boot.showHint) {
      hintCancel = clock.after(plan.boot.hintAfterMs, function () {
        hintCancel = null
        if (!disposed && machine.state === 'playing') stage.hint(true)
      })
    }
  }

  function wakeFromSaver(event) {
    if (disposed || machine.state !== 'saver') return
    log('wake:' + ((event && event.type) || 'input'))
    stopSaver()
    try { stage.exitSaver() } catch (error) { /* stage gone */ }
    machine.send('wake', Date.now())
  }

  function onActivity(event) {
    if (disposed) return
    if (machine.state === 'saver') {
      wakeFromSaver(event)
      return
    }
    if ((machine.state === 'arming' || machine.state === 'playing') &&
        event && event.key === 'Escape') {
      machine.send('skip', Date.now())
    }
  }

  machine.on(function (event) {
    if (event.type !== 'transition') return
    log(event.from + '>' + event.to + ':' + event.why)
    if (event.to === 'playing') phaseEvent('playing')
    if (event.to === 'handoff') beginHandoff()
    if (event.to === 'revealed') onRevealed(event.why)
    if (event.to === 'saver') onSaver()
  })

  var api = {
    version: DBN.VERSION,
    get state() { return machine.state },
    get phase() { return stage.phase },
    get failed() { return machine.failed },
    get error() { return lastError || '' },
    get logs() { return history.slice() },
    get plan() { return plan },
    clientReady: function () {
      if (disposed) return
      log('client-ready')
      machine.send('client-ready', Date.now())
    },
    fail: function (error) {
      if (disposed) return
      lastError = String((error && error.message) || error || 'fail')
      log('fail ' + lastError)
      machine.send('fail', Date.now())
    },
    skip: function () {
      if (disposed) return
      machine.send('skip', Date.now())
    },
    preview: function () {
      if (disposed) return
      function start(nextPlan) {
        api.dispose()
        win.setTimeout(function () {
          var next = dbnBootMain(win, doc, { force: true, plan: nextPlan })
          /* client-ready is one-shot per instance and the page announces it only
             once. The preview instance is created after the app is already up, so
             it must inherit that fact or clip-done waits for client-ready until
             the hard cap, leaving a black screen. */
          if (next && typeof next.clientReady === 'function') next.clientReady()
        }, 0)
      }
      /* Pull the freshly saved plan first: suiteHoldMs and act choices live in
         the host plan, not in the browser bundle. If the request fails the
         previous plan still gives the user a useful replay. */
      try {
        win.fetch((plan.base || '') + '/plan.json', { cache: 'no-store' })
          .then(function (response) { return response.ok ? response.json() : null })
          .then(function (next) { start(next || plan) })
          .catch(function () { start(plan) })
      } catch (error) {
        start(plan)
      }
    },
    on: function (listener) {
      if (typeof listener !== 'function') return function () {}
      listeners.push(listener)
      return function off() {
        var index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    dispose: function () {
      if (disposed) return
      disposed = true
      if (hintCancel) { hintCancel(); hintCancel = null }
      if (saverIdleCancel) { saverIdleCancel(); saverIdleCancel = null }
      stopSaver()
      try { machine.send('dispose', Date.now()) } catch (error) { /* already terminal */ }
      try { media.stop() } catch (error) { /* already stopped */ }
      if (activityOff) { activityOff(); activityOff = null }
      try { stage.dispose() } catch (error) { /* already detached */ }
      try { clock.dispose() } catch (error) { /* already cleared */ }
      if (win.__BOOT_NEXUS__ === api) {
        try { delete win.__BOOT_NEXUS__ } catch (error) { win.__BOOT_NEXUS__ = undefined }
      }
      emit({ type: 'disposed' })
      listeners.length = 0
    }
  }
  win.__BOOT_NEXUS__ = api
  try {
    if (typeof win.dispatchEvent === 'function' && typeof win.CustomEvent === 'function') {
      win.dispatchEvent(new win.CustomEvent('dbn:ready', { detail: api }))
    }
  } catch (error) { /* the client also checks the global directly */ }

  try {
    machine.send('arm', Date.now())
    stage.ensure()
    stage.lock()
    stage.setPhase(DBN.PHASE.ARMING)
    stage.caption('')
    log('armed ' + DBN.VERSION + ' mode=' + plan.boot.mode)
    clock.after(0, startBoot)
    clock.every(250, function () { machine.send('tick', Date.now()) })

    var offSkip = stage.addSkipListener(function () { api.skip() })
    var offRoot = stage.addRootClickListener(function () {
      if (plan.boot.trigger === 'click' || plan.boot.clickToEnter) api.skip()
    })
    var offJump = function () { offSkip(); offRoot() }

    var activityEvents = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']
    var activityHandlers = []
    for (var i = 0; i < activityEvents.length; i++) {
      (function (name) {
        var handler = function (event) { onActivity(event) }
        var optionsArg = name === 'keydown' ? true : { passive: true, capture: true }
        doc.addEventListener(name, handler, optionsArg)
        activityHandlers.push(function () {
          doc.removeEventListener(name, handler, optionsArg)
        })
      })(activityEvents[i])
    }
    activityOff = function () {
      offJump()
      for (var j = 0; j < activityHandlers.length; j++) activityHandlers[j]()
    }
  } catch (error) {
    lastError = String((error && error.message) || error || 'arm failed')
    try { if (win.console && win.console.error) win.console.error('[dbn] arm failed', error) } catch (ignored) { /* no console */ }
    try { api.dispose() } catch (ignored) { /* best effort */ }
    return { skipped: 'arm-error', error: lastError }
  }

  return api
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (window.__DBN_TEST__) {
    window.__DBN_INTERNALS__ = {
      DBN: DBN,
      dbnBootMain: dbnBootMain,
      dbnCreateBootMachine: dbnCreateBootMachine,
      dbnCreateClock: dbnCreateClock,
      dbnCreateStage: dbnCreateStage,
      dbnCreateMediaHost: dbnCreateMediaHost,
      dbnCreateSceneRenderer: dbnCreateSceneRenderer,
      dbnCreateSuiteRenderer: dbnCreateSuiteRenderer,
      dbnPickMedia: dbnPickMedia
    }
  }
  if (!window.__BOOT_NEXUS__) {
    try {
      dbnBootMain(window, document)
    } catch (error) {
      try { if (window.console && window.console.error) window.console.error('[dbn] boot failed', error) } catch (ignored) { /* no console */ }
    }
  }
}
