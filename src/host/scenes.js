import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCENE_ROOT = join(HERE, '..', '..', 'assets', 'scenes')
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

/**
 * A scene is a small, host-owned description of one suite act. The runtime never
 * reads template files itself: the host resolves the allowlist and sends only
 * the fields the renderer needs. That keeps the browser side free of path
 * handling and keeps a user-supplied template from naming arbitrary files.
 */
export function loadScene(id) {
  if (!ID_RE.test(String(id || ''))) return null
  let raw
  try { raw = JSON.parse(readFileSync(join(SCENE_ROOT, `${id}.json`), 'utf8')) } catch { return null }
  if (!raw || !Array.isArray(raw.steps) || !raw.steps.length) return null
  return {
    id: raw.id || id,
    name: String(raw.name || id),
    theme: raw.theme && typeof raw.theme === 'object' ? {
      accent: String(raw.theme.accent || ''),
      glitchA: String(raw.theme.glitchA || ''),
      glitchB: String(raw.theme.glitchB || ''),
      mode: String(raw.theme.mode || ''),
    } : {},
    steps: raw.steps.slice(0, 12).map((step) => ({
      zh: String(step.zh || ''),
      en: String(step.en || ''),
      log: String(step.log || ''),
      logEn: String(step.logEn || ''),
      badge: String(step.badge || ''),
      action: String(step.action || 'auto'),
      hold: Math.max(0, Math.min(10000, Number(step.hold) || 0)),
      progress: Math.max(0, Math.min(1, Number(step.progress) || 0)),
    })),
  }
}

export function listScenes() {
  try {
    return readdirSync(SCENE_ROOT)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5))
      .filter((id) => ID_RE.test(id))
      .sort()
  } catch {
    return []
  }
}

export const SCENES_DIR = SCENE_ROOT
