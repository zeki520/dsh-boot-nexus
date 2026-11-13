import fsp from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Marker written inside the media root once the bundled defaults have been
 * looked at. Names that appear in it are never seeded again, so a user who
 * deletes a clip keeps it deleted across upgrades.
 */
export const SEED_MARKER = '.bundled-media.json'

/**
 * Copy the media that ships inside the package into the user's media root.
 *
 * The pools are ordinary directories (`clips/`, `savers/`) that the settings
 * card edits, so seeding them — instead of serving straight out of the
 * package — keeps one code path for scanning, range requests and the card.
 *
 * @param {{bundleDir: string, mediaRoot: string, pools?: string[],
 *          fs?: typeof fsp, log?: (line: string) => void}} input
 * @returns {Promise<{copied: string[], present: number, skipped: number}>}
 */
export async function seedBundledMedia({
  bundleDir,
  mediaRoot,
  pools = ['clips', 'savers'],
  fs = fsp,
  log = () => {},
} = {}) {
  if (!bundleDir || !mediaRoot) return { copied: [], present: 0, skipped: 0 }

  let recorded = new Set()
  try {
    const raw = await fs.readFile(join(mediaRoot, SEED_MARKER), 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed?.files)) recorded = new Set(parsed.files.map(String))
  } catch {
    /* no marker yet, or it is unreadable — seed what is missing */
  }

  const copied = []
  let present = 0
  let skipped = 0

  for (const pool of pools) {
    let names
    try {
      names = await fs.readdir(join(bundleDir, pool))
    } catch {
      continue
    }
    for (const name of names.sort()) {
      if (!name || name.startsWith('.')) continue
      const key = `${pool}/${name}`
      if (recorded.has(key)) {
        try {
          await fs.stat(join(mediaRoot, pool, name))
          present += 1
        } catch {
          /* the user deleted it on purpose; the marker keeps it deleted */
        }
        continue
      }
      const dest = join(mediaRoot, pool, name)
      try {
        await fs.stat(dest)
        recorded.add(key)
        present += 1
        continue
      } catch {
        /* not there yet */
      }
      try {
        await fs.mkdir(join(mediaRoot, pool), { recursive: true })
        await fs.copyFile(join(bundleDir, pool, name), dest)
        recorded.add(key)
        copied.push(key)
      } catch (error) {
        skipped += 1
        log(`media seed: ${key} skipped (${error && error.message ? error.message : error})`)
      }
    }
  }

  try {
    const next = JSON.stringify({ files: [...recorded].sort() }, null, 2)
    await fs.writeFile(join(mediaRoot, SEED_MARKER), `${next}\n`)
  } catch {
    /* a read-only media root is not fatal: the pools simply stay as they are */
  }

  if (copied.length) log(`media seed: copied ${copied.length} bundled files into ${mediaRoot}`)
  return { copied, present, skipped }
}
