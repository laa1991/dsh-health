// readout.test.mjs — end to end through the evaluator, with no dsh host.
//
// The two arms that matter:
//   negative control — delete the thing being watched; the verdict must become
//     `unknown`, and must NOT stay `ok` and must NOT be quietly zeroed.
//   fire — trip a criterion; the verdict must move to that reading's bad state.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readout, renderReadout } from '../src/readout.js'

const SPEC = {
  version: 1,
  readings: [
    {
      id: 'heartbeat',
      title: 'Heartbeat file is recent',
      source: { kind: 'file-age-seconds', path: 'heartbeat.json' },
      healthy: { op: 'lt', value: 600 },
      unit: 's',
      blind: 'only says the file was written',
    },
    {
      id: 'recent-errors',
      title: 'No ERROR lines in the log window',
      source: { kind: 'text-count', path: 'service.log', pattern: 'ERROR' },
      healthy: { op: 'lt', value: 1, bad: 'notice' },
      blind: 'counts inside the tail window only',
    },
  ],
}

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'hr-e2e-'))
  await writeFile(path.join(dir, 'readings.json'), JSON.stringify(SPEC), 'utf8')
  await writeFile(path.join(dir, 'heartbeat.json'), '{}', 'utf8')
  await writeFile(path.join(dir, 'service.log'), 'INFO all good\n', 'utf8')
  return dir
}

test('all readings healthy → verdict ok, and every reading carries its blind spot', async () => {
  const dir = await fixture()
  const res = await readout({ config: { dataDir: dir } })
  assert.equal(res.verdict, 'ok', renderReadout(res))
  assert.equal(res.total, 2)
  assert.equal(res.counts.ok, 2)
  assert.equal(res.spec_source, path.join(dir, 'readings.json'))
  for (const r of res.readings) {
    assert.equal(r.missingBlind, false)
    assert.ok(typeof r.blind === 'string' && r.blind.length > 0)
  }
})

test('negative control: deleting the watched file turns the verdict `unknown` — never ok, never 0', async () => {
  const dir = await fixture()
  await rm(path.join(dir, 'heartbeat.json'))
  const res = await readout({ config: { dataDir: dir } })
  const heartbeat = res.readings.find((r) => r.id === 'heartbeat')

  assert.equal(heartbeat.state, 'unknown')
  assert.equal(heartbeat.value, null, 'an unread value must not be rendered as 0 or false')
  assert.match(heartbeat.observed_from, /ENOENT/)
  assert.equal(res.verdict, 'unknown')
  assert.notEqual(res.verdict, 'ok')
  assert.match(renderReadout(res), /Could not read" is not "fine"/)
})

test('fire: a tripped criterion moves the verdict to that reading bad state', async () => {
  const dir = await fixture()
  await appendFile(path.join(dir, 'service.log'), 'ERROR something broke\n', 'utf8')
  const res = await readout({ config: { dataDir: dir } })
  const errors = res.readings.find((r) => r.id === 'recent-errors')
  assert.equal(errors.state, 'notice')
  assert.equal(errors.value, 1)
  assert.equal(res.verdict, 'notice')
})

test('the severity ladder decides the verdict: unknown outranks notice', async () => {
  const dir = await fixture()
  await rm(path.join(dir, 'heartbeat.json'))            // → unknown
  await appendFile(path.join(dir, 'service.log'), 'ERROR one\n', 'utf8') // → notice
  const res = await readout({ config: { dataDir: dir } })
  assert.equal(res.verdict, 'unknown', renderReadout(res))
})

test('selftest proves every criterion can go red', async () => {
  const dir = await fixture()
  const res = await readout({ config: { dataDir: dir }, selftest: true })
  assert.deepEqual(res.unfalsifiable, [])
  assert.ok(res.warnings.some((w) => /selftest: every criterion fired/.test(w)), JSON.stringify(res.warnings))
})

test('selftest fails loudly when a criterion cannot fire', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hr-e2e-'))
  await writeFile(path.join(dir, 'readings.json'), JSON.stringify({
    readings: [
      {
        id: 'always-green',
        title: 'holds for every string',
        source: { kind: 'json-field', path: 'nothing.json', field: 'x' },
        healthy: { op: 'matches', value: '.*' },
        blind: 'none — and that is the point of this fixture',
      },
    ],
  }), 'utf8')
  const res = await readout({ config: { dataDir: dir }, selftest: true })
  assert.deepEqual(res.unfalsifiable, ['always-green'])
  assert.ok(res.warnings.some((w) => /selftest FAILED/.test(w)), JSON.stringify(res.warnings))
})

test('`only` filters readings and names the ids it could not find', async () => {
  const dir = await fixture()
  const one = await readout({ config: { dataDir: dir }, only: ['heartbeat'] })
  assert.equal(one.total, 1)
  assert.equal(one.readings[0].id, 'heartbeat')

  const missing = await readout({ config: { dataDir: dir }, only: ['nope'] })
  assert.equal(missing.total, 0)
  assert.equal(missing.verdict, 'unknown')
  assert.ok(missing.warnings.some((w) => /not in the spec/.test(w)), JSON.stringify(missing.warnings))
})

test('an empty spec yields `unknown`, not a confident ok', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hr-e2e-'))
  await writeFile(path.join(dir, 'readings.json'), JSON.stringify({ readings: [] }), 'utf8')
  const res = await readout({ config: { dataDir: dir } })
  assert.equal(res.total, 0)
  assert.equal(res.verdict, 'unknown')
  assert.ok(res.warnings.some((w) => /zero readings/.test(w)))
})

test('an unreadable spec still produces a verdict — and says which spec it used', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hr-e2e-'))
  const res = await readout({ config: { dataDir: dir } })
  assert.equal(res.spec_source, 'builtin')
  assert.equal(res.total, 3)
  assert.ok(res.warnings.some((w) => /not loaded from/.test(w)))
})

test('a config key the plugin ignores is named in the warnings, not swallowed', async () => {
  const dir = await fixture()
  const res = await readout({ config: { dataDir: dir, specFille: 'typo.json' } })
  assert.ok(
    res.warnings.some((w) => /config key\(s\) ignored: specFille/.test(w)),
    JSON.stringify(res.warnings),
  )
  // …and a clean config stays quiet.
  const clean = await readout({ config: { dataDir: dir } })
  assert.ok(!clean.warnings.some((w) => /ignored/.test(w)), JSON.stringify(clean.warnings))
})

test('renderReadout is a pure projection of the value', async () => {
  const dir = await fixture()
  const res = await readout({ config: { dataDir: dir } })
  const text = renderReadout(res)
  assert.match(text, /^verdict: ok/m)
  assert.match(text, /blind spot: only says the file was written/)
  assert.match(text, /\bspec: /)
  // no clock in the projection: rendering twice must be byte-identical
  assert.equal(text, renderReadout(res))
})
