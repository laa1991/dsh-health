// spec.test.mjs — where declarations come from and what makes one valid.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { resolveConfig, validateReadings, loadSpec, DEFAULT_DATA_DIR, DEFAULT_SPEC_FILE, BUILTIN_SPEC } from '../src/spec.js'

async function fixtureDir() {
  return await mkdtemp(path.join(tmpdir(), 'hr-spec-'))
}

test('resolveConfig: config beats env beats the built-in default', () => {
  const env = { DSH_HEALTH_READOUT_DATA_DIR: '/from-env', DSH_HEALTH_READOUT_SPEC: 'env.json' }
  const fromConfig = resolveConfig({ dataDir: '/from-config', specFile: 'conf.json' }, env)
  assert.equal(fromConfig.dataDir, '/from-config')
  assert.equal(fromConfig.specPath, path.join('/from-config', 'conf.json'))

  const fromEnv = resolveConfig({}, env)
  assert.equal(fromEnv.dataDir, '/from-env')
  assert.equal(fromEnv.specPath, path.join('/from-env', 'env.json'))

  const fallback = resolveConfig({}, {})
  assert.equal(fallback.dataDir, DEFAULT_DATA_DIR)
  assert.equal(fallback.specFile, DEFAULT_SPEC_FILE)
  assert.equal(fallback.specPath, path.join(DEFAULT_DATA_DIR, DEFAULT_SPEC_FILE))
  // Segment-aware on purpose: `~/.dsh-health-readout` shares the *string*
  // prefix `~/.dsh` with the platform directory, so a naive `startsWith` fires
  // on the correct value and therefore has to be loosened until it never fires
  // at all. This one is measured, not trimmed: with `DEFAULT_DATA_DIR` mutated
  // to `~/.dsh/health-readout` it goes red; with the real value it stays green.
  const rel = path.relative(homedir(), fallback.dataDir)
  assert.ok(
    rel !== '.dsh' && !rel.startsWith('.dsh' + path.sep),
    `the default data dir must not sit inside the DSH platform dir (~/.dsh); got ${rel}`,
  )
})

test('resolveConfig: `only` accepts an array or a comma-separated string', () => {
  assert.deepEqual(resolveConfig({ only: ['a', 'b'] }, {}).only, ['a', 'b'])
  assert.deepEqual(resolveConfig({ only: 'a, b ,c' }, {}).only, ['a', 'b', 'c'])
  assert.deepEqual(resolveConfig({}, { DSH_HEALTH_READOUT_ONLY: 'x' }).only, ['x'])
  assert.deepEqual(resolveConfig({}, {}).only, [])
})

test('resolveConfig names the config keys it does not know', () => {
  // The loader passes config through unvalidated for a schema-less plugin
  // (cordis fiber.resolveConfig: `if (!runtime.Config) return config`), so the
  // plugin itself is the only thing that can point a typo out.
  const res = resolveConfig({ dataDir: '/d', dataDirr: 'typo', spec: 'x' }, {})
  assert.deepEqual(res.unknownKeys, ['dataDirr', 'spec'])
  assert.deepEqual(resolveConfig({ dataDir: '/d' }, {}).unknownKeys, [])
  assert.deepEqual(resolveConfig({}, {}).unknownKeys, [])
})

test('resolveConfig: an absolute specFile is used as-is', () => {
  const abs = path.join(tmpdir(), 'elsewhere.json')
  assert.equal(resolveConfig({ dataDir: '/d', specFile: abs }, {}).specPath, abs)
})

test('validateReadings accepts a well-formed reading', () => {
  const res = validateReadings([
    {
      id: 'heartbeat',
      title: 'Heartbeat',
      source: { kind: 'file-age-seconds', path: 'heartbeat.json' },
      healthy: { op: 'lt', value: 600 },
      blind: 'says nothing about the writer',
    },
  ])
  assert.equal(res.ok, true, JSON.stringify(res.errors))
  assert.equal(res.warnings.length, 0)
})

test('validateReadings: a missing blind spot is an ERROR, not a warning', () => {
  const res = validateReadings([
    { id: 'x', source: { kind: 'file-exists', path: 'a' }, healthy: { op: 'exists' } },
  ])
  assert.equal(res.ok, false)
  assert.ok(res.errors.some((e) => /blind/.test(e)), JSON.stringify(res.errors))
})

