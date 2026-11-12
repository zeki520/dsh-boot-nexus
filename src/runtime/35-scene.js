/**
 * Suite-scene renderer.
 *
 * The old suite act is a small paper-and-ink presentation: a brand line, one
 * large Chinese step, its English caption, a log line and a progress bar. The
 * host resolves a template into this tiny description; this renderer owns the
 * timeline and nothing else. It uses the shared clock so a skip or a dispose
 * cancels every pending step in one place.
 *
 * Contract: { kind, el, start, pause, resume, dispose, currentTime, duration,
 *             setVolume }
 */
function dbnCreateSceneRenderer(options) {
  var doc = options.doc
  var clock = options.clock
  var scene = options.scene || {}
  var steps = Array.isArray(scene.steps) && scene.steps.length ? scene.steps : []
  var accent = (scene.theme && scene.theme.accent) || '#ff7500'
  var paper = '#f2ecdf'
  var ink = '#1b1712'
  var muted = '#6f665b'
  var index = -1
  var disposed = false
  var started = false
  var startedAt = 0
  var stepTimer = null
  var fadeTimer = null
  var total = 0
  var i

  for (i = 0; i < steps.length; i++) total += Math.max(0, Number(steps[i].hold) || 0)

  var el = doc.createElement('div')
  el.className = 'dbn-scene'
  el.setAttribute('role', 'img')
  el.setAttribute('aria-label', '启动动画')
  el.style.cssText = [
    'position:absolute', 'inset:0', 'display:flex', 'flex-direction:column',
    'background:' + paper, 'color:' + ink, 'overflow:hidden',
    'font-family:"DIN Alternate","Bahnschrift","Microsoft YaHei",sans-serif',
  ].join(';')

  var grid = doc.createElement('div')
  grid.style.cssText = [
    'position:absolute', 'inset:0', 'pointer-events:none', 'opacity:.5',
    'background-image:linear-gradient(rgba(27,23,18,.055) 1px,transparent 1px),' +
      'linear-gradient(90deg,rgba(27,23,18,.055) 1px,transparent 1px)',
    'background-size:64px 64px',
  ].join(';')
  el.appendChild(grid)

  var brand = doc.createElement('div')
  brand.style.cssText = [
    'position:relative', 'display:flex', 'align-items:center', 'gap:14px',
    'padding:34px 46px 0', 'font-size:14px', 'letter-spacing:.22em',
    'text-transform:uppercase', 'color:' + muted,
  ].join(';')
  var brandA = doc.createElement('span')
  brandA.textContent = 'DEEPSEEK'
  brandA.style.cssText = 'color:' + ink + ';font-weight:700;letter-spacing:.3em'
  var brandB = doc.createElement('span')
  brandB.textContent = 'HARNESS'
  var brandLine = doc.createElement('span')
  brandLine.style.cssText = 'flex:1;height:1px;background:rgba(27,23,18,.22)'
  brand.appendChild(brandA)
  brand.appendChild(brandB)
  brand.appendChild(brandLine)
  el.appendChild(brand)

  var body = doc.createElement('div')
  body.style.cssText = [
    'position:relative', 'flex:1', 'display:flex', 'flex-direction:column',
    'justify-content:center', 'padding:0 46px 18px',
  ].join(';')
  el.appendChild(body)

  var badge = doc.createElement('div')
  badge.style.cssText = [
    'font-size:13px', 'letter-spacing:.28em', 'text-transform:uppercase',
    'color:' + accent, 'margin-bottom:22px', 'min-height:18px',
  ].join(';')
  body.appendChild(badge)

  var zh = doc.createElement('div')
  zh.style.cssText = [
    'font-size:76px', 'line-height:1.1', 'font-weight:650', 'letter-spacing:-.03em',
    'max-width:1180px', 'transition:opacity .45s ease,transform .45s ease',
    'transform:translateY(10px)',
  ].join(';')
  body.appendChild(zh)

  var en = doc.createElement('div')
  en.style.cssText = [
    'margin-top:18px', 'font-size:18px', 'letter-spacing:.2em',
    'text-transform:uppercase', 'color:' + muted, 'transition:opacity .45s ease',
  ].join(';')
  body.appendChild(en)

  var footer = doc.createElement('div')
  footer.style.cssText = [
    'position:relative', 'padding:0 46px 40px', 'display:flex',
    'flex-direction:column', 'gap:14px',
  ].join(';')
  el.appendChild(footer)

  var log = doc.createElement('div')
  log.style.cssText = [
    'display:flex', 'justify-content:space-between', 'gap:24px',
    'font-size:14px', 'letter-spacing:.08em', 'color:' + muted,
  ].join(';')
  var logZh = doc.createElement('span')
  var logEn = doc.createElement('span')
  logEn.style.cssText = 'opacity:.65;letter-spacing:.16em;text-transform:uppercase'
  log.appendChild(logZh)
  log.appendChild(logEn)
  footer.appendChild(log)

  var track = doc.createElement('div')
  track.style.cssText = 'position:relative;height:4px;background:rgba(27,23,18,.13);overflow:hidden'
  var fill = doc.createElement('div')
  fill.style.cssText = 'position:absolute;inset:0 auto 0 0;width:0;background:' + accent +
    ';transition:width .7s cubic-bezier(.2,.7,.2,1)'
  track.appendChild(fill)
  footer.appendChild(track)

  function stepAt(i2) {
    var step = steps[i2] || {}
    badge.textContent = step.badge || ''
    zh.textContent = step.zh || ''
    en.textContent = step.en || ''
    logZh.textContent = step.log || ''
    logEn.textContent = step.logEn || ''
    zh.style.opacity = '0'
    zh.style.transform = 'translateY(10px)'
    en.style.opacity = '0'
    fill.style.width = String(Math.max(0, Math.min(1, Number(step.progress) || 0)) * 100) + '%'
    if (fadeTimer) { fadeTimer(); fadeTimer = null }
    fadeTimer = clock.after(24, function () {
      fadeTimer = null
      if (disposed) return
      zh.style.opacity = '1'
      zh.style.transform = 'translateY(0)'
      en.style.opacity = '1'
    })
    return Math.max(0, Number(step.hold) || 0)
  }

  function next() {
    if (disposed || !started) return
    index += 1
    if (index >= steps.length) {
      if (typeof options.onDone === 'function') options.onDone()
      return
    }
    var hold = stepAt(index)
    stepTimer = clock.after(hold, next)
  }

  return {
    kind: 'scene',
    el: el,
    start: function () {
      if (started || disposed) return
      started = true
      startedAt = Date.now()
      next()
    },
    pause: function () { if (stepTimer) { stepTimer(); stepTimer = null } },
    resume: function () {
      if (!disposed && started && stepTimer === null) stepTimer = clock.after(0, next)
    },
    dispose: function () {
      disposed = true
      if (stepTimer) { stepTimer(); stepTimer = null }
      if (fadeTimer) { fadeTimer(); fadeTimer = null }
      if (el.parentNode) el.parentNode.removeChild(el)
    },
    get currentTime() { return started ? Math.max(0, Date.now() - startedAt) : 0 },
    get duration() { return total },
    setVolume: function () {},
  }
}
