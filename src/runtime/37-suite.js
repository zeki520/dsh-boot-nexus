/**
 * Suite-frame renderer.
 *
 * The original suite engine is a self-booting document with no teardown. It
 * runs in a same-origin iframe so destroying the frame is the teardown: no
 * suite root, lock or document listener can survive into the host page. This
 * adapter only owns the frame, the token handshake and the done/error/timeout
 * signals; the visual timeline stays inside splash.js.
 */
function dbnCreateSuiteRenderer(options) {
  var doc = options.doc
  var win = options.win
  var clock = options.clock
  var suite = options.suite || {}
  var disposed = false
  var started = false
  var finished = false
  var timer = null
  var el = doc.createElement('iframe')

  el.className = 'dbn-suite-frame'
  el.setAttribute('title', '启动动画')
  el.setAttribute('allow', 'autoplay; fullscreen')
  el.setAttribute('scrolling', 'no')
  el.style.cssText = [
    'position:absolute', 'inset:0', 'width:100%', 'height:100%',
    'border:0', 'background:#000', 'display:block',
  ].join(';')

  function cleanupTimer() {
    if (timer) { timer(); timer = null }
  }

  function finish(error) {
    if (disposed || finished) return
    finished = true
    cleanupTimer()
    if (error) {
      if (typeof options.onError === 'function') options.onError(error)
    } else if (typeof options.onDone === 'function') {
      options.onDone()
    }
  }

  function onMessage(event) {
    if (disposed || finished) return
    if (!event || event.source !== el.contentWindow) return
    var data = event.data
    if (!data || data.ns !== 'dbn-suite' || data.v !== 1 || data.nonce !== suite.nonce) return
    if (data.type === 'ready') {
      if (typeof options.onDiag === 'function') options.onDiag('suite ready')
      return
    }
    if (data.type === 'act') {
      if (typeof options.onDiag === 'function') options.onDiag('suite act ' + String(data.act || ''))
      return
    }
    if (data.type === 'audio-blocked') {
      if (typeof options.onBlocked === 'function') options.onBlocked(new Error('suite audio blocked'))
      return
    }
    if (data.type === 'error') {
      finish(new Error(String(data.detail || 'suite frame error')))
      return
    }
    if (data.type === 'done') finish(null)
  }

  function onFrameError() {
    finish(new Error('suite frame failed to load'))
  }

  return {
    kind: 'suite',
    el: el,
    start: function () {
      if (started || disposed) return
      started = true
      if (win && typeof win.addEventListener === 'function') {
        win.addEventListener('message', onMessage)
      }
      el.addEventListener('error', onFrameError)
      /* The suite owns its own timeline; never cut it at the old 30 s probe.
         A template can legitimately run for minutes. The timeout is only a
         dead-frame guard, so it sits above the declared duration. */
      var limit = Math.max(120000, Number(suite.timeoutMs) || 0,
        Number(suite.durationMs) || 0)
      timer = clock.after(limit, function () {
        timer = null
        finish(new Error('suite frame timeout'))
      })
      el.src = String(suite.url || (suite.base + '/frame'))
    },
    pause: function () { /* the frame owns its own clock; skip is dispose */ },
    resume: function () { /* no-op */ },
    dispose: function () {
      disposed = true
      cleanupTimer()
      if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('message', onMessage)
      }
      el.removeEventListener('error', onFrameError)
      try { el.src = 'about:blank' } catch (error) { /* detached */ }
      if (el.parentNode) el.parentNode.removeChild(el)
    },
    get currentTime() { return started && !finished ? 0 : 0 },
    get duration() { return Number(suite.durationMs) || 0 },
    setVolume: function () {},
  }
}
