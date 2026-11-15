/**
 * dsh-boot-nexus — browser half.
 *
 * Two responsibilities, in this order:
 *   1. Tell the boot runtime that the client bundle is alive. This is what
 *      releases the hand-off gate; without it the screen waits for its hard
 *      deadline and fades late.
 *   2. Contribute one settings card. The card is a convenience: every failure
 *      here is logged and swallowed, because a decorative screen must never
 *      break the client roster.
 *
 * The card talks to the Host route (`/dsh-boot-nexus/config`) rather than the
 * per-entry config form. The Host config file is the only truth; exposing the
 * two host paths (configFile/mediaDir) in a form would recreate the split
 * brain this plugin exists to remove.
 */
window.__ModuleLoader__.load({
  id: 'dsh-boot-nexus',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = null
    try { React = require('react') } catch (error) { React = null }

    var ROUTE = '/dsh-boot-nexus'
    var SLOT = 'plugins.item'
    var ENTRY_ID = 'boot-nexus'
    var CARD_KEY = '__DBN_CARD__'
    var announced = false

    /**
     * The runtime is injected in the document head and normally exists before
     * this bundle. If it does not (an older index, a skipped boot, a reload
     * race), wait briefly for its `dbn:ready` event instead of polling
     * forever. `clientReady` is idempotent on the runtime side.
     */
    /**
     * One same-origin line of evidence per client boot. The Host route appends
     * it to the diag log. This is deliberately fire-and-forget: a diagnostic
     * probe must never delay `clientReady` or break the settings card.
     */
    function probe(reason) {
      try {
        if (typeof window.fetch !== 'function') return
        var api = window.__BOOT_NEXUS__
        var root = document.getElementById('dbn-root')
        var payload = {
          reason: reason,
          href: String(window.location && window.location.href || ''),
          readyState: document.readyState,
          hasPlan: !!window.__DBN_PLAN__,
          planVersion: window.__DBN_VERSION__ || '',
          hasApi: !!api,
          apiState: api ? String(api.state || '') : '',
          apiPhase: api ? String(api.phase || '') : '',
          failed: api ? !!api.failed : null,
          error: api && api.error ? String(api.error) : '',
          logs: api && api.logs ? api.logs.slice(-15) : [],
          mediaClips: api && api.plan && api.plan.media && api.plan.media.clips ? api.plan.media.clips.length : -1,
          mediaSavers: api && api.plan && api.plan.media && api.plan.media.savers ? api.plan.media.savers.length : -1,
          bootMode: api && api.plan && api.plan.boot ? String(api.plan.boot.mode || '') : '',
          bootClip: api && api.plan && api.plan.boot ? String(api.plan.boot.clip || '') : '',
          root: !!root,
          rootPhase: root ? String(root.getAttribute('data-phase') || '') : '',
          scripts: document.scripts ? document.scripts.length : -1,
          ts: Date.now(),
        }
        var body = JSON.stringify(payload)
        window.fetch(ROUTE + '/diag', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body,
          keepalive: true,
        }).catch(function () {})
      } catch (error) { /* diagnostics must never affect the client */ }
    }

    function announce() {
      if (typeof window === 'undefined') return
      probe('apply')
      var api = window.__BOOT_NEXUS__
      if (api && typeof api.clientReady === 'function') {
        api.clientReady()
        return
      }
      if (announced) return
      announced = true
      var timer = window.setInterval(function () {
        var late = window.__BOOT_NEXUS__
        if (late && typeof late.clientReady === 'function') {
          window.clearInterval(timer)
          late.clientReady()
        }
      }, 50)
      window.setTimeout(function () { window.clearInterval(timer) }, 5000)
      try {
        window.addEventListener('dbn:ready', function () {
          window.clearInterval(timer)
          var late = window.__BOOT_NEXUS__
          if (late && typeof late.clientReady === 'function') late.clientReady()
        }, { once: true })
      } catch (error) { /* no DOM event support: the poll above still runs */ }
    }

    function clone(value) {
      return JSON.parse(JSON.stringify(value))
    }

    function setIn(object, path, value) {
      var next = clone(object)
      var cursor = next
      for (var i = 0; i < path.length - 1; i += 1) {
        if (cursor[path[i]] === undefined || cursor[path[i]] === null) cursor[path[i]] = {}
        cursor = cursor[path[i]]
      }
      cursor[path[path.length - 1]] = value
      return next
    }

    function toggleIn(object, key, id, enabled) {
      var next = clone(object)
      if (!next.media || typeof next.media !== 'object') next.media = {}
      var list = Array.isArray(next.media[key]) ? next.media[key].slice() : []
      var at = list.indexOf(id)
      if (enabled && at >= 0) list.splice(at, 1)
      if (!enabled && at < 0) list.push(id)
      next.media[key] = list
      return next
    }

    /* ------------------------------------------------------------------ *
     * Settings card appearance.
     *
     * The card is painted by the host's plugin-detail page, which sits on top
     * of whatever wallpaper the user picked. Every rule below is scoped to
     * `.dbn-cfg` and reads DSH's own theme tokens, so the card follows the
     * host light/dark theme and never depends on hashed host class names.
     *
     * The panel stays near-opaque on purpose: the old 6% glass fill put 12px
     * secondary text at roughly 1.3:1 on a bright wallpaper. 96% keeps the
     * wallpaper as a tint without eating the label contrast.
     * ------------------------------------------------------------------ */
    var CFG_CSS = `.dbn-cfg {
  /* ---- palette: host tokens first, dark fallbacks second ---- */
  --dbn-fg: var(--dsw-alias-label-primary, #e8edf5);
  --dbn-fg2: var(--dsw-alias-label-secondary, #b7bdc6);
  --dbn-line: var(--dsw-alias-border-l1, color-mix(in srgb, var(--dbn-fg) 10%, transparent));
  --dbn-line2: var(--dsw-alias-border-l2, color-mix(in srgb, var(--dbn-fg) 16%, transparent));
  --dbn-line3: var(--dsw-alias-border-l3, color-mix(in srgb, var(--dbn-fg) 24%, transparent));
  /* Control boundaries are UI components, not hairlines: WCAG 2.2 1.4.11
     asks for 3:1 against the panel. border-l4 is the host's strongest
     border; the fallback is mixed from the foreground so it adapts to both
     a dark and a light host without knowing which one we are on. */
  --dbn-ctl-line: var(--dsw-alias-border-l4, color-mix(in srgb, var(--dbn-fg) 34%, transparent));
  --dbn-panel: var(--dsw-alias-bg-layer-1, #16171a);
  /* Surface tints come from the foreground, never from hard white: on a
     light host a white 4% wash is invisible, on a dark one it reads right. */
  --dbn-fill: color-mix(in srgb, var(--dbn-fg) 7%, var(--dbn-panel));
  --dbn-card: color-mix(in srgb, var(--dbn-fg) 2.2%, transparent);
  --dbn-card-hi: color-mix(in srgb, var(--dbn-fg) 3.6%, transparent);
  --dbn-fg3: color-mix(in srgb, var(--dbn-fg2) 76%, var(--dbn-panel));
  --dbn-hover: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, var(--dbn-fg) 8%, transparent));
  /* Accent: cyan pulled 28% towards the foreground, so it stays bright on a
     dark host and darkens enough to stay readable on a light one. */
  --dbn-acc: color-mix(in srgb, #22d3ee 72%, var(--dbn-fg));
  --dbn-acc2: color-mix(in srgb, #6d9cff 72%, var(--dbn-fg));
  --dbn-acc-soft: color-mix(in srgb, var(--dbn-acc) 20%, transparent);
  --dbn-acc-line: color-mix(in srgb, var(--dbn-acc) 58%, transparent);
  --dbn-on: var(--dsw-alias-state-success-primary, #43c98a);
  --dbn-warn: var(--dsw-alias-state-warn-primary, #e3b341);
  --dbn-error: var(--dsw-alias-state-error-primary, #ff7b72);
  --dbn-hair: var(--dsh-hairline-width, 1px);
  --dbn-radius: 14px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin: 2px 0 0;
  border: var(--dbn-hair) solid var(--dbn-line2);
  border-radius: 18px;
  background: var(--dbn-panel);
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--dbn-panel) 96%, var(--dbn-fg) 4%),
    var(--dbn-panel));
  box-shadow: 0 18px 48px rgba(0, 0, 0, .28), 0 1px 0 rgba(255, 255, 255, .05) inset;
  -webkit-backdrop-filter: blur(26px) saturate(1.25);
  backdrop-filter: blur(26px) saturate(1.25);
  color: var(--dbn-fg);
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif);
  font-size: 13px;
  line-height: 20px;
  container-type: inline-size;
  color-scheme: light dark;
}
.dbn-cfg * { box-sizing: border-box; }

/* ---- toolbar ------------------------------------------------------- */
.dbn-cfg-bar {
  position: sticky;
  top: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: var(--dbn-hair) solid var(--dbn-line);
  border-radius: 18px 18px 0 0;
  background: var(--dbn-panel);
  background: color-mix(in srgb, var(--dbn-panel) 72%, transparent);
  -webkit-backdrop-filter: blur(26px) saturate(1.25);
  backdrop-filter: blur(26px) saturate(1.25);
}
/* Collapsed: the bar is the whole card, so it owns both corners. :has keeps
   the rule independent of the (always mounted) #dbn-cfg-body wrapper. */
.dbn-cfg:not(:has(.dbn-cfg-body)) .dbn-cfg-bar {
  border-bottom: 0;
  border-radius: 18px;
}
/* Visually hidden, still announced: live regions must exist before the text
   they announce, otherwise status changes are silently dropped. */
.dbn-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
.dbn-cfg-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 24px;
  padding: 0 10px;
  border: var(--dbn-hair) solid var(--dbn-line2);
  border-radius: 999px;
  background: var(--dbn-fill);
  color: var(--dbn-fg2);
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
}
.dbn-cfg-pill::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.dbn-cfg-pill[data-on="true"] {
  border-color: color-mix(in srgb, var(--dbn-on) 45%, transparent);
  background: color-mix(in srgb, var(--dbn-on) 14%, transparent);
  color: var(--dbn-on);
}
.dbn-cfg-pill[data-on="true"]::before { box-shadow: 0 0 8px var(--dbn-on); }
.dbn-cfg-version {
  flex: none;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
  letter-spacing: .02em;
  color: var(--dbn-fg3);
  font-variant-numeric: tabular-nums;
}
.dbn-cfg-spacer { flex: 1 1 auto; min-width: 4px; }
.dbn-cfg-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 13px;
  border: var(--dbn-hair) solid var(--dbn-ctl-line);
  border-radius: 9px;
  background: var(--dbn-fill);
  color: var(--dbn-fg);
  font: inherit;
  font-size: 12.5px;
  white-space: nowrap;
  cursor: pointer;
  transition: border-color .16s ease, box-shadow .16s ease, color .16s ease;
}
.dbn-cfg-btn:hover:not(:disabled):not([aria-disabled="true"]) { border-color: var(--dbn-acc-line); }
.dbn-cfg-btn:disabled,
.dbn-cfg-btn[aria-disabled="true"] { opacity: .55; cursor: default; }
.dbn-cfg-btn--primary {
  color: var(--dbn-acc);
  border-color: var(--dbn-acc-line);
  background: var(--dbn-acc-soft);
  font-weight: 600;
  box-shadow: 0 0 14px rgba(34, 211, 238, .12);
}
.dbn-cfg-btn--primary:hover:not(:disabled) {
  border-color: var(--dbn-acc);
  box-shadow: 0 0 0 3px rgba(34, 211, 238, .14), 0 0 18px rgba(34, 211, 238, .22);
}
.dbn-cfg-btn--ghost {
  padding: 0 8px;
  border-color: transparent;
  background: transparent;
  color: var(--dbn-fg2);
}
.dbn-cfg-btn--ghost:hover:not(:disabled) { color: var(--dbn-fg); border-color: transparent; }
/* Toolbar caret (pure decoration, marked aria-hidden in the markup). */
.dbn-cfg-chev {
  width: 0;
  height: 0;
  flex: none;
  margin-left: 2px;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid currentColor;
  transition: transform .16s ease;
}
.dbn-cfg-chev[data-open="true"] { transform: rotate(180deg); }

/* ---- body ---------------------------------------------------------- */
.dbn-cfg-body {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 14px 16px 16px;
}
.dbn-cfg-note {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dbn-fg3);
}
.dbn-cfg-note[data-tone="ok"] { color: var(--dbn-on); }
.dbn-cfg-note[data-tone="warn"] { color: var(--dbn-warn); }
.dbn-cfg-note[data-tone="error"] { color: var(--dbn-error); }
.dbn-cfg-loading { padding: 14px 16px 16px; }

/* ---- cards: joined into one continuous glass sheet ------------------ */
.dbn-cfg-sec {
  display: block;
  min-width: 0;
}
.dbn-cfg-body > .dbn-cfg-sec + .dbn-cfg-sec { margin-top: -1px; }
.dbn-cfg-card {
  position: relative;
  padding: 15px 16px 16px;
  border: var(--dbn-hair) solid var(--dbn-line);
  border-radius: 0;
  background:
    radial-gradient(240px 170px at -40px -60px, var(--dbn-acc-soft), transparent 72%),
    linear-gradient(180deg, var(--dbn-card-hi), var(--dbn-card) 38%, transparent);
  /* No overflow:hidden and no per-card backdrop-filter: both make Chromium
     paint native inputs/selects with the UA theme instead of our colours. */
}
.dbn-cfg-body > .dbn-cfg-sec:first-of-type .dbn-cfg-card { border-radius: var(--dbn-radius) var(--dbn-radius) 0 0; }
.dbn-cfg-body > .dbn-cfg-sec:last-of-type .dbn-cfg-card { border-radius: 0 0 var(--dbn-radius) var(--dbn-radius); }
.dbn-cfg-body > .dbn-cfg-sec:only-of-type .dbn-cfg-card { border-radius: var(--dbn-radius); }
.dbn-cfg-body > .dbn-cfg-sec + .dbn-cfg-sec .dbn-cfg-card { border-top-color: var(--dbn-line); }
/* Only the top edge of the whole sheet glows; the seams stay calm. */
.dbn-cfg-body > .dbn-cfg-sec:first-of-type .dbn-cfg-card::before {
  content: "";
  position: absolute;
  inset: 0 0 auto;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--dbn-acc-line) 22%, rgba(109, 156, 255, .38) 62%, transparent);
  pointer-events: none;
}
.dbn-cfg-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 13px;
}
.dbn-cfg-card-head::after {
  content: "";
  flex: 1 1 auto;
  height: 1px;
  background: linear-gradient(90deg, var(--dbn-line2), transparent);
}
.dbn-cfg-card-ico { width: 16px; height: 16px; flex: none; color: var(--dbn-acc); filter: drop-shadow(0 0 6px var(--dbn-acc-soft)); }
.dbn-cfg-title {
  margin: 0;
  font-size: 13px;
  line-height: 18px;
  font-weight: 600;
  letter-spacing: .02em;
  color: var(--dbn-fg);
}
.dbn-cfg-sub {
  display: block;
  min-width: 0;
  margin-top: 16px;
}
.dbn-cfg-sub:first-of-type { margin-top: 2px; }
.dbn-cfg-subtitle {
  margin: 0 0 8px;
  padding-bottom: 6px;
  border-bottom: var(--dbn-hair) solid var(--dbn-line);
  font-size: 12.5px;
  line-height: 18px;
  font-weight: 600;
  letter-spacing: .02em;
  color: var(--dbn-fg2);
}

/* ---- field grid ---------------------------------------------------- */
.dbn-cfg-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  column-gap: 40px;
  row-gap: 12px;
  align-items: start;
}
.dbn-cfg-grid--stack { grid-template-columns: minmax(0, 1fr); }
.dbn-cfg-field {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr);
  column-gap: 12px;
  row-gap: 3px;
  align-items: start;
  min-width: 0;
  padding: 3px 0;
  border-radius: 10px;
  transition: background-color .16s ease;
}
.dbn-cfg-field:focus-within { background: var(--dbn-acc-soft); }
.dbn-cfg-label {
  grid-column: 1;
  display: flex;
  align-items: center;
  min-height: 34px;
  font-size: 12.5px;
  line-height: 18px;
  font-weight: 450;
  color: var(--dbn-fg);
  word-break: break-word;
}
.dbn-cfg-control {
  grid-column: 2;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  min-height: 34px;
}
.dbn-cfg-hint {
  grid-column: 2;
  margin: 0;
  font-size: 11.5px;
  line-height: 16px;
  color: var(--dbn-fg3);
}
.dbn-cfg-span { grid-column: 1 / -1; min-width: 0; }

/* ---- controls ------------------------------------------------------ */
.dbn-cfg-input,
.dbn-cfg-select {
  width: 100%;
  min-width: 0;
  height: 34px;
  padding: 0 12px;
  border: var(--dbn-hair) solid var(--dbn-ctl-line);
  border-radius: 9px;
  background-color: var(--dbn-fill);
  color: var(--dbn-fg);
  font: inherit;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  /* Never transition background-color on native controls: the first frame
     starts from the UA "Field" colour and flashes white. */
  transition: border-color .16s ease, box-shadow .16s ease;
}
.dbn-cfg-input::placeholder { color: var(--dbn-fg3); }
.dbn-cfg-input[type="number"] { max-width: 148px; }
.dbn-cfg-select {
  padding-right: 34px;
  line-height: 32px;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  z-index: 0;
}
.dbn-cfg-input:hover,
.dbn-cfg-select:hover { border-color: var(--dbn-line3); }
.dbn-cfg-input:focus,
.dbn-cfg-select:focus {
  outline: none;
  border-color: var(--dbn-acc-line);
  background-color: var(--dbn-fill);
  box-shadow: 0 0 0 3px var(--dbn-acc-soft), 0 0 18px rgba(34, 211, 238, .22);
}
.dbn-cfg-select option { background: var(--dbn-panel); color: var(--dbn-fg); }

/* Custom caret: a decorative span keeps the native <select> semantics. */
.dbn-cfg-select-wrap { position: relative; display: block; width: 100%; min-width: 0; }
.dbn-cfg-caret {
  position: absolute;
  top: 50%;
  right: 11px;
  width: 15px;
  height: 15px;
  z-index: 2;
  transform: translateY(-50%);
  color: var(--dbn-fg3);
  pointer-events: none;
  transition: transform .22s cubic-bezier(.4, .1, .2, 1), color .18s ease;
}
.dbn-cfg-select-wrap:hover .dbn-cfg-caret { transform: translateY(-50%) rotate(180deg); color: var(--dbn-acc); }
.dbn-cfg-select-wrap:focus-within .dbn-cfg-caret { color: var(--dbn-acc); }

/* Checkbox rendered as a switch (same input, same onChange). */
.dbn-cfg-check {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  flex: none;
  width: 38px;
  height: 21px;
  margin: 0;
  border: var(--dbn-hair) solid var(--dbn-ctl-line);
  border-radius: 999px;
  background: var(--dbn-fill);
  cursor: pointer;
  transition: border-color .18s ease, box-shadow .18s ease;
}
.dbn-cfg-check::before {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: #cdd6e4;
  box-shadow: 0 1px 3px rgba(0, 0, 0, .45);
  transition: transform .18s cubic-bezier(.4, .1, .2, 1), background-color .18s ease, box-shadow .18s ease;
}
.dbn-cfg-check:hover { border-color: var(--dbn-line3); }
.dbn-cfg-check:checked {
  border-color: var(--dbn-acc-line);
  background: linear-gradient(90deg, var(--dbn-acc-soft), rgba(109, 156, 255, .28));
  box-shadow: 0 0 0 1px var(--dbn-acc-line), 0 0 14px rgba(34, 211, 238, .3);
}
.dbn-cfg-check:checked::before {
  transform: translateX(17px);
  background: #e9fbff;
  box-shadow: 0 0 10px rgba(34, 211, 238, .85), 0 1px 2px rgba(0, 0, 0, .4);
}

/* Range: thin track, glowing thumb. --pct drives the filled segment. */
.dbn-cfg-range {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  height: 20px;
  margin: 0;
  background: transparent;
  appearance: none;
  -webkit-appearance: none;
  cursor: pointer;
}
.dbn-cfg-range::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 999px;
  background:
    linear-gradient(90deg, var(--dbn-acc) 0%, var(--dbn-acc2) var(--pct, 50%),
      rgba(255, 255, 255, .10) var(--pct, 50%), rgba(255, 255, 255, .10) 100%);
}
.dbn-cfg-range::-webkit-slider-thumb {
  width: 15px;
  height: 15px;
  margin-top: -5.5px;
  border: 1px solid rgba(255, 255, 255, .7);
  border-radius: 50%;
  background: radial-gradient(circle at 32% 28%, #f2feff, #22d3ee 62%, #0e9bb5);
  appearance: none;
  -webkit-appearance: none;
  box-shadow:
    0 0 0 3px rgba(34, 211, 238, .16),
    0 0 14px rgba(34, 211, 238, .65),
    0 0 26px rgba(34, 211, 238, .35),
    inset 0 -1px 2px rgba(0, 90, 110, .55),
    inset 0 1px 2px rgba(255, 255, 255, .9);
  transition: box-shadow .16s ease, transform .16s ease;
}
.dbn-cfg-range:hover::-webkit-slider-thumb {
  box-shadow:
    0 0 0 5px rgba(34, 211, 238, .2),
    0 0 20px rgba(34, 211, 238, .85),
    0 0 34px rgba(34, 211, 238, .45),
    inset 0 -1px 2px rgba(0, 90, 110, .5),
    inset 0 1px 2px rgba(255, 255, 255, .95);
}
.dbn-cfg-range:active::-webkit-slider-thumb { transform: scale(1.06); }
.dbn-cfg-range::-moz-range-track { height: 4px; border-radius: 999px; background: var(--dbn-acc-soft); }
.dbn-cfg-range::-moz-range-thumb {
  width: 15px; height: 15px; border: 1px solid rgba(255, 255, 255, .7); border-radius: 50%;
  background: radial-gradient(circle at 32% 28%, #f2feff, #22d3ee 62%, #0e9bb5);
  box-shadow: 0 0 0 3px rgba(34, 211, 238, .16), 0 0 14px rgba(34, 211, 238, .65);
}
.dbn-cfg-value {
  flex: none;
  min-width: 38px;
  text-align: right;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--dbn-acc);
  text-shadow: 0 0 10px rgba(34, 211, 238, .45);
}

.dbn-cfg :is(input, select, button):focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dbn-acc));
  outline-offset: 1px;
}
.dbn-cfg :is(input, select, button, textarea) { scroll-margin-block: 64px; }

/* ---- media pool ---------------------------------------------------- */
.dbn-cfg-media {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px;
  border: var(--dbn-hair) solid var(--dbn-line);
  border-radius: 10px;
  background: var(--dbn-fill);
  max-height: 208px;
  overflow: auto;
}
.dbn-cfg-media-row {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  cursor: pointer;
}
.dbn-cfg-media-row:hover { background: var(--dbn-hover); }
/* The media list keeps a compact square checkbox: the switch shape belongs
   to standalone on/off fields, not to per-file selection. */
.dbn-cfg-media .dbn-cfg-check {
  width: 16px;
  height: 16px;
  border-radius: 5px;
}
.dbn-cfg-media .dbn-cfg-check::before { display: none; }
.dbn-cfg-media .dbn-cfg-check:checked {
  border-color: var(--dbn-acc);
  background: var(--dbn-acc);
  box-shadow: 0 0 10px var(--dbn-acc-soft);
}
.dbn-cfg-media .dbn-cfg-check:checked::after {
  content: "";
  position: absolute;
  left: 4.5px;
  top: 1.5px;
  width: 4px;
  height: 8px;
  border: solid var(--dbn-panel);
  border-width: 0 2px 2px 0;
  border-radius: 1px;
  transform: rotate(42deg);
}
.dbn-cfg-media-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}
.dbn-cfg-media-kind {
  flex: none;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--dbn-fg3);
}
.dbn-cfg-mini {
  margin: 2px 0 0;
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  color: var(--dbn-fg2);
}
.dbn-cfg-path {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
  line-height: 16px;
  color: var(--dbn-fg3);
  word-break: break-all;
  user-select: text;
}

/* ---- narrow: one column per field row ------------------------------ */
@container (max-width: 820px) {
  .dbn-cfg-grid { grid-template-columns: minmax(0, 1fr); row-gap: 10px; }
  .dbn-cfg-field { grid-template-columns: 128px minmax(0, 1fr); }
  .dbn-cfg-card { padding: 13px 13px 14px; }
}
@container (max-width: 560px) {
  .dbn-cfg-field { grid-template-columns: 108px minmax(0, 1fr); }
}
@media (max-width: 560px) {
  .dbn-cfg-grid { grid-template-columns: minmax(0, 1fr); }
  .dbn-cfg-field { grid-template-columns: 108px minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  .dbn-cfg-btn, .dbn-cfg-chev, .dbn-cfg-caret, .dbn-cfg-check, .dbn-cfg-check::before,
  .dbn-cfg-range::-webkit-slider-thumb { transition: none; }
}
`

    function BootNexusCard() {
      var h = React.createElement
      var state = React.useState(null)
      var payload = state[0]
      var setPayload = state[1]
      var draftState = React.useState(null)
      var draft = draftState[0]
      var setDraft = draftState[1]
      var statusState = React.useState('loading')
      var status = statusState[0]
      var setStatus = statusState[1]
      var errorState = React.useState('')
      var error = errorState[0]
      var setError = errorState[1]
      var openState = React.useState(true)
      var open = openState[0]
      var setOpen = openState[1]

      /*
       * Labels stay attached to their control through a generated id. The
       * counter restarts on every render, which is fine: the field order is
       * static, so an id keeps pointing at the same control.
       */
      var uid = 0
      function nextId(prefix) {
        uid += 1
        return 'dbn-' + prefix + '-' + uid
      }

      function load() {
        setStatus('loading')
        setError('')
        fetch(ROUTE + '/config', { cache: 'no-store' })
          .then(function (response) {
            return response.json().then(function (body) {
              if (!response.ok) throw new Error((body && body.error) || ('HTTP ' + response.status))
              return body
            })
          })
          .then(function (body) {
            setPayload(body)
            setDraft(clone(body.config))
            setStatus('idle')
          })
          .catch(function (failure) {
            setStatus('error')
            setError(String((failure && failure.message) || failure))
          })
      }

      React.useEffect(function () { load() }, [])

      if (!draft) {
        return h('div', { className: 'dbn-cfg' },
          h('style', { key: 'dbn-cfg-css' }, CFG_CSS),
          h('div', { className: 'dbn-cfg-bar' },
            h('span', { className: 'dbn-cfg-pill' }, status === 'loading' ? '读取中…' : '配置不可用')),
          error ? h('p', { className: 'dbn-cfg-note dbn-cfg-loading', role: 'alert' }, error) : null)
      }

      var cfg = draft

      function update(path, value) {
        setDraft(function (previous) { return setIn(previous, path, value) })
      }

      function number(path) {
        return function (event) {
          var raw = event.target.value
          /* A controlled number input reports '' while the text is still an
             intermediate form ("1.", "-"), and Number('') is 0. Writing that
             would turn a half-typed 1.5 into 5, so hold the model until the
             text parses. */
          if (raw === '') return
          var value = Number(raw)
          if (Number.isFinite(value)) update(path, value)
        }
      }

      function checkbox(path) {
        return function (event) { update(path, event.target.checked) }
      }

      function select(path) {
        return function (event) { update(path, event.target.value) }
      }

      function toggleDisabled(key, id, enabled) {
        setDraft(function (previous) { return toggleIn(previous, key, id, enabled) })
      }

      function save() {
        setStatus('saving')
        setError('')
        return fetch(ROUTE + '/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ config: draft }),
        })
          .then(function (response) {
            return response.json().then(function (body) {
              if (!response.ok) throw new Error((body && body.error) || ('HTTP ' + response.status))
              return body
            })
          })
          .then(function (body) {
            setPayload(function (previous) {
              var next = Object.assign({}, previous || {}, body || {})
              /* Older hosts return only {config,media,digest}. Keep the GET-only
                 fields so the suite controls do not collapse to '' / 0. */
              next.suiteConfig = (body && body.suiteConfig) || (previous && previous.suiteConfig)
              next.suiteTemplates = (body && body.suiteTemplates) || (previous && previous.suiteTemplates)
              next.paths = (body && body.paths) || (previous && previous.paths)
              next.warnings = (body && body.warnings) || (previous && previous.warnings) || []
              next.media = (body && body.media) || (previous && previous.media) || { clips: [], savers: [] }
              return next
            })
            setDraft(clone(body.config))
            setStatus('saved')
            return body
          })
          .catch(function (failure) {
            setStatus('error')
            setError(String((failure && failure.message) || failure))
            return null
          })
      }

      function preview() {
        var api = window.__BOOT_NEXUS__
        if (api && typeof api.preview === 'function') {
          save().then(function (saved) {
            if (saved) api.preview()
          })
          return
        }
        var url = new URL(window.location.href)
        url.searchParams.set('dbn', 'preview')
        window.location.assign(url.toString())
      }

      function field(label, control, hint) {
        var id = (control.props && control.props.id) || nextId('f')
        var isSelect = control.type === 'select'
        var kind = isSelect ? 'dbn-cfg-select' : 'dbn-cfg-input'
        var hintId = hint ? id + '-hint' : undefined
        var input = React.cloneElement(control, {
          id: id,
          className: [control.props.className, kind].filter(Boolean).join(' '),
          'aria-describedby': hintId,
        })
        /* The caret is decoration only: the native <select> keeps its role,
           its name (from <label for>) and its keyboard behaviour. */
        var controlNode = isSelect
          ? h('span', { className: 'dbn-cfg-select-wrap' }, input, caretSvg())
          : input
        return h('div', { className: 'dbn-cfg-field', key: label },
          h('label', { className: 'dbn-cfg-label', htmlFor: id }, label),
          h('div', { className: 'dbn-cfg-control' }, controlNode),
          hint ? h('p', { className: 'dbn-cfg-hint', id: hintId }, hint) : null)
      }

      function caretSvg() {
        return h('svg', {
          className: 'dbn-cfg-caret',
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        }, h('path', { d: 'm6 9 6 6 6-6' }))
      }

      function switchField(label, checked, onChange) {
        var id = nextId('s')
        return h('div', { className: 'dbn-cfg-field', key: 'sw-' + label },
          h('label', { className: 'dbn-cfg-label', htmlFor: id }, label),
          h('div', { className: 'dbn-cfg-control' },
            h('input', {
              id: id,
              className: 'dbn-cfg-check',
              type: 'checkbox',
              checked: checked,
              onChange: onChange,
            })))
      }

      function sliderField(label, value, path) {
        var id = nextId('r')
        var text = Math.round((Number(value) || 0) * 100) + '%'
        return h('div', { className: 'dbn-cfg-field', key: label },
          h('label', { className: 'dbn-cfg-label', htmlFor: id }, label),
          h('div', { className: 'dbn-cfg-control' },
            h('input', {
              id: id,
              className: 'dbn-cfg-range',
              type: 'range',
              min: 0,
              max: 1,
              step: 0.05,
              value: value,
              /* --pct paints the filled part of the track; CSS cannot know
                 the value on its own. */
              style: { '--pct': Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100) + '%' },
              'aria-valuetext': text,
              onChange: number(path),
            }),
            h('span', { className: 'dbn-cfg-value', 'aria-hidden': 'true' }, text)))
      }

      /* Section icons: tiny, decorative, keyed by the section title. */
      var SECTION_ICONS = [
        [/^(片头|片头动画)/, ['M8 5.6v12.8L19 12z']],
        [/suite|原版/i, ['M12 3.2 3.4 7.9 12 12.6l8.6-4.7z', 'm3.4 12.3 8.6 4.7 8.6-4.7', 'm3.4 16.6 8.6 4.7 8.6-4.7']],
        [/屏保/, ['M20.2 14.6A8.6 8.6 0 0 1 9.4 3.8a8.6 8.6 0 1 0 10.8 10.8z']],
        [/素材/, ['M3.2 7.4A2.4 2.4 0 0 1 5.6 5h3l2 2.4h8.8A2.4 2.4 0 0 1 21.8 9.8v7A2.4 2.4 0 0 1 19.4 19.2H5.6a2.4 2.4 0 0 1-2.4-2.4z']],
        [/高级|设置/, ['M4 8h9M17 8h3M4 16h5M13 16h7', 'M15 8a2 2 0 1 0-4 0 2 2 0 0 0 4 0z', 'M11 16a2 2 0 1 0-4 0 2 2 0 0 0 4 0z']],
      ]

      function sectionIcon(title) {
        var paths = null
        for (var i = 0; i < SECTION_ICONS.length; i++) {
          if (SECTION_ICONS[i][0].test(String(title))) { paths = SECTION_ICONS[i][1]; break }
        }
        if (!paths) paths = ['M12 4.2v15.6M4.2 12h15.6']
        return h('svg', {
          className: 'dbn-cfg-card-ico',
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        }, paths.map(function (d, index) { return h('path', { key: index, d: d }) }))
      }

      function section(title, children, options) {
        /* One flat settings surface: every control is visible without a
           second disclosure click; only the whole card can collapse. */
        var opts = options || {}
        var sub = opts.level === 2
        var titleId = nextId('g')
        var grid = h('div', { className: 'dbn-cfg-grid' + (opts.stack ? ' dbn-cfg-grid--stack' : '') }, children)
        if (sub) {
          return h('section', {
            className: 'dbn-cfg-sub',
            key: title,
            'aria-labelledby': titleId,
          },
            h('h5', { className: 'dbn-cfg-subtitle', id: titleId }, title),
            grid)
        }
        return h('section', {
          className: 'dbn-cfg-sec',
          key: title,
          'aria-labelledby': titleId,
        },
          h('div', { className: 'dbn-cfg-card' },
            h('div', { className: 'dbn-cfg-card-head' },
              sectionIcon(title),
              h('h4', { className: 'dbn-cfg-title', id: titleId }, title)),
            grid))
      }

      function suiteText(label, key, hint) {
        return field(label, h('input', {
          value: suiteCfg[key] === undefined ? '' : suiteCfg[key],
          onChange: function (event) { update(['extensions', 'suite', key], event.target.value) },
        }), hint)
      }

      function suiteNumber(label, key, min, max, step, hint) {
        return field(label, h('input', {
          type: 'number', min: min, max: max, step: step || 1,
          value: suiteCfg[key] === undefined ? 0 : suiteCfg[key],
          onChange: function (event) {
            var value = Number(event.target.value)
            if (Number.isFinite(value)) update(['extensions', 'suite', key], value)
          },
        }), hint)
      }

      function suiteSwitch(label, key) {
        return switchField(label, !!suiteCfg[key], function (event) {
          update(['extensions', 'suite', key], event.target.checked)
        })
      }

      function suiteSelect(label, key, options, hint) {
        return field(label, h('select', {
          value: suiteCfg[key] === undefined ? '' : suiteCfg[key],
          onChange: function (event) { update(['extensions', 'suite', key], event.target.value) },
        }, options.map(function (item) {
          return h('option', { key: item[0], value: item[0] }, item[1])
        })), hint)
      }

      var COLOR_OPTIONS = [
        ['#ff7500', '橙色'], ['#ff3b30', '红色'], ['#2971b8', '蓝色'],
        ['#1e48ba', '深蓝'], ['#2ecc71', '绿色'], ['#8e44ad', '紫色'],
        ['#00bcd4', '青色'], ['#ff6fa5', '粉色'], ['#d4af37', '金色'],
        ['#ffffff', '白色'], ['#000000', '黑色'], ['#7f8c8d', '灰色'],
      ]

      function suiteColor(label, key, hint) {
        var value = suiteCfg[key] === undefined ? '' : String(suiteCfg[key])
        var options = COLOR_OPTIONS.slice()
        var known = options.some(function (item) { return item[0] === value })
        if (value && !known) options.push([value, '自定义'])
        return field(label, h('select', {
          value: value,
          onChange: function (event) { update(['extensions', 'suite', key], event.target.value) },
        }, options.map(function (item) {
          return h('option', { key: item[0], value: item[0] }, item[1])
        })), hint)
      }

      function mediaList(key, items) {
        if (!items || !items.length) {
          return h('p', { className: 'dbn-cfg-note dbn-cfg-span' },
            '未发现媒体文件。把视频放进 ' + (key === 'disabledClips' ? 'clips' : 'savers') + ' 目录后点“重新读取”。')
        }
        var listLabel = key === 'disabledClips' ? '片头素材' : '屏保素材'
        return h('div', {
          className: 'dbn-cfg-media dbn-cfg-span',
          role: 'group',
          'aria-label': listLabel,
        }, items.map(function (item) {
          var id = item.id || item.name
          var enabled = ((cfg.media || {})[key] || []).indexOf(id) < 0
          return h('label', { key: id, className: 'dbn-cfg-media-row' },
            h('input', {
              className: 'dbn-cfg-check',
              type: 'checkbox',
              checked: enabled,
              onChange: function (event) { toggleDisabled(key, item.id, event.target.checked) },
            }),
            h('span', { className: 'dbn-cfg-media-name', title: item.name }, item.name),
            h('span', { className: 'dbn-cfg-media-kind' }, item.kind))
        }))
      }

      var media = (payload && payload.media) || { clips: [], savers: [] }
      var paths = (payload && payload.paths) || {}
      var warnings = (payload && payload.warnings) || []
      var suiteCfg = Object.assign({},
        (cfg.legacy && cfg.legacy.suite) || {},
        (payload && payload.suiteConfig) || {},
        (cfg.extensions && cfg.extensions.suite) || {})

      var busy = status === 'saving'
      var header = h('div', { className: 'dbn-cfg-bar' },
        h('span', {
          className: 'dbn-cfg-pill',
          'data-on': cfg.enabled ? 'true' : 'false',
        }, cfg.enabled ? '已启用' : '已禁用'),
        payload && payload.version
          ? h('span', { className: 'dbn-cfg-version', title: '插件版本' }, 'v' + String(payload.version))
          : null,
        h('span', { className: 'dbn-cfg-spacer' }),
        open ? [
          /* aria-disabled rather than disabled: a disabled button loses focus
             to <body>, which drops keyboard and screen-reader users out of the
             toolbar while the save round-trip runs. */
          h('button', {
            key: 'reload',
            type: 'button',
            className: 'dbn-cfg-btn',
            onClick: function () { if (!busy) load() },
            'aria-disabled': busy ? 'true' : undefined,
          }, '重新读取'),
          h('button', {
            key: 'save',
            type: 'button',
            className: 'dbn-cfg-btn dbn-cfg-btn--primary',
            onClick: function () { if (!busy) save() },
            'aria-disabled': busy ? 'true' : undefined,
          }, busy ? '保存中…' : '保存'),
          h('button', {
            key: 'preview',
            type: 'button',
            className: 'dbn-cfg-btn',
            onClick: function () { if (!busy) preview() },
            'aria-disabled': busy ? 'true' : undefined,
          }, '预览'),
        ] : null,
        h('button', {
          type: 'button',
          className: 'dbn-cfg-btn dbn-cfg-btn--ghost',
          'aria-expanded': open ? 'true' : 'false',
          'aria-controls': 'dbn-cfg-body',
          onClick: function () { setOpen(function (value) { return !value }) },
        }, open ? '收起' : '展开',
        h('span', {
          className: 'dbn-cfg-chev',
          'data-open': open ? 'true' : 'false',
          'aria-hidden': 'true',
        })))

      /* Live regions stay mounted and empty until something is announced:
         a role=status node inserted together with its text is not reliably
         spoken, and the collapsed state must still expose them. */
      var liveStatus = status === 'saving'
        ? '正在保存配置。'
        : status === 'saved'
          ? '已保存，下次启动生效。'
          : warnings.length ? '迁移或校验提示：' + warnings.join('；') : ''

      return h('div', { className: 'dbn-cfg' },
        h('style', { key: 'dbn-cfg-css' }, CFG_CSS),
        header,
        h('div', {
          className: 'dbn-sr',
          role: 'status',
          'aria-live': 'polite',
          'aria-atomic': 'true',
        }, liveStatus),
        h('div', {
          className: 'dbn-sr',
          role: 'alert',
          'aria-live': 'assertive',
          'aria-atomic': 'true',
        }, error || ''),
        h('div', { id: 'dbn-cfg-body' }, open ? h('div', { className: 'dbn-cfg-body' },
          status === 'saved'
            ? h('p', { className: 'dbn-cfg-note', 'data-tone': 'ok' }, '已保存。下次启动生效。')
            : null,
          error ? h('p', { className: 'dbn-cfg-note', 'data-tone': 'error' }, error) : null,
          warnings.length
            ? h('p', { className: 'dbn-cfg-note', 'data-tone': 'warn' }, '迁移/校验提示：' + warnings.join('；'))
            : null,

          section('片头', [
            section('播放与模板', [
              switchField('启用片头', cfg.enabled, checkbox(['enabled'])),
              field('播放频率', h('select', {
                value: cfg.boot.mode,
                onChange: select(['boot', 'mode']),
              },
              h('option', { value: 'session' }, '每个会话一次'),
              h('option', { value: 'daily' }, '每天一次'),
              h('option', { value: 'always' }, '每次启动')),
              'session 依赖 sessionStorage；daily 依赖 localStorage 的本地日期。'),
              field('启动方式', h('select', {
                value: cfg.boot.choice,
                onChange: select(['boot', 'choice']),
              },
              h('option', { value: 'random' }, '随机：视频 或 suite 二选一'),
              h('option', { value: 'clip' }, '只播视频（animation）'),
              h('option', { value: 'suite' }, '只播 suite（原版引擎）')),
              '随机模式每次启动掷一次：一半只播一段视频，一半播 suite 第一幕 + 第二幕。'),
              field('suite 第一幕', (function () {
                var options = [h('option', { key: 'auto', value: 'auto' }, '跟随 suite 配置（auto）')]
                var list = (payload && payload.suiteTemplates) || []
                list.forEach(function (item) {
                  options.push(h('option', { key: item.id, value: item.id }, item.name + ' (' + item.id + ')'))
                })
                if (cfg.boot.suiteAct1 !== 'auto' && !list.some(function (item) { return item.id === cfg.boot.suiteAct1 })) {
                  options.push(h('option', { key: 'current', value: cfg.boot.suiteAct1 }, cfg.boot.suiteAct1))
                }
                return h('select', { value: cfg.boot.suiteAct1, onChange: select(['boot', 'suiteAct1']) }, options)
              })(), '来自 suite 包和 ~/.dsh/startup-templates 的模板。'),
              field('suite 第二幕', (function () {
                var options = [
                  h('option', { key: 'auto', value: 'auto' }, '跟随 suite 配置（auto）'),
                  h('option', { key: 'none', value: 'none' }, '不播第二幕（none）'),
                ]
                var list = (payload && payload.suiteTemplates) || []
                list.forEach(function (item) {
                  options.push(h('option', { key: item.id, value: item.id }, item.name + ' (' + item.id + ')' + (item.duration ? ' · ' + item.duration + 'ms' : '')))
                })
                if (cfg.boot.suiteAct2 !== 'auto' && cfg.boot.suiteAct2 !== 'none' && !list.some(function (item) { return item.id === cfg.boot.suiteAct2 })) {
                  options.push(h('option', { key: 'current', value: cfg.boot.suiteAct2 }, cfg.boot.suiteAct2))
                }
                return h('select', { value: cfg.boot.suiteAct2, onChange: select(['boot', 'suiteAct2']) }, options)
              })(), '原版限制：第二幕是可选的；auto 跟随旧 suite 配置。'),
            ], { level: 2 }),

            section('时长与节奏', [
              field('第二幕时长上限 (ms)', h('input', {
                type: 'number', min: 0, max: 120000,
                value: cfg.boot.suiteAct2Ms, onChange: number(['boot', 'suiteAct2Ms']),
              }), '0 = 按模板原长播放，不裁剪；填正数才截断。'),
              field('每步自动停留 (ms)', h('input', {
                type: 'number', min: 0, max: 60000,
                value: cfg.boot.suiteHoldMs, onChange: number(['boot', 'suiteHoldMs']),
              }), '0 = 按 suite 模板原速；填 3000 则每个文字步骤至少停留 3 秒。'),
              field('身份卡停留 (ms)', h('input', {
                type: 'number', min: 0, max: 60000,
                value: cfg.boot.suitePopupMs, onChange: number(['boot', 'suitePopupMs']),
              }), '0 = 按模板；只作用于“身份名称/身份编号/权限等级”确认卡，不影响其他画面。'),
              field('停留时间 (ms)', h('input', {
                type: 'number', min: 0, max: 60000,
                value: cfg.boot.holdMs, onChange: number(['boot', 'holdMs']),
              }), '0 表示片头播完立即交接。'),
              field('淡出时长 (ms)', h('input', {
                type: 'number', min: 200, max: 5000, step: 50,
                value: cfg.boot.fadeMs, onChange: number(['boot', 'fadeMs']),
              }), ''),
              field('硬上限 (ms)', h('input', {
                type: 'number', min: 5000, max: 120000,
                value: cfg.boot.maxMs, onChange: number(['boot', 'maxMs']),
              }), '无论素材是否结束，超过此时长必定交接。'),
            ], { level: 2 }),

            section('素材与交互', [
              field('播放素材', (function () {
                var options = [h('option', { key: 'auto', value: 'auto' }, '随机（每次启动从素材池抽取）')]
                media.clips.forEach(function (item) {
                  options.push(h('option', { key: item.id, value: item.id }, item.name + ' (' + item.id + ')'))
                })
                var known = media.clips.some(function (item) { return item.id === cfg.boot.clip })
                if (cfg.boot.clip !== 'auto' && !known) {
                  options.push(h('option', { key: 'current', value: cfg.boot.clip }, cfg.boot.clip))
                }
                return h('select', { value: cfg.boot.clip, onChange: select(['boot', 'clip']) }, options)
              })(), '默认随机；下方“素材池”可勾选参与随机的素材。'),
              field('触发方式', h('select', {
                value: cfg.boot.trigger,
                onChange: select(['boot', 'trigger']),
              },
              h('option', { value: 'auto' }, '自动播放'),
              h('option', { value: 'click' }, '点击后播放')), ''),
              switchField('点击画面可跳过', cfg.boot.clickToEnter, checkbox(['boot', 'clickToEnter'])),
              switchField('显示跳过提示', cfg.boot.showHint, checkbox(['boot', 'showHint'])),
              field('提示延迟 (ms)', h('input', {
                type: 'number', min: 3000, max: 60000, step: 500,
                value: cfg.boot.hintAfterMs, onChange: number(['boot', 'hintAfterMs']),
              }), ''),
              switchField('片头声音', cfg.boot.sound, checkbox(['boot', 'sound'])),
              sliderField('音量', cfg.boot.volume, ['boot', 'volume']),
            ], { level: 2 }),
          ], { stack: true }),

          section('suite 原版配置（高级）', [
            section('身份与交互', [
              suiteText('身份名称', 'identity', '终幕欢迎语和第二幕身份卡使用。'),
              suiteText('身份编号', 'identityId', ''),
              suiteText('权限等级', 'accessLevel', ''),
              suiteSwitch('需要人工确认', 'requireInteraction'),
              suiteSwitch('允许跳过（SKIP / Esc）', 'allowSkip'),
              suiteSelect('界面音效', 'sfx', [['audio', '真实素材（audio）'], ['synth', '现场合成（synth）']], ''),
              suiteSwitch('背景底噪', 'bedNoise'),
            ], { level: 2 }),
            section('语音与音效', [
              suiteSwitch('启用配音播报', 'voice'),
              suiteSelect('配音语言', 'voiceLang', [['en', '英文'], ['zh', '中文'], ['both', '中英双语']], ''),
              suiteText('配音音色名', 'voiceName', '留空自动挑选。'),
              suiteNumber('语速', 'voiceRate', 0.5, 2, 0.01, '默认 0.88。'),
              suiteNumber('音调', 'voicePitch', 0.5, 2, 0.01, '默认 0.85。'),
              suiteNumber('音量', 'voiceVolume', 0, 1, 0.01, ''),
              suiteSwitch('念台词前轻提示', 'voiceCue'),
              suiteSelect('语音来源', 'voiceSource', [['asset', '真声素材（asset）'], ['tts', 'TTS（tts）']], ''),
              suiteSelect('配音音色包', 'voicePack', [['f', '英文 F（默认）'], ['g', '日文 1'], ['h', '日文 2'], ['i', '日文 3'], ['j', '日文 4'], ['k', '日文 5']], ''),
              suiteSelect('声音效果', 'voiceFx', [['none', '无'], ['ai-mech', 'AI 机械'], ['robot', '机器人'], ['radio', '电台'], ['oldtv', '老电视'], ['dark', '低沉']], ''),
              suiteNumber('提示音后留白 (ms)', 'voiceLead', 0, 2000, 10, ''),
              suiteNumber('终幕欢迎延迟 (ms)', 'welcomeDelay', 0, 3000, 10, ''),
            ], { level: 2 }),
            section('背景音乐（用户自备）', [
              suiteSwitch('启用背景音乐', 'bgmEnabled'),
              suiteSwitch('整体循环', 'bgmLoop'),
              suiteText('主音乐文件名', 'bgmFile', '放在 ~/.dsh/startup-music。'),
              suiteText('第二段换曲', 'bgmFile2', '留空表示同一首。'),
              suiteNumber('音乐音量', 'bgmVolume', 0, 1, 0.01, ''),
              suiteNumber('拍速 BPM', 'bgmBpm', 30, 240, 1, ''),
              suiteNumber('第一段拍数', 'bgmBeats1', 1, 256, 1, ''),
              suiteNumber('第二段拍数', 'bgmBeats2', 1, 256, 1, ''),
              suiteNumber('第一段起点 (s)', 'bgm1Start', 0, 600, 0.1, ''),
              suiteNumber('第二段起点 (s)', 'bgm2Start', 0, 600, 0.1, ''),
              suiteNumber('第一段淡入 (s)', 'bgm1FadeIn', 0, 10, 0.1, ''),
              suiteNumber('第一段淡出 (s)', 'bgm1FadeOut', 0, 10, 0.1, ''),
              suiteNumber('第二段淡入 (s)', 'bgm2FadeIn', 0, 10, 0.1, ''),
              suiteNumber('第二段淡出 (s)', 'bgm2FadeOut', 0, 10, 0.1, ''),
              suiteNumber('两段交叉 (ms)', 'bgmCrossfade', 0, 10000, 50, ''),
              suiteSwitch('第二段循环', 'bgm2Loop'),
              suiteSwitch('配音时自动闪避', 'bgmDuck'),
            ], { level: 2 }),
            section('转场与视觉', [
              suiteSelect('主题', 'theme', [['light', '浅色'], ['dark', '深色']], ''),
              suiteNumber('速度倍率', 'speed', 0.35, 3, 0.05, ''),
              suiteSelect('第一幕入场', 'transitionIn', [['dissolve', '叠化'], ['flash', '闪白'], ['glitch', '故障'], ['scanline', '扫描线'], ['slide', '滑动'], ['iris', '光圈'], ['black', '黑场'], ['none', '无']], ''),
              suiteSelect('两幕衔接', 'transitionJoin', [['dissolve', '叠化'], ['flash', '闪白'], ['glitch', '故障'], ['scanline', '扫描线'], ['slide', '滑动'], ['iris', '光圈'], ['black', '黑场'], ['none', '无']], ''),
              suiteSelect('第二幕退场', 'transitionOut', [['dissolve', '叠化'], ['flash', '闪白'], ['glitch', '故障'], ['scanline', '扫描线'], ['slide', '滑动'], ['iris', '光圈'], ['black', '黑场'], ['none', '无']], ''),
              suiteNumber('转场时长 (ms)', 'transitionMs', 0, 5000, 10, ''),
              suiteSelect('转场方向', 'transitionDir', [['left', '左'], ['right', '右'], ['up', '上'], ['down', '下']], ''),
              suiteColor('主强调色', 'accent', '显示为中文颜色名；保存的仍是 suite 需要的色值。'),
              suiteColor('故障色 A', 'glitchA', ''),
              suiteColor('故障色 B', 'glitchB', ''),
              suiteSwitch('第一幕视频原声', 'act1VideoSound'),
              suiteSwitch('第二幕视频原声', 'act2VideoSound'),
            ], { level: 2 }),
            section('品牌与终幕文案', [
              suiteText('品牌 1', 'brand1', ''),
              suiteText('品牌 2', 'brand2', ''),
              suiteText('品牌 3A', 'brand3a', ''),
              suiteText('品牌 3B', 'brand3b', ''),
              suiteText('组织中文', 'orgZh', ''),
              suiteText('组织英文', 'orgEn', ''),
              suiteText('组织副标题', 'orgSub', ''),
              suiteText('欢迎框', 'welcomeBox', ''),
              suiteText('页脚', 'footer', ''),
            ], { level: 2 }),
            section('大肥鱼模板专属', [
              suiteText('连接用户名', 'bigfishUsername', ''),
              suiteText('提示标题', 'bigfishTitle', ''),
              suiteText('提示正文', 'bigfishDesc', ''),
              suiteSwitch('强制掉线彩蛋', 'bigfishForceEgg'),
              suiteSelect('模板内配音效果', 'bigfishVoiceFx', [['none', '无'], ['ai-mech', 'AI 机械'], ['robot', '机器人'], ['radio', '电台'], ['oldtv', '老电视'], ['dark', '低沉']], ''),
              suiteNumber('模板内配音音量 (0-100)', 'bigfishVoiceVolume', 0, 100, 1, ''),
            ], { level: 2 }),
            h('p', {
              className: 'dbn-cfg-note dbn-cfg-span',
              key: 'suite-note',
            }, '这些字段写入 nexus 配置的 extensions.suite，并覆盖 dsh-startup.json 的同名键；旧 suite 配置文件不会被改写。'),
          ], { stack: true }),

          section('屏保', [
            switchField('启用屏保', cfg.saver.enabled, checkbox(['saver', 'enabled'])),
            field('空闲触发 (ms)', h('input', {
              type: 'number', min: 30000, max: 3600000, step: 1000,
              value: cfg.saver.idleMs, onChange: number(['saver', 'idleMs']),
            }), ''),
            field('轮换间隔 (ms)', h('input', {
              type: 'number', min: 0, max: 600000,
              value: cfg.saver.rotateMs, onChange: number(['saver', 'rotateMs']),
            }), '0 表示不轮换。'),
            field('指定素材', h('input', {
              value: cfg.saver.pool,
              placeholder: 'auto 或 saver-1',
              onChange: function (event) { update(['saver', 'pool'], event.target.value) },
            }), ''),
            switchField('显示退出提示', cfg.saver.hint, checkbox(['saver', 'hint'])),
            switchField('点击破屏', cfg.saver.breakEffect, checkbox(['saver', 'breakEffect'])),
            field('破屏风格', h('select', {
              value: cfg.saver.breakStyle, onChange: select(['saver', 'breakStyle']),
            },
            h('option', { value: 'random' }, '随机'),
            h('option', { value: 'particles' }, '粒子'),
            h('option', { value: 'fall' }, '坠落'),
            h('option', { value: 'glitch' }, '故障')), ''),
            switchField('屏保声音', cfg.saver.sound, checkbox(['saver', 'sound'])),
            sliderField('音量', cfg.saver.volume, ['saver', 'volume']),
          ]),

          section('素材池', [
            h('p', { className: 'dbn-cfg-note dbn-cfg-span', key: 'media-note' },
              '片头：' + media.clips.length + ' 个；屏保：' + media.savers.length + ' 个。取消勾选即禁用该素材。'),
            paths.media
              ? h('p', { className: 'dbn-cfg-path dbn-cfg-span', key: 'path-media' }, '素材目录：' + paths.media)
              : null,
            paths.suite
              ? h('p', { className: 'dbn-cfg-path dbn-cfg-span', key: 'path-suite' }, 'suite 引擎目录：' + paths.suite)
              : null,
            h('h5', { className: 'dbn-cfg-mini dbn-cfg-span', key: 'mini-clips' }, '片头素材'),
            mediaList('disabledClips', media.clips),
            h('h5', { className: 'dbn-cfg-mini dbn-cfg-span', key: 'mini-savers' }, '屏保素材'),
            mediaList('disabledSavers', media.savers),
          ], { stack: true }),

          section('高级', [
            switchField('诊断日志', cfg.advanced.diag, checkbox(['advanced', 'diag'])),
            switchField('启动追踪', cfg.advanced.trace, checkbox(['advanced', 'trace'])),
            field('减少动态效果', h('select', {
              value: cfg.boot.reducedMotion, onChange: select(['boot', 'reducedMotion']),
            },
            h('option', { value: 'auto' }, '跟随系统'),
            h('option', { value: 'on' }, '强制开启'),
            h('option', { value: 'off' }, '强制关闭')), ''),
          ])
        ) : null))
    }

    function BootNexusSummary(props) {
      var text = '开机动画、随机素材、声音与屏保'
      var runtime = props && props.runtime
      if (!runtime || typeof runtime.createElement !== 'function') return text
      var h = runtime.createElement
      /*
       * The card's leading square is owned by DSH's plugin manager and is
       * hard-coded per registration id. This small mark lives in the summary
       * slot instead, so it travels with the plugin bundle and survives
       * upgrades and installs on another machine.
       */
      return h('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          minWidth: 0,
          maxWidth: '100%',
        },
      }, h('img', {
        src: '/dsh-boot-nexus/icon/icon-64.png',
        alt: '',
        width: 18,
        height: 18,
        style: {
          width: '18px',
          height: '18px',
          borderRadius: '4px',
          objectFit: 'cover',
          flex: '0 0 auto',
        },
      }), h('span', {
        style: {
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        },
      }, text))
    }

    /*
     * A throw while rendering the card used to take the whole plugin detail
     * view down with it. Catch it at the slot boundary and leave a readable,
     * still-themed card behind. React.Component is optional so the summary
     * slot and the offline render harness keep working without it.
     */
    var CardBoundary = null
    try {
      if (React && typeof React.Component === 'function') {
        CardBoundary = class extends React.Component {
          constructor(props) {
            super(props)
            this.state = { failed: false, message: '' }
          }
          static getDerivedStateFromError(error) {
            return { failed: true, message: String((error && error.message) || error || '未知错误') }
          }
          render() {
            if (!this.state.failed) return this.props.children
            return React.createElement('div', {
              className: 'dbn-cfg-fallback',
              role: 'alert',
              style: {
                marginTop: 8,
                padding: '14px 16px',
                border: '1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, .16))',
                borderRadius: 'var(--dsw-radius-lg, 16px)',
                background: 'var(--dsw-alias-bg-layer-1, rgba(22, 23, 26, .96))',
                color: 'var(--dsw-alias-label-primary, #f3f4f6)',
                fontSize: 13,
                lineHeight: '20px',
              },
            },
            React.createElement('strong', null, '开机动画配置卡片渲染失败'),
            React.createElement('p', {
              style: { margin: '6px 0 0', color: 'var(--dsw-alias-label-secondary, #b7bdc6)' },
            }, this.state.message + '。插件本身仍然生效，重新加载页面即可重试。'))
          }
        }
      }
    } catch (error) { CardBoundary = null }

    function BootNexusEntry(props) {
      var runtime = props && props.runtime
      var view = props && props.view
      var component = view === 'summary' ? BootNexusSummary : BootNexusCard
      if (runtime && typeof runtime.createElement === 'function') {
        var element = runtime.createElement(component, props)
        if (view === 'summary' || !CardBoundary) return element
        return runtime.createElement(CardBoundary, null, element)
      }
      if (view === 'summary') return BootNexusSummary()
      return BootNexusCard(props)
    }

    function registerCard(ctx) {
      if (!React || typeof React.createElement !== 'function') return
      if (!ctx || typeof ctx.inject !== 'function') return
      /*
       * A client bundle can be evaluated more than once during an HMR reload,
       * and ctx.inject may call back once per owner. A registration owned by a
       * previous callback survives in the slot, so two identical cards appear
       * side by side. One page-wide owner is the only reliable guard.
       */
      try {
        var previous = window[CARD_KEY]
        if (previous && typeof previous.dispose === 'function') previous.dispose()
      } catch (error) { /* a broken previous card must not block this one */ }
      try { window[CARD_KEY] = null } catch (error) { /* no window */ }

      ctx.inject(['slots'], function (owner) {
        try {
          var slots = null
          try { slots = owner.get('slots') } catch (error) { slots = owner.slots }
          if (!slots && owner.slots) slots = owner.slots
          if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

          var registration = null
          function contribute() {
            if (registration !== null) return
            try { if (window[CARD_KEY]) return } catch (error) { /* no window */ }
            try {
              registration = slots.inject(SLOT, function () {
                return slots.register({
                  name: SLOT,
                  id: ENTRY_ID,
                  order: 26,
                  label: function () { return '开机动画' },
                  inject: function () { return { runtime: React } },
                }, BootNexusEntry)
              })
              try { window[CARD_KEY] = { dispose: withdraw } } catch (error) { /* no window */ }
            } catch (error) {
              registration = null
              console.warn('boot-nexus: settings card not registered', error)
            }
          }
          function withdraw() {
            if (registration === null) return
            var dispose = registration
            registration = null
            try {
              if (window[CARD_KEY] && window[CARD_KEY].dispose === withdraw) window[CARD_KEY] = null
            } catch (error) { /* no window */ }
            try { if (typeof dispose === 'function') dispose() } catch (error) {
              console.warn('boot-nexus: settings card not withdrawn', error)
            }
          }
          if (typeof owner.effect === 'function') {
            owner.effect(function () { contribute(); return withdraw }, 'boot-nexus: settings card')
          } else {
            contribute()
          }
        } catch (error) {
          console.warn('boot-nexus: settings card wiring failed', error)
        }
      })
    }

    exports.apply = function apply(ctx) {
      announce()
      try { window.setTimeout(function () { probe('after-800ms') }, 800) } catch (error) { /* no timer */ }
      try {
        registerCard(ctx)
      } catch (error) {
        console.warn('boot-nexus: client half failed', error)
      }
    }

    exports.name = 'dsh-boot-nexus'

    return module.exports
  },
})
