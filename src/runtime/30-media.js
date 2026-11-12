/*
 * Media adapters.
 *
 * A renderer is the only thing that knows how a clip is drawn. The stage owns
 * the DOM slot and the hand-off; the renderer owns one element and its lifetime.
 * That seam is deliberately small: { mount, start, pause, resume, dispose }.
 * Adding an image sequence, a canvas animation or a ported splash module means
 * adding an adapter here, not another branch in the stage.
 *
 * Video is the common case. Autoplay is attempted with the user's volume
 * setting; if the browser refuses (no user gesture, power policy), the same
 * clip is retried muted rather than failing the boot. A muted clip is a worse
 * clip, not a broken app.
 */

function dbnMediaUrl(plan, entry) {
  var base = plan && typeof plan.base === 'string' ? plan.base : DBN.ROUTE_BASE
  var url = base + '/media/' + encodeURIComponent(entry.id)
  if (plan && plan.mediaToken) url += '?t=' + encodeURIComponent(plan.mediaToken)
  return url
}

function dbnPickMedia(plan, poolName) {
  var pool = poolName === 'savers' ? plan.media.savers : plan.media.clips
  if (!Array.isArray(pool)) return null
  var disabled = poolName === 'savers' ? plan.media.disabledSavers : plan.media.disabledClips
  var blocked = {}
  if (Array.isArray(disabled)) {
    for (var i = 0; i < disabled.length; i++) blocked[disabled[i]] = true
  }

  var wanted = poolName === 'savers' ? plan.saver.pool : plan.boot.clip
  if (wanted && wanted !== 'auto') {
    for (var j = 0; j < pool.length; j++) {
      if ((pool[j].id === wanted || pool[j].name === wanted) && !blocked[pool[j].id] && !blocked[pool[j].name]) {
        return pool[j]
      }
    }
    /* An explicit id that is missing or disabled must not black-screen the boot. */
  }

  var usable = []
  for (var k = 0; k < pool.length; k++) {
    var entry = pool[k]
    if (!entry) continue
    if (blocked[entry.id] || blocked[entry.name]) continue
    usable.push(entry)
  }
  if (usable.length === 0) return null
  return usable[Math.floor(Math.random() * usable.length)]
}

