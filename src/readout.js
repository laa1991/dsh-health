/**
 * readout.js — evaluate a spec end to end, with no dsh host involved.
 *
 * Kept free of any `@deepseek-ai/dsh-tools` import on purpose: this is the part
 * that must be testable (and usable) without a running harness. `tool.js` is the
 * thin adapter that wraps it into a model-facing tool.
 *
 * Nothing here writes. The readout composes readings that already exist; the
 * moment it starts persisting state of its own it stops being a readout and
 * becomes one more thing that can be wrong.
 */

import { evaluateReading, aggregate, assertFirable } from './criteria.js'
import { readSource, makeVars } from './sources.js'
import { resolveConfig, loadSpec } from './spec.js'

/**
 * @param {{config?: object, only?: string[]|null, selftest?: boolean, signal?: AbortSignal}} options
 */
export async function readout({ config = {}, only = null, selftest = false, signal } = {}) {
  const cfg = resolveConfig(config);
  const { readings, warnings, specSource, specVersion } = await loadSpec(cfg);
  const vars = makeVars({ dataDir: cfg.dataDir });
  const filter = only && only.length > 0 ? new Set(only) : null;
  const selected = filter ? readings.filter((r) => filter.has(r.id)) : readings;
  const missing = filter ? [...filter].filter((id) => !readings.some((r) => r.id === id)) : [];

  const evaluated = [];
  for (const reading of selected) {
    if (signal && signal.aborted) break;
    const observed = await readSource(reading.source, vars);
    const row = evaluateReading(reading, observed);
    row.observed_from = observed && observed.known === true
      ? (observed.detail || null)
      : (observed && observed.reason) || null;
    evaluated.push(row);
  }

  const agg = aggregate(evaluated);
  const firability = selftest ? assertFirable(readings) : null;
  const extra = [];
  if (missing.length > 0) extra.push(`requested id(s) not in the spec: ${missing.join(', ')}`);
  if (cfg.unknownKeys.length > 0) {
    extra.push(
      `config key(s) ignored: ${cfg.unknownKeys.join(', ')} — this plugin declares no Config schema, `
      + `so the loader passes config through unvalidated (known keys: dataDir, specFile, only)`,
    );
  }

  return {
    at: new Date().toISOString(),
    verdict: agg.state,
    total: evaluated.length,
    counts: agg.counts,
    worst: agg.worst,
    spec_source: specSource,
    spec_version: specVersion ?? null,
    data_dir: cfg.dataDir,
    readings: evaluated,
    unfalsifiable: firability ? [...firability.unfalsifiable, ...firability.unreadable.map((u) => u.id)] : [],
    warnings: [...warnings, ...extra, ...(firability ? firabilityReport(firability) : [])],
  };
}

function firabilityReport(firability) {
  if (firability.ok) return ['selftest: every criterion fired on its counter-example'];
  const parts = [];
  if (firability.unfalsifiable.length) parts.push(`unfalsifiable: ${firability.unfalsifiable.join(', ')}`);
  if (firability.unreadable.length) {
    parts.push(`counter-example did not fire: ${firability.unreadable.map((u) => `${u.id} (${u.why})`).join('; ')}`);
  }
  return [`selftest FAILED — ${parts.join(' | ')}`];
}

/** Pure projection: everything here is derived from the value alone. */
export function renderReadout(value) {
  const lines = [];
  lines.push(`verdict: ${value.verdict}  (${value.total} reading(s): ${formatCounts(value.counts)})`);
  if (value.at) lines.push(`at: ${value.at}`);
  if (value.spec_source) lines.push(`spec: ${value.spec_source}`);
  lines.push('');
  for (const r of value.readings || []) {
    const shown = r.value === null || r.value === undefined ? '—' : `${r.value}${r.unit ? ` ${r.unit}` : ''}`;
    lines.push(`${mark(r.state)} ${r.id}: ${shown}  — ${r.why}`);
    lines.push(`    ${r.title}`);
    if (r.blind) lines.push(`    blind spot: ${r.blind}`);
  }
  const unknown = (value.readings || []).filter((r) => r.state === 'unknown');
  if (unknown.length > 0) {
    lines.push('');
    lines.push(`${unknown.length} reading(s) could not be read. "Could not read" is not "fine".`);
  }
  if (value.unfalsifiable && value.unfalsifiable.length > 0) {
    lines.push('');
    lines.push(`⚠ unfalsifiable criteria (they cannot go red): ${value.unfalsifiable.join(', ')}`);
  }
  if (value.warnings && value.warnings.length > 0) {
    lines.push('');
    for (const w of value.warnings) lines.push(`note: ${w}`);
  }
  return lines.join('\n');
}

function formatCounts(counts = {}) {
  return Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(', ') || 'none';
}

function mark(state) {
  switch (state) {
    case 'ok': return '[ok]';
    case 'notice': return '[--]';
    case 'unknown': return '[??]';
    case 'degraded': return '[!!]';
    case 'broken': return '[XX]';
    default: return '[??]';
  }
}
