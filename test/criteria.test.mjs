// criteria.test.mjs — the declarative core.
//
// Two rules from the field are enforced here as tests rather than as prose:
//   R1  "could not read" must never be reported as ok or as 0.
//   R2  every criterion must be able to fire — a criterion that cannot go red
//       is decoration, and this suite fails if one exists.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OPS,
  STATES,
  SEVERITY,
  evaluateCriterion,
  evaluateReading,
  aggregate,
  counterExampleFor,
  assertFirable,
} from '../src/criteria.js'

/** one spec per operator, plus the value that makes it HOLD */
const CASES = {
  lt: { spec: { op: 'lt', value: 10 }, holds: 9 },
  lte: { spec: { op: 'lte', value: 10 }, holds: 10 },
  gt: { spec: { op: 'gt', value: 10 }, holds: 11 },
  gte: { spec: { op: 'gte', value: 10 }, holds: 10 },
  eq: { spec: { op: 'eq', value: 'up' }, holds: 'up' },
  neq: { spec: { op: 'neq', value: 'up' }, holds: 'down' },
  between: { spec: { op: 'between', min: 1, max: 5 }, holds: 3 },
  matches: { spec: { op: 'matches', value: '^ab+c$' }, holds: 'abbbc' },
  exists: { spec: { op: 'exists' }, holds: 'anything' },
  absent: { spec: { op: 'absent' }, holds: null },
}

test('every operator holds on a healthy value', () => {
  for (const [op, { spec, holds }] of Object.entries(CASES)) {
    const verdict = evaluateCriterion({ known: true, value: holds }, spec)
    assert.equal(verdict.state, 'ok', `${op} should hold for ${JSON.stringify(holds)} (${verdict.why})`)
    assert.equal(verdict.healthy, true)
  }
})

test('R2: every operator fires on its own counter-example', () => {
  for (const [op, { spec }] of Object.entries(CASES)) {
    const counter = counterExampleFor(spec)
    const verdict = evaluateCriterion({ known: true, value: counter }, spec)
    assert.notEqual(verdict.state, 'ok', `${op} stayed green on its counter-example ${JSON.stringify(counter)}`)
    assert.notEqual(verdict.state, 'unknown', `${op} could not be evaluated on ${JSON.stringify(counter)}`)
    assert.equal(verdict.healthy, false)
  }
})

test('R2: the operator table and the case table stay in sync', () => {
  assert.deepEqual(Object.keys(OPS).sort(), Object.keys(CASES).sort())
})

test('R1: an unreadable observation is `unknown` — never ok, never a value', () => {
  const verdict = evaluateCriterion({ known: false, reason: 'ENOENT' }, { op: 'lt', value: 10 })
  assert.equal(verdict.state, 'unknown')
  assert.notEqual(verdict.state, 'ok')
  assert.equal(verdict.healthy, null)
  assert.match(verdict.why, /ENOENT/)
})

test('R1: an empty reading list aggregates to `unknown`, not to ok', () => {
  const agg = aggregate([])
  assert.equal(agg.state, 'unknown')
  assert.notEqual(agg.state, 'ok')
  assert.equal(agg.total, 0)
})

test('unusable criteria degrade to `unknown` instead of throwing', () => {
  assert.equal(evaluateCriterion({ known: true, value: 1 }, undefined).state, 'unknown')
  assert.equal(evaluateCriterion({ known: true, value: 1 }, { op: 'no-such-op' }).state, 'unknown')
  const throwing = () => {
    throw new Error('operator blew up')
  }
  const verdict = evaluateCriterion({ known: true, value: 1 }, { op: 'lt', value: 2 }, throwing)
  assert.equal(verdict.state, 'unknown')
  assert.match(verdict.why, /operator blew up/)
})

test('a failing criterion lands on its declared bad state, defaulting to degraded', () => {
  assert.equal(evaluateCriterion({ known: true, value: 99 }, { op: 'lt', value: 10 }).state, 'degraded')
  assert.equal(evaluateCriterion({ known: true, value: 99 }, { op: 'lt', value: 10, bad: 'notice' }).state, 'notice')
  assert.equal(evaluateCriterion({ known: true, value: 99 }, { op: 'lt', value: 10, bad: 'broken' }).state, 'broken')
})

test('the severity ladder puts unknown above notice and below degraded', () => {
  assert.ok(SEVERITY.ok < SEVERITY.notice)
  assert.ok(SEVERITY.notice < SEVERITY.unknown)
  assert.ok(SEVERITY.unknown < SEVERITY.degraded)
  assert.ok(SEVERITY.degraded < SEVERITY.broken)
  assert.deepEqual(STATES, ['ok', 'notice', 'unknown', 'degraded', 'broken'])
})

test('aggregate: the worst state wins, and ties name their ids', () => {
  const rows = (states) => states.map((state, i) => ({ id: `r${i}`, state }))
  assert.equal(aggregate(rows(['ok', 'notice'])).state, 'notice')
  assert.equal(aggregate(rows(['ok', 'unknown'])).state, 'unknown')
  assert.equal(aggregate(rows(['unknown', 'degraded'])).state, 'degraded')
  assert.equal(aggregate(rows(['degraded', 'broken'])).state, 'broken')
  const tie = aggregate(rows(['broken', 'ok', 'broken']))
  assert.deepEqual(tie.worst, ['r0', 'r2'])
  assert.equal(tie.counts.broken, 2)
})

test('R3: a reading without a blind spot says so out loud', () => {
  const withBlind = evaluateReading(
    { id: 'a', healthy: { op: 'lt', value: 10 }, blind: 'only samples the last line' },
    { known: true, value: 1 },
  )
  assert.equal(withBlind.missingBlind, false)
  assert.equal(withBlind.blind, 'only samples the last line')

  const withoutBlind = evaluateReading({ id: 'b', healthy: { op: 'lt', value: 10 } }, { known: true, value: 1 })
  assert.equal(withoutBlind.missingBlind, true)
  assert.equal(withoutBlind.blind, null)
})

test('assertFirable passes a real spec and flags an unfalsifiable one', () => {
  const good = assertFirable([
    { id: 'g1', healthy: { op: 'lt', value: 10 }, blind: 'x' },
    { id: 'g2', healthy: { op: 'matches', value: '^ab+c$' }, blind: 'x' },
    { id: 'g3', healthy: { op: 'exists' }, blind: 'x' },
  ])
  assert.equal(good.ok, true, JSON.stringify(good))

  // `matches: '.*'` holds for every string: it can never go red.
  const bad = assertFirable([{ id: 'b1', healthy: { op: 'matches', value: '.*' }, blind: 'x' }])
  assert.equal(bad.ok, false)
  assert.equal(bad.unreadable[0].id, 'b1')
  assert.match(bad.unreadable[0].why, /did not fire/)
})
