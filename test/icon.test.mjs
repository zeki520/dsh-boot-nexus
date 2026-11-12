import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoutes } from '../src/host/routes.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('the package icon is a PNG inside the 256 KiB host limit', () => {
  assert.equal(typeof pkg.icon, 'string')
  const file = join(root, pkg.icon)
  assert.ok(existsSync(file), `missing ${pkg.icon}`)
  const bytes = readFileSync(file)
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.ok(bytes.length <= 256 * 1024, `icon is ${bytes.length} bytes`)
  assert.equal(pkg.exports['./icon'], './' + pkg.icon.replace(/\\/g, '/'))
})

test('all three provided sizes are shipped and ordered', () => {
  const sizes = [64, 128, 256]
  for (const size of sizes) {
    const file = join(root, 'assets', 'icon', `icon-${size}.png`)
    assert.ok(existsSync(file), `missing ${size}px icon`)
    const info = readFileSync(file)
    assert.equal(info.readUInt32BE(16), size)
    assert.equal(info.readUInt32BE(20), size)
  }
  assert.ok(statSync(join(root, 'assets', 'icon', 'icon-256.png')).size > statSync(join(root, 'assets', 'icon', 'icon-128.png')).size)
})

test('the settings card draws the small icon from its own route', () => {
  const client = readFileSync(join(root, 'src', 'client', 'index.js'), 'utf8')
  assert.match(client, /\/dsh-boot-nexus\/icon\/icon-64\.png/)
  const routes = createRoutes({
    getPlan: () => ({ enabled: true }),
    mediaPlan: { clips: [], savers: [] },
    runtime: 'x',
    version: 'test',
    trust: () => null,
    iconPng: Buffer.from('png'),
  })
  assert.ok(routes.some((route) => route.path === '/dsh-boot-nexus/icon/icon-64.png'))
})

test('the summary view carries the icon beside its one-liner', () => {
  const client = readFileSync(join(root, 'src', 'client', 'index.js'), 'utf8')
  assert.match(client, /function BootNexusSummary\(props\)/)
  assert.match(client, /开机动画、随机素材、声音与屏保/)
  assert.match(client, /\/dsh-boot-nexus\/icon\/icon-64\.png/)
  assert.match(client, /width: '18px'/)
  assert.match(client, /textOverflow: 'ellipsis'/)
})
