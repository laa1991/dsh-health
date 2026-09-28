/**
 * criteria.js — the declarative core: an observation + a criterion → a state.
 *
 * Pure: no I/O, no clock, no imports. Every function here is total, so a spec
 * that is wrong at 03:00 behaves exactly as it did in a test at noon.
 *
 * Three rules are baked into the API on purpose. Each one cost a real incident
 * before it became a rule elsewhere; here it is the type system instead:
 *
 *   R1. "Cannot tell" is never zero.
 *       A source that could not be read yields `{ known: false }`, and that
 *       maps to the `unknown` state — never to `ok`, never to a value of 0.
 *       `unknown` is always reported; it can never be hidden by an `ok`.
 *
 *   R2. Every criterion must be able to fire.
 *       A criterion nobody can falsify is decoration. `counterExampleFor()`
 *       returns an input that makes each criterion FAIL, and the test suite
 *       runs it for every operator — so "it never goes red" is a test failure,
 *       not a matter of trust.
 *
 *   R3. Every reading states its own blind spot.
 *       `blind` is a required field of a reading, not an optional nicety: a
 *       reading whose limits are unstated reads like a reading whose limits
 *       do not exist.
 */

/** States, ordered by severity. `unknown` deliberately sits between `notice` and `degraded`:
 *  it is not a failure, but it is not green either, and it always stays visible. */
export const STATES = ['ok', 'notice', 'unknown', 'degraded', 'broken'];

export const SEVERITY = Object.freeze({ ok: 0, notice: 1, unknown: 2, degraded: 3, broken: 4 });

/** Operators. Each `test(value, spec)` answers: "is this value HEALTHY?" */
export const OPS = Object.freeze({
  lt: (v, s) => compareOk(v, s) && v < s.value,
  lte: (v, s) => compareOk(v, s) && v <= s.value,
  gt: (v, s) => compareOk(v, s) && v > s.value,
  gte: (v, s) => compareOk(v, s) && v >= s.value,
  eq: (v, s) => v === s.value,
  neq: (v, s) => v !== s.value,
  between: (v, s) =>
    typeof v === 'number' && Number.isFinite(v)
    && typeof s.min === 'number' && typeof s.max === 'number'
    && v >= s.min && v <= s.max,
  matches: (v, s) => typeof v === 'string' && new RegExp(s.value).test(v),
  exists: (v) => v !== null && v !== undefined,
  absent: (v) => v === null || v === undefined,
});

function compareOk(v, s) {
  return typeof v === 'number' && Number.isFinite(v) && typeof s.value === 'number';
}

/** The healthy state a reading falls back to when its criterion does not hold. */
export const DEFAULT_BAD_STATE = 'degraded';

/**
 * Evaluate one observation against one criterion.
 *
 * @param {{known: boolean, value?: unknown, unit?: string, at?: string, detail?: string, reason?: string}} observed
 * @param {{op: string, value?: unknown, min?: number, max?: number}} criterion
 * @param {(value: unknown, criterion: object) => boolean} test — injectable for tests and for callers with their own operators
 * @returns {{state: string, healthy: boolean|null, why: string}}
 */
export function evaluateCriterion(observed, criterion, test = runOp) {
  if (!observed || observed.known !== true) {
    return {
      state: 'unknown',
      healthy: null,
      why: `unreadable: ${observed && observed.reason ? observed.reason : 'no observation'}`,
    };
  }
  if (!criterion || typeof criterion.op !== 'string') {
    return { state: 'unknown', healthy: null, why: 'criterion missing an `op`' };
  }
  if (!Object.prototype.hasOwnProperty.call(OPS, criterion.op)) {
    return { state: 'unknown', healthy: null, why: `unknown op "${criterion.op}"` };
  }
  let healthy;
  try {
    healthy = test(observed.value, criterion) === true;
  } catch (err) {
    return { state: 'unknown', healthy: null, why: `criterion threw: ${err && err.message ? err.message : String(err)}` };
  }
  if (healthy) return { state: 'ok', healthy: true, why: `holds (${describeCriterion(criterion)})` };
  const bad = criterion.bad && SEVERITY[criterion.bad] !== undefined ? criterion.bad : DEFAULT_BAD_STATE;
  return { state: bad, healthy: false, why: `does not hold (${describeCriterion(criterion)})` };
}

function runOp(value, criterion) {
  return OPS[criterion.op](value, criterion);
}

