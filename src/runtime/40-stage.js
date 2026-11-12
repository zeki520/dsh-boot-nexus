/*
 * The stage: the only owner of the full-screen DOM.
 *
 * One root (`#dbn-root`), created once and reused. The phase is an attribute,
 * not a mount/unmount: `display:none` at phase `off` keeps the node stable, so
 * a late event can never append a second layer. The scroll lock is ref-counted,
 * because the old suite's `finish()` removed `html.dsu-lock` unconditionally —
 * correct only while it was the sole owner, which stopped being true the moment
 * a second plugin existed.
 *
 * The caption has exactly one writer (this stage). The old three-way `!important`
 * fight over the same text node cannot happen when only one module writes it.
 */
function dbnCreateStage(options) {
  var doc = options.doc
  var win = options.win
  var clock = options.clock
  var plan = options.plan

  var root = null
  var stage = null
  var veil = null
  var chrome = null
  var saver = null
  var diag = null
  var caption = null
  var skip = null
  var locks = 0
  var disposed = false
  var phase = DBN.PHASE.OFF
  var previousFocus = null
  var revealToken = 0

  function element(tag, id) {
    var node = doc.createElement(tag)
    if (id) node.id = id
    return node
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild)
  }

  function ensure() {
    if (root) return root
    root = doc.getElementById(DBN.ROOT_ID)
    if (root) {
      clear(root)
    } else {
      root = element('div', DBN.ROOT_ID)
      doc.documentElement.appendChild(root)
    }
    root.setAttribute('data-phase', DBN.PHASE.ARMING)
    root.setAttribute('data-hint', '0')
    root.setAttribute('data-diag', '0')
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-label', '启动动画')
    root.style.background = '#000'
    root.style.opacity = '1'

    stage = element('div', DBN.STAGE_ID)
    veil = element('div', DBN.VEIL_ID)
    chrome = element('div', DBN.CHROME_ID)
    caption = element('div', DBN.CAPTION_ID)
    /*
     * The skip affordance is intentionally invisible for now: the user asked
     * for no on-screen copy during the boot. Escape and click-to-skip still
     * work (see addSkipListener / the root click handler).
     */
    skip = element('button', DBN.SKIP_ID)
    skip.setAttribute('type', 'button')
    skip.setAttribute('aria-label', '跳过启动动画')
    skip.setAttribute('tabindex', '-1')
    skip.style.display = 'none'
    chrome.appendChild(caption)
    chrome.appendChild(skip)

    saver = element('div', DBN.SAVER_ID)
    saver.setAttribute('aria-hidden', 'true')

    root.appendChild(stage)
    root.appendChild(veil)
    root.appendChild(chrome)
    root.appendChild(saver)
    return root
  }

  function lock() {
    ensure()
    locks += 1
    if (locks === 1) doc.documentElement.classList.add('dbn-lock')
  }

  function unlock() {
    if (locks <= 0) return
    locks -= 1
    if (locks === 0) doc.documentElement.classList.remove('dbn-lock')
  }

  function setPhase(next) {
    phase = next
    if (!root) return
    root.setAttribute('data-phase', next)
    if (next === DBN.PHASE.HANDOFF || next === DBN.PHASE.OFF) {
      root.removeAttribute('aria-modal')
      root.removeAttribute('role')
    }
    if (next === DBN.PHASE.OFF) {
      root.style.opacity = '1'
      root.style.transition = ''
      if (previousFocus && typeof previousFocus.focus === 'function') {
        try { previousFocus.focus({ preventScroll: true }) } catch (error) { /* detached */ }
      }
      previousFocus = null
    }
  }

  function setMedia(renderer) {
    ensure()
    if (!renderer) return
    clear(stage)
    stage.appendChild(renderer.el)
  }

  function setSaverMedia(renderer) {
    ensure()
    if (!renderer) return
    clear(saver)
    saver.appendChild(renderer.el)
    saver.style.display = 'block'
  }

  function clearSaver() {
    if (!saver) return
    clear(saver)
    saver.style.display = 'none'
  }

  function clearStage() {
    if (!stage) return
    clear(stage)
  }

  function captionText(text) {
    ensure()
    if (caption) caption.textContent = text || ''
  }

  function hint(on) {
    ensure()
    root.setAttribute('data-hint', on ? '1' : '0')
    if (on) focusSkip()
  }

  function focusSkip() {
    if (!skip) return
    if (!previousFocus && doc.activeElement) previousFocus = doc.activeElement
    try { skip.focus({ preventScroll: true }) } catch (error) { /* old browser */ }
  }

  function reducedMotion() {
    if (plan.boot.reducedMotion === 'on') return true
    if (plan.boot.reducedMotion === 'off') return false
    try {
      return !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches)
    } catch (error) {
      return false
    }
  }

  function reveal(fadeMs, done) {
    ensure()
    var token = ++revealToken
    var duration = reducedMotion() ? 0 : Math.max(0, fadeMs || 0)
    setPhase(DBN.PHASE.HANDOFF)
    if (duration === 0) {
      finishReveal(token, done)
      return
    }
    /*
     * Fade the picture, not an opaque black panel: making the root transparent
     * first means the app underneath is already visible through the clip, so
     * the dissolve reads as the clip fading into the conversation. The old
     * whole-root fade to black was indistinguishable on a dark shell.
     */
    root.style.background = 'transparent'
    var easing = 'opacity ' + duration + 'ms ease-out'
    stage.style.transition = easing
    veil.style.transition = easing
    chrome.style.transition = easing
    stage.style.opacity = '0'
    veil.style.opacity = '0'
    chrome.style.opacity = '0'
    clock.after(duration, function () { finishReveal(token, done) })
  }

  function finishReveal(token, done) {
    if (disposed || token !== revealToken) return
    setPhase(DBN.PHASE.OFF)
    unlock()
    if (typeof done === 'function') done()
  }

  function enterSaver() {
    ensure()
    setPhase(DBN.PHASE.SAVER)
    root.style.background = '#000'
    root.style.opacity = '1'
    root.style.transition = ''
    lock()
  }

  function exitSaver() {
    if (!root) return
    setPhase(DBN.PHASE.OFF)
    clearSaver()
    unlock()
  }

  function diagLine(line) {
    if (!diag || !plan.advanced || !plan.advanced.diag) return
    var text = String(line)
    var lines = (diag.textContent || '').split('\n')
    lines.push(new Date().toISOString().slice(11, 23) + ' ' + text)
    while (lines.length > 40) lines.shift()
    diag.textContent = lines.join('\n')
  }

  function addSkipListener(handler) {
    ensure()
    function onSkipClick(event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
      handler('button')
    }
    skip.addEventListener('click', onSkipClick)
    return function () { skip.removeEventListener('click', onSkipClick) }
  }

  function addRootClickListener(handler) {
    ensure()
    function onClick(event) {
      if (event && event.target === skip) return
      handler('root')
    }
    root.addEventListener('click', onClick)
    return function () { root.removeEventListener('click', onClick) }
  }

  function getRoot() { return root }
  function getStage() { ensure(); return stage }
  function getSaver() { ensure(); return saver }
  function getSkip() { ensure(); return skip }

  function dispose() {
    if (disposed) return
    disposed = true
    revealToken += 1
    unlock()
    locks = 0
    clearSaver()
    if (root && root.parentNode) root.parentNode.removeChild(root)
    root = null
    stage = null
    veil = null
    chrome = null
    saver = null
    diag = null
    caption = null
    skip = null
    doc.documentElement.classList.remove('dbn-lock')
  }

  return {
    ensure: ensure,
    lock: lock,
    unlock: unlock,
    setPhase: setPhase,
    get phase() { return phase },
    setMedia: setMedia,
    setSaverMedia: setSaverMedia,
    clearStage: clearStage,
    clearSaver: clearSaver,
    caption: captionText,
    hint: hint,
    focusSkip: focusSkip,
    reveal: reveal,
    enterSaver: enterSaver,
    exitSaver: exitSaver,
    diag: diagLine,
    addSkipListener: addSkipListener,
    addRootClickListener: addRootClickListener,
    getRoot: getRoot,
    getStage: getStage,
    getSaver: getSaver,
    getSkip: getSkip,
    dispose: dispose
  }
}