test('validateReadings: duplicate ids, unknown ops and bad states are errors; an unknown kind is only a warning', () => {
  const dup = validateReadings([
    { id: 'same', source: { kind: 'file-exists', path: 'a' }, healthy: { op: 'exists' }, blind: 'b' },
    { id: 'same', source: { kind: 'file-exists', path: 'b' }, healthy: { op: 'exists' }, blind: 'b' },
  ])
  assert.ok(dup.errors.some((e) => /duplicate id/.test(e)))

  const badOp = validateReadings([{ id: 'x', source: { kind: 'file-exists', path: 'a' }, healthy: { op: 'nope' }, blind: 'b' }])
  assert.ok(badOp.errors.some((e) => /unknown op/.test(e)))

  const badState = validateReadings([
    { id: 'x', source: { kind: 'file-exists', path: 'a' }, healthy: { op: 'exists', bad: 'on-fire' }, blind: 'b' },
  ])
  assert.ok(badState.errors.some((e) => /`bad` must be one of/.test(e)))

  const unknownKind = validateReadings([
    { id: 'x', source: { kind: 'telepathy' }, healthy: { op: 'exists' }, blind: 'b' },
  ])
  assert.equal(unknownKind.ok, true)
  assert.ok(unknownKind.warnings.some((w) => /unknown source kind/.test(w)))
})

test('validateReadings: a non-array is rejected outright', () => {
  const res = validateReadings({ nope: true })
  assert.equal(res.ok, false)
  assert.match(res.errors[0], /must be an array/)
})

test('loadSpec: an unreadable spec falls back to the starter AND says so', async () => {
  const dir = await fixtureDir()
  const res = await loadSpec(resolveConfig({ dataDir: dir, specFile: 'missing.json' }, {}))
  assert.equal(res.specSource, 'builtin')
  assert.ok(res.warnings.some((w) => /not loaded from/.test(w)), JSON.stringify(res.warnings))
  assert.equal(res.readings.length, BUILTIN_SPEC.readings.length)
})

test('loadSpec: a readable spec is used as-is and reports its path', async () => {
  const dir = await fixtureDir()
  const specPath = path.join(dir, 'readings.json')
  await writeFile(specPath, JSON.stringify({
    version: 1,
    readings: [
      { id: 'a', title: 'A', source: { kind: 'file-exists', path: 'a' }, healthy: { op: 'exists' }, blind: 'b' },
    ],
  }), 'utf8')
  const res = await loadSpec(resolveConfig({ dataDir: dir }, {}))
  assert.equal(res.specSource, specPath)
  assert.equal(res.readings.length, 1)
  assert.equal(res.specVersion, 1)
})

test('loadSpec: zero readings is a warning, never a silent pass', async () => {
  const dir = await fixtureDir()
  await writeFile(path.join(dir, 'readings.json'), JSON.stringify({ readings: [] }), 'utf8')
  const res = await loadSpec(resolveConfig({ dataDir: dir }, {}))
  assert.equal(res.readings.length, 0)
  assert.ok(res.warnings.some((w) => /zero readings/.test(w)), JSON.stringify(res.warnings))
})

test('the shipped bundle patch keeps its data dir out of the DSH platform dir', async () => {
  // `cordis.patch.yml` is the surface a real install gets: it passes `dataDir`
  // explicitly, so for anyone who installs the bundle this value — not
  // DEFAULT_DATA_DIR — decides where readings live. Both are checked, the same
  // segment-aware way. Mutation check: `~/.dsh/health` in the patch goes red.
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const all = [...patch.matchAll(/^\s*dataDir:\s*(\S+)\s*$/gm)]
  assert.equal(all.length, 1, `cordis.patch.yml must declare exactly one dataDir, found ${all.length}`)
  const declared = all[0][1]
  assert.ok(declared.startsWith('~/'), `dataDir must be home-relative, got ${declared}`)
  const rel = declared.slice(2)
  assert.ok(
    rel !== '.dsh' && !rel.startsWith('.dsh/') && !rel.startsWith('.dsh\\'),
    `the shipped dataDir must not sit inside the DSH platform dir (~/.dsh); got ${declared}`,
  )
})
