/*
 * One clock for everything the overlay schedules.
 *
 * The legacy plugins each kept their own timer bag, and the animation plugin
 * leaked four listeners/timers on exit (a keydown that was never removed, the
 * hold hint, the diagnostics interval, and a `timeupdate` listener). Nexus has
 * one bag. `dispose()` clears every timeout, interval and animation frame, so
 * "the overlay is gone" and "nothing is still scheduled" are the same fact.
 */
function dbnCreateClock(win) {
  var timers = []
  var intervals = []
  var frames = []
  var disposed = false

  function splice(list, value) {
    var index = list.indexOf(value)
    if (index >= 0) list.splice(index, 1)
  }

  function after(ms, fn) {
    if (disposed) return function () {}
    var id = win.setTimeout(function () {
      splice(timers, id)
      if (!disposed) {
        try { fn() } catch (error) {
          if (win.console && win.console.error) win.console.error('[dbn] timer failed', error)
        }
      }
    }, Math.max(0, ms))
    timers.push(id)
    return function cancel() {
      splice(timers, id)
      win.clearTimeout(id)
    }
  }

  function every(ms, fn) {
    if (disposed) return function () {}
    var id = win.setInterval(function () {
      if (disposed) return
      try { fn() } catch (error) {
        if (win.console && win.console.error) win.console.error('[dbn] interval failed', error)
      }
    }, Math.max(16, ms))
    intervals.push(id)
    return function cancel() {
      splice(intervals, id)
      win.clearInterval(id)
    }
  }

  function frame(fn) {
    if (disposed) return function () {}
    var raf = win.requestAnimationFrame || function (cb) { return win.setTimeout(function () { cb(Date.now()) }, 16) }
    var caf = win.cancelAnimationFrame || win.clearTimeout
    var id = raf(function (time) {
      splice(frames, id)
      if (!disposed) {
        try { fn(time) } catch (error) {
          if (win.console && win.console.error) win.console.error('[dbn] frame failed', error)
        }
      }
    })
    frames.push(id)
    return function cancel() {
      splice(frames, id)
      caf(id)
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (var i = 0; i < timers.length; i++) win.clearTimeout(timers[i])
    for (var j = 0; j < intervals.length; j++) win.clearInterval(intervals[j])
    var caf = win.cancelAnimationFrame || win.clearTimeout
    for (var k = 0; k < frames.length; k++) caf(frames[k])
    timers.length = 0
    intervals.length = 0
    frames.length = 0
  }

  return {
    after: after,
    every: every,
    frame: frame,
    dispose: dispose,
    get size() { return timers.length + intervals.length + frames.length }
  }
}