function describeCriterion(criterion) {
  const { op } = criterion;
  if (op === 'between') return `expects between ${criterion.min} and ${criterion.max}`;
  if (op === 'exists' || op === 'absent') return op;
  return `expects ${op} ${JSON.stringify(criterion.value)}`;
}

/**
 * Evaluate one reading: read → judge → carry the blind spot through.
 *
 * @param {{id: string, title?: string, healthy: object, bad?: string, blind: string, unit?: string, about?: string}} reading
 * @param {object} observed
 * @param {(value: unknown, criterion: object) => boolean} [test]
 * @returns {{id: string, title: string, state: string, value: unknown, unit: string|null, at: string|null, why: string, blind: string|null, missingBlind: boolean}}
 */
export function evaluateReading(reading, observed, test = runOp) {
  const verdict = evaluateCriterion(observed, reading.healthy, test);
  return {
    id: reading.id,
    title: reading.title || reading.id,
    state: verdict.state,
    value: observed && observed.known === true ? observed.value : null,
    unit: reading.unit || (observed && observed.unit) || null,
    at: (observed && observed.at) || null,
    why: verdict.why,
    blind: typeof reading.blind === 'string' && reading.blind.trim() !== '' ? reading.blind : null,
    // A missing blind spot is reported instead of being silently omitted (rule R3).
    missingBlind: !(typeof reading.blind === 'string' && reading.blind.trim() !== ''),
  };
}

/**
 * Fold readings into one verdict: the worst state wins.
 *
 * `unknown` therefore pulls the verdict up on its own — by design: a readout
 * that cannot see part of the world must not report a confident "ok".
 */
export function aggregate(readings) {
  const counts = { ok: 0, notice: 0, unknown: 0, degraded: 0, broken: 0 };
  let worst = 'ok';
  const worstIds = [];
  for (const r of readings) {
    if (counts[r.state] === undefined) counts[r.state] = 0;
    counts[r.state] += 1;
    if (SEVERITY[r.state] > SEVERITY[worst]) {
      worst = r.state;
      worstIds.length = 0;
    }
    if (r.state === worst) worstIds.push(r.id);
  }
  return { state: readings.length === 0 ? 'unknown' : worst, worst: worstIds, counts, total: readings.length };
}

/**
 * Rule R2, executable: return a value that makes this criterion FAIL.
 *
 * Used by the test suite to prove every operator can go red, and by `--selftest`
 * to prove a deployment's own spec is falsifiable rather than merely decorative.
 * Returns null when no counter-example can be constructed (which is itself a
 * finding: an unfalsifiable criterion).
 *
 * @param {{op: string, value?: unknown, min?: number, max?: number}} criterion
 * @returns {unknown} an input for which OPS[criterion.op] returns false
 */
export function counterExampleFor(criterion) {
  const { op } = criterion;
  const v = criterion.value;
  switch (op) {
    case 'lt':
      return typeof v === 'number' ? v : 0;
    case 'lte':
      return typeof v === 'number' ? v + 1 : 1;
    case 'gt':
      return typeof v === 'number' ? v : 0;
    case 'gte':
      return typeof v === 'number' ? v - 1 : -1;
    case 'eq':
      return v === null ? 'not-null' : null;
    case 'neq':
      return v;
    case 'between':
      return typeof criterion.min === 'number' ? criterion.min - 1 : -1;
    case 'matches':
      return '\u0000 no match \u0000';
    case 'exists':
      return null;
    case 'absent':
      return 'present';
    default:
      return null;
  }
}

/**
 * Rule R2 as a check over a whole spec.
 *
 * @returns {{ok: boolean, unfalsifiable: string[], unreadable: {id: string, why: string}[]}}
 */
export function assertFirable(readings, test = runOp) {
  const unfalsifiable = [];
  const unreadable = [];
  for (const reading of readings) {
    const counter = counterExampleFor(reading.healthy);
    if (counter === null && reading.healthy.op !== 'exists' && reading.healthy.op !== 'eq') {
      unfalsifiable.push(reading.id);
      continue;
    }
    const probe = evaluateCriterion({ known: true, value: counter }, reading.healthy, test);
    if (probe.state === 'ok' || probe.state === 'unknown') {
      unreadable.push({ id: reading.id, why: `counter-example did not fire (${probe.why})` });
    }
  }
  return { ok: unfalsifiable.length === 0 && unreadable.length === 0, unfalsifiable, unreadable };
}
