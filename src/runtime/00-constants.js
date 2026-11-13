/*
 * Runtime constants. This file is concatenated into the single inline script
 * served from /dsh-boot-nexus/boot.js, so it cannot use ESM imports. Keep the
 * values in sync with src/shared/constants.js; test/rows.test.mjs compares them.
 */
var DBN = {
  VERSION: '0.5.3',
  ROOT_ID: 'dbn-root',
  STAGE_ID: 'dbn-stage',
  VEIL_ID: 'dbn-veil',
  CHROME_ID: 'dbn-chrome',
  SAVER_ID: 'dbn-saver',
  DIAG_ID: 'dbn-diag',
  CAPTION_ID: 'dbn-caption',
  SKIP_ID: 'dbn-skip',
  Z_ROOT: 2147483000,
  ROUTE_BASE: '/dsh-boot-nexus',
  STORAGE_SESSION: 'dbn:played',
  STORAGE_DAY: 'dbn:lastDay',
  PHASE: {
    OFF: 'off',
    ARMING: 'arming',
    PLAYING: 'playing',
    HANDOFF: 'handoff',
    SAVER: 'saver'
  }
}
