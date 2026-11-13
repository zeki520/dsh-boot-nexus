/**
 * Names that cross the Host / browser / test seams.
 *
 * Anything a second module has to spell correctly lives here. The browser
 * runtime cannot import this file (it ships as one inline script), so the
 * runtime's copy in `src/runtime/00-constants.js` must be kept byte-identical
 * for these values; `test/rows.test.mjs` asserts the two string sets agree.
 */

export const PLUGIN_NAME = 'dsh-boot-nexus'
export const PLUGIN_VERSION = '0.5.3'

/** The one settings namespace and route root. Both equal the patch id. */
export const NAMESPACE = 'boot-nexus'
export const ROUTE_BASE = '/dsh-boot-nexus'

/** Root node / global names. */
export const ROOT_ID = 'dbn-root'
export const GLOBAL_API = '__BOOT_NEXUS__'
export const GLOBAL_PLAN = '__DBN_PLAN__'
export const GLOBAL_VERSION = '__DBN_VERSION__'
export const GLOBAL_INTERNALS = '__DBN_INTERNALS__'

/**
 * The only z-index the plugin owns.
 *
 * Legacy suite used 2147483000, legacy animation used 2147483647. Nexus keeps
 * the lower one: the native file picker, devtools and OS overlays are above it,
 * and there is no second full-screen layer to out-rank any more.
 */
export const Z_ROOT = 2147483000

/** Browser phases, mirrored by the runtime's `data-phase`. */
export const PHASES = Object.freeze({
  OFF: 'off',
  ARMING: 'arming',
  PLAYING: 'playing',
  HANDOFF: 'handoff',
  SAVER: 'saver',
})

/** Stable ids used by the diagnostics HUD and the tests. */
export const IDS = Object.freeze({
  ROOT: ROOT_ID,
  STAGE: 'dbn-stage',
  VEIL: 'dbn-veil',
  CHROME: 'dbn-chrome',
  SAVER: 'dbn-saver',
  DIAG: 'dbn-diag',
  CAPTION: 'dbn-caption',
  SKIP: 'dbn-skip',
})

/** Services the Host half consumes. The union is deliberate — see DESIGN.md §3.4. */
export const INJECT = Object.freeze(['webServer', 'connection'])

/** Legacy sentinels Nexus refuses to race with. */
export const LEGACY_SENTINELS = Object.freeze([
  '__DSH_STARTUP_BOOT__',
  '__DSH_STARTUP_VERSION__',
  '__DSH_STARTUP__',
  'dsh-startup-root',
  '/dsh-startup/splash.js',
  '__DSH_BOOT_ANIM__',
  'dshba',
])