function dbnCreateVideoRenderer(doc, plan, entry, options) {
  var video = doc.createElement('video')
  video.muted = !options.sound
  video.volume = typeof options.volume === 'number' ? Math.max(0, Math.min(1, options.volume)) : 0.6
  video.playsInline = true
  video.loop = !!options.loop
  video.preload = 'auto'
  video.setAttribute('playsinline', '')
  video.setAttribute('aria-hidden', 'true')
  video.setAttribute('disablepictureinpicture', '')
  if (entry.poster) video.poster = entry.poster

  var win = doc && (doc.defaultView || doc.parentWindow)
  var disposed = false
  var started = false
  var objectUrl = null
  var fetchError = null
  var abortFetch = null
  var fetchTimer = null
  var source = dbnMediaUrl(plan, entry)
  var canBlob = !!(options.blob && win && typeof win.fetch === 'function' &&
    win.URL && typeof win.URL.createObjectURL === 'function')
  if (!canBlob) video.src = source

  function onEnded() {
    if (!disposed && typeof options.onEnd === 'function') options.onEnd()
  }
  function onError() {
    var mediaError = video.error
    var detail = 'media failed: ' + entry.name +
      ' code=' + (mediaError && mediaError.code) +
      ' net=' + video.networkState +
      ' src=' + (video.currentSrc || video.src) +
      (fetchError ? ' fetch=' + fetchError.message : '')
    var isBlob = !!(video.currentSrc || video.src || '').indexOf('blob:') === 0
    if (!disposed && !isBlob && win && typeof win.fetch === 'function') {
      try {
        win.fetch(video.currentSrc || video.src, { method: 'HEAD', cache: 'no-store' }).then(function (response) {
          if (!disposed && typeof options.onDiag === 'function') {
            options.onDiag('media head ' + response.status + ' ' + (response.headers && response.headers.get('content-type')))
          }
        }).catch(function (error) {
          if (!disposed && typeof options.onDiag === 'function') options.onDiag('media head failed: ' + (error && error.message))
        })
      } catch (error) { /* diagnostics only */ }
    }
    if (!disposed && typeof options.onError === 'function') options.onError(new Error(detail))
  }

  video.addEventListener('ended', onEnded)
  video.addEventListener('error', onError)

  function beginPlayback() {
    function blocked(error) {
      if (disposed) return
      /*
       * A refused autoplay is not a broken clip. Keeping the element mounted
       * still shows its first frame/poster; the caller decides when to hand
       * off. Only the media `error` event is fatal.
       */
      if (typeof options.onBlocked === 'function') options.onBlocked(error)
    }
    var attempt
    try { attempt = video.play() } catch (error) { blocked(error); return }
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch(function (error) {
        if (disposed) return
        if (!video.muted) {
          video.muted = true
          try {
            var retry = video.play()
            if (retry && typeof retry.catch === 'function') retry.catch(blocked)
          } catch (retryError) { blocked(retryError) }
          return
        }
        blocked(error)
      })
    }
  }

  function start() {
    if (disposed || started) return
    started = true
    if (!canBlob) { beginPlayback(); return }
    /*
     * A custom scheme can refuse a media element while still serving the bytes
     * to fetch(). Pull the allowlisted clip into a Blob URL so the element never
     * depends on scheme-level media support. The clip is local and short; the
     * extra copy is the cost of a boot that actually appears.
     */
    var controller = win.AbortController ? new win.AbortController() : null
    var request = { cache: 'no-store' }
    if (controller) {
      request.signal = controller.signal
      abortFetch = function () { try { controller.abort() } catch (error) { /* already aborted */ } }
    }
    if (typeof win.setTimeout === 'function') {
      fetchTimer = win.setTimeout(function () {
        fetchError = new Error('timeout after 8000ms')
        if (abortFetch) abortFetch()
      }, 8000)
    }
    win.fetch(source, request).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return response.blob()
    }).then(function (blob) {
      if (fetchTimer) { try { win.clearTimeout(fetchTimer) } catch (error) { /* gone */ } fetchTimer = null }
      if (disposed) return
      objectUrl = win.URL.createObjectURL(blob)
      video.src = objectUrl
      beginPlayback()
    }).catch(function (error) {
      if (fetchTimer) { try { win.clearTimeout(fetchTimer) } catch (timerError) { /* gone */ } fetchTimer = null }
      if (disposed) return
      fetchError = fetchError || (error instanceof Error ? error : new Error(String(error)))
      /*
       * fetch() can be refused by a protocol bridge that still lets the media
       * element load the URL. Fall back once to the direct source; if that
       * fails too, onError reports both causes.
       */
      if (typeof options.onDiag === 'function') {
        options.onDiag('media fetch fallback: ' + (error && error.message))
      }
      canBlob = false
      video.src = source
      beginPlayback()
    })
  }

  function pause() {
    try { video.pause() } catch (error) { /* nothing to pause */ }
  }

  function resume() {
    if (disposed) return
    try {
      var attempt = video.play()
      if (attempt && typeof attempt.catch === 'function') attempt.catch(function () {})
    } catch (error) { /* keep the last frame */ }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    if (fetchTimer) { try { win.clearTimeout(fetchTimer) } catch (error) { /* gone */ } fetchTimer = null }
    if (abortFetch) { abortFetch(); abortFetch = null }
    video.removeEventListener('ended', onEnded)
    video.removeEventListener('error', onError)
    pause()
    try {
      video.removeAttribute('src')
      video.load()
    } catch (error) { /* element already detached */ }
    if (objectUrl) {
      try { win.URL.revokeObjectURL(objectUrl) } catch (error) { /* already gone */ }
      objectUrl = null
    }
  }

  return {
    kind: 'video',
    el: video,
    start: start,
    pause: pause,
    resume: resume,
    dispose: dispose,
    setVolume: function (value) {
      video.volume = Math.max(0, Math.min(1, value))
      video.muted = video.volume === 0
    },
    get currentTime() { return video.currentTime || 0 },
    get duration() { return video.duration || 0 }
  }
}

function dbnCreateImageRenderer(doc, plan, entry, options) {
  var img = doc.createElement('img')
  img.src = dbnMediaUrl(plan, entry)
  img.alt = ''
  img.setAttribute('aria-hidden', 'true')
  var cancel = null
  var disposed = false

  function start() {
    if (disposed) return
    var duration = typeof entry.durationMs === 'number' && entry.durationMs > 0
      ? entry.durationMs
      : (options.holdMs || 6000)
    if (cancel) cancel()
    cancel = options.clock.after(duration, function () {
      if (!disposed && typeof options.onEnd === 'function') options.onEnd()
    })
  }

  function pause() {
    if (cancel) { cancel(); cancel = null }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    pause()
    img.removeAttribute('src')
  }

  return {
    kind: 'image',
    el: img,
    start: start,
    pause: pause,
    resume: start,
    dispose: dispose,
    setVolume: function () {},
    get currentTime() { return 0 },
    get duration() { return typeof entry.durationMs === 'number' ? entry.durationMs : (options.holdMs || 6000) }
  }
}

function dbnCreateMediaHost(doc, clock, plan) {
  var current = null

  function create(entry, options) {
    if (!entry) return null
    options = options || {}
    options.clock = clock
    if (entry.kind === 'video') return dbnCreateVideoRenderer(doc, plan, entry, options)
    return dbnCreateImageRenderer(doc, plan, entry, options)
  }

  function mount(renderer, container) {
    if (!renderer || !container) return
    stop()
    current = renderer
    while (container.firstChild) container.removeChild(container.firstChild)
    container.appendChild(renderer.el)
  }

  function stop() {
    if (!current) return
    try { current.dispose() } catch (error) { /* one bad element must not block the next */ }
    current = null
  }

  function setVolume(value) {
    if (current && typeof current.setVolume === 'function') current.setVolume(value)
  }

  return {
    create: create,
    mount: mount,
    stop: stop,
    setVolume: setVolume,
    get current() { return current }
  }
}
