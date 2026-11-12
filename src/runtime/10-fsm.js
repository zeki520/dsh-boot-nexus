/*
 * The browser-side boot state machine.
 *
 * Invariants, in the order they matter:
 *
 *   I1  One visible layer. `playing` is never entered twice; `arm` only leaves
 *       `idle`, and `start` only leaves `arming`.
 *   I2  Reveal needs the app AND the clip. `handoff` is entered from `playing`
 *       only when both `clientReady` and `clipDone` are true — unless a skip or
 *       a failure forces it. Waiting is the default, because a clip that ends
 *       early is not a reason to uncover a half-built shell.
 *   I3  Failure never removes the layer. `fail` walks into `handoff`, whose
 *       `reveal` is the only transition that tears anything down. A thrown
 *       renderer leaves the black veil up; the app boots underneath; the veil
 *       leaves on the timeout.
 *   I4  Time is supplied, never read. `send(type, at)` takes the timestamp, so
 *       the tests can drive a whole boot in microseconds.
 *   I5  `dispose` is terminal and clears the listener list; no transition after
 *       it can run.
 *
 * `handoff` is deliberately not skipped: the fade is a visual state, and the
 * stage needs it to know when to release the scroll lock. The machine records
 * when it was entered so a stuck fade still resolves.
 */
function dbnCreateBootMachine(options) {
  options = options || {}
  var now = typeof options.now === 'function' ? options.now : function () { return Date.now() }
  var deadlines = {
    armMs: 4000,
    handoffMs: 4000,
    hardCapMs: 30000
  }
  if (options.deadlines) {
    for (var key in options.deadlines) {
      if (Object.prototype.hasOwnProperty.call(options.deadlines, key) &&
          typeof options.deadlines[key] === 'number') {
        deadlines[key] = options.deadlines[key]
      }
    }
  }

  var state = 'idle'
  var failed = false
  var reason = ''
  var clientReady = false
  var clipDone = false
  var armedAt = 0
  var startedAt = 0
  var handoffAt = 0
  var listeners = []

  function snapshot() {
    return {
      state: state,
      failed: failed,
      reason: reason,
      clientReady: clientReady,
      clipDone: clipDone,
      armedAt: armedAt,
      startedAt: startedAt,
      handoffAt: handoffAt
    }
  }

  function emit(type, detail) {
    var event = { type: type, state: state }
    if (detail) for (var k in detail) if (Object.prototype.hasOwnProperty.call(detail, k)) event[k] = detail[k]
    var copy = listeners.slice()
    for (var i = 0; i < copy.length; i++) {
      try { copy[i](event) } catch (error) {
        if (typeof console !== 'undefined' && console.error) console.error('[dbn] machine listener failed', error)
      }
    }
  }

  function no(why) {
    return { ok: false, state: state, reason: why }
  }

  function go(next, why, at) {
    var previous = state
    state = next
    reason = why
    if (next === 'handoff') handoffAt = at
    emit('transition', { from: previous, to: next, why: why, at: at })
    return { ok: true, state: state, reason: why }
  }

  function canHandoff() {
    return state === 'arming' || state === 'playing' || state === 'handoff'
  }

  function send(type, at) {
    if (at === undefined || at === null) at = now()
    if (state === 'disposed') return no('disposed')

    switch (type) {
      case 'arm':
        if (state !== 'idle') return no('arm-from-' + state)
        armedAt = at
        return go('arming', 'arm', at)

      case 'start':
        if (state !== 'arming') return no('start-from-' + state)
        startedAt = at
        return go('playing', 'start', at)

      case 'client-ready':
        clientReady = true
        emit('client-ready', { at: at })
        if (state === 'playing' && clipDone) return go('handoff', 'client-ready', at)
        return { ok: true, state: state, reason: clientReady && clipDone ? 'waiting' : 'client-ready' }

      case 'clip-done':
        clipDone = true
        emit('clip-done', { at: at })
        if (state === 'playing' && clientReady) return go('handoff', 'clip-done', at)
        return { ok: true, state: state, reason: 'clip-done' }

      case 'skip':
        if (!canHandoff()) return no('skip-from-' + state)
        clientReady = true
        clipDone = true
        return state === 'handoff' ? { ok: true, state: state, reason: 'already-handoff' }
          : go('handoff', 'skip', at)

      case 'fail':
        if (state === 'revealed' || state === 'disposed') return no('fail-from-' + state)
        failed = true
        clientReady = true
        clipDone = true
        return go('handoff', 'fail', at)

      case 'reveal':
        if (state !== 'handoff') return no('reveal-from-' + state)
        return go('revealed', 'reveal', at)

      case 'saver':
        if (state !== 'revealed') return no('saver-from-' + state)
        return go('saver', 'saver', at)

      case 'wake':
        if (state !== 'saver') return no('wake-from-' + state)
        return go('revealed', 'wake', at)

      case 'tick':
        if (state === 'arming' && at - armedAt >= deadlines.armMs) return send('fail', at)
        if (state === 'playing' && at - startedAt >= deadlines.hardCapMs) return send('skip', at)
        if (state === 'handoff' && at - handoffAt >= deadlines.handoffMs) return send('reveal', at)
        return no('not-due')

      case 'dispose':
        state = 'disposed'
        listeners.length = 0
        return { ok: true, state: state, reason: 'dispose' }

      default:
        return no('unknown-event-' + String(type))
    }
  }

  function on(listener) {
    if (typeof listener !== 'function') return function () {}
    listeners.push(listener)
    return function off() {
      var index = listeners.indexOf(listener)
      if (index >= 0) listeners.splice(index, 1)
    }
  }

  return {
    send: send,
    on: on,
    snapshot: snapshot,
    get state() { return state },
    get failed() { return failed },
    get deadlines() { return deadlines }
  }
}
