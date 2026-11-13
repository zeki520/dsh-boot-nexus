import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedBundledMedia, SEED_MARKER } from '../src/host/seed.js'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dbn-seed-'))
}

async function makeBundle() {
  const bundleDir = tempRoot()
  await fsp.mkdir(join(bundleDir, 'clips'), { recursive: true })
  await fsp.mkdir(join(bundleDir, 'savers'), { recursive: true })
  await fsp.writeFile(join(bundleDir, 'clips', 'a.mp4'), 'clip-a')
  await fsp.writeFile(join(bundleDir, 'clips', 'b.mp4'), 'clip-b')
  await fsp.writeFile(join(bundleDir, 'savers', 's.mp4'), 'saver-s')
  await fsp.writeFile(join(bundleDir, 'clips', '.DS_Store'), 'junk')
  return bundleDir
}

test('a first run copies every bundled file and records it', async () => {
  const bundleDir = await makeBundle()
  const mediaRoot = tempRoot()
  const result = await seedBundledMedia({ bundleDir, mediaRoot })

  assert.deepEqual(result.copied.sort(), ['clips/a.mp4', 'clips/b.mp4', 'savers/s.mp4'])
  assert.equal(await fsp.readFile(join(mediaRoot, 'clips', 'a.mp4'), 'utf8'), 'clip-a')
  assert.equal(await fsp.readFile(join(mediaRoot, 'savers', 's.mp4'), 'utf8'), 'saver-s')

  const marker = JSON.parse(await fsp.readFile(join(mediaRoot, SEED_MARKER), 'utf8'))
  assert.deepEqual(marker.files.sort(), ['clips/a.mp4', 'clips/b.mp4', 'savers/s.mp4'])
})

test('dotfiles are never seeded', async () => {
  const bundleDir = await makeBundle()
  const mediaRoot = tempRoot()
  await seedBundledMedia({ bundleDir, mediaRoot })
  await assert.rejects(fsp.stat(join(mediaRoot, 'clips', '.DS_Store')))
})

test('a second run copies nothing', async () => {
  const bundleDir = await makeBundle()
  const mediaRoot = tempRoot()
  await seedBundledMedia({ bundleDir, mediaRoot })
  const again = await seedBundledMedia({ bundleDir, mediaRoot })
  assert.deepEqual(again.copied, [])
  assert.equal(again.present, 3)
})

test('a file the user deleted is not resurrected', async () => {
  const bundleDir = await makeBundle()
  const mediaRoot = tempRoot()
  await seedBundledMedia({ bundleDir, mediaRoot })
  await fsp.rm(join(mediaRoot, 'clips', 'a.mp4'))
  const again = await seedBundledMedia({ bundleDir, mediaRoot })
  assert.deepEqual(again.copied, [])
  await assert.rejects(fsp.stat(join(mediaRoot, 'clips', 'a.mp4')))
})

test('a user file with the same name is left alone', async () => {
  const bundleDir = await makeBundle()
  const mediaRoot = tempRoot()
  await fsp.mkdir(join(mediaRoot, 'clips'), { recursive: true })
  await fsp.writeFile(join(mediaRoot, 'clips', 'a.mp4'), 'mine')
  const result = await seedBundledMedia({ bundleDir, mediaRoot })
  assert.equal(await fsp.readFile(join(mediaRoot, 'clips', 'a.mp4'), 'utf8'), 'mine')
  assert.deepEqual(result.copied.sort(), ['clips/b.mp4', 'savers/s.mp4'])
})

test('a missing bundle directory is not an error', async () => {
  const mediaRoot = tempRoot()
  const result = await seedBundledMedia({ bundleDir: join(mediaRoot, 'nope'), mediaRoot })
  assert.deepEqual(result.copied, [])
})
