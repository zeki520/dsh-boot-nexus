/**
 * The critical CSS that must be in the document before anything else runs.
 *
 * Budget: under 3 KiB. It only paints the black veil, the mount point and the
 * chrome; the clip, the saver and the wallpapers are styled by the media
 * element itself and by tokens inherited from the app. Keeping it small matters
 * because this row is inlined into every index response.
 *
 * No `!important` anywhere. The legacy plugins used it to win a three-way fight
 * over the same caption node; Nexus owns the node, so there is nobody to fight.
 */
export const CRITICAL_CSS = `
#dbn-root{position:fixed;inset:0;z-index:2147483000;background:#000;color:var(--dsw-alias-text-primary,#fff);display:none;overflow:hidden;contain:layout paint style;font-family:var(--dsw-alias-font-family,system-ui,sans-serif);-webkit-font-smoothing:antialiased}
#dbn-root[data-phase="arming"],#dbn-root[data-phase="playing"],#dbn-root[data-phase="handoff"],#dbn-root[data-phase="saver"]{display:block}
#dbn-root[data-phase="off"]{display:none}
html.dbn-lock,html.dbn-lock body{overflow:hidden}
#dbn-stage,#dbn-veil,#dbn-chrome,#dbn-saver,#dbn-diag{position:absolute;inset:0}
#dbn-stage{z-index:1;background:#000}
#dbn-stage video,#dbn-stage img,#dbn-stage canvas{width:100%;height:100%;object-fit:cover;display:block}
#dbn-veil{z-index:2;pointer-events:none;background:radial-gradient(ellipse at 50% 45%,transparent 0%,rgba(0,0,0,.18) 55%,rgba(0,0,0,.55) 100%)}
#dbn-chrome{z-index:4;display:flex;align-items:flex-end;justify-content:space-between;padding:clamp(16px,3vw,40px);pointer-events:none}
#dbn-caption{font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.72;text-shadow:0 1px 8px rgba(0,0,0,.8)}
#dbn-skip{pointer-events:auto;appearance:none;border:1px solid rgba(255,255,255,.34);border-radius:999px;background:rgba(0,0,0,.28);color:inherit;font:inherit;font-size:13px;padding:8px 16px;cursor:pointer;opacity:0;transition:opacity .35s ease}
#dbn-root[data-hint="1"] #dbn-skip{opacity:1}
#dbn-skip:focus-visible{outline:2px solid var(--dsw-alias-accent-primary,#7aa2ff);outline-offset:3px}
#dbn-saver{z-index:3;display:none;background:#000}
#dbn-root[data-phase="saver"] #dbn-saver{display:block}
#dbn-saver video,#dbn-saver img,#dbn-saver canvas{width:100%;height:100%;object-fit:cover;display:block}
#dbn-diag{z-index:5;display:none;align-items:flex-start;justify-content:flex-end;padding:16px;pointer-events:none;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;color:#9fe8b0;text-shadow:0 1px 4px #000}
#dbn-root[data-diag="1"] #dbn-diag{display:flex}
@media (prefers-reduced-motion:reduce){#dbn-skip{transition:none}}
`.trim()
