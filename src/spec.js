/**
 * spec.js — where the declarations come from, and what counts as a valid one.
 *
 * A spec is data, not code: it lives in a file so it can be reviewed, diffed
 * and version-controlled next to the thing it watches.
 *
 * Resolution order for every setting (first one that answers wins):
 *   1. the `config:` block of the plugin row in `cordis.patch.yml`
 *   2. an environment variable
 *   3. a built-in default
 *
 * The default data directory is deliberately NOT a DSH platform directory.
 * DSH is free to rebuild its own directories on upgrade; a users' readings and
 * ledger must not be inside something that can be rebuilt out from under them.
 *
 * An unknown key in the spec is ignored on purpose (examples carry `_note`
 * fields). A malformed *reading* is reported in `warnings` and still evaluated
 * at runtime — it surfaces as `unknown`, never as a silent pass.
 */

import path from 'node:path'
import os from 'node:os'
import { readFile } from 'node:fs/promises'
import { OPS, STATES } from './criteria.js'
import { listSourceKinds } from './sources.js'

export const DEFAULT_DATA_DIR = path.join(os.homedir(), '.dsh-health-readout');
export const DEFAULT_SPEC_FILE = 'readings.json';

/** Shipped starter spec. Deliberately small and generic: it demonstrates the
 *  three shapes (a heartbeat, a value from a JSON file, a count in a log tail)
 *  without pretending to know what the deploying machine looks like. */
export const BUILTIN_SPEC = Object.freeze({
  version: 1,
  _note: 'Built-in starter spec. Replace it with your own file — see README.',
  readings: [
    {
      id: 'heartbeat',
      title: 'Heartbeat file is recent',
      source: { kind: 'file-age-seconds', path: 'heartbeat.json' },
      healthy: { op: 'lt', value: 600, bad: 'degraded' },
      unit: 's',
      blind: 'Only answers whether the file was written; it says nothing about whether the writer is healthy.',
    },
    {
      id: 'queue-depth',
      title: 'Queue depth below the ceiling',
      source: { kind: 'json-field', path: 'status.json', field: 'queueDepth' },
      healthy: { op: 'lt', value: 8, bad: 'degraded' },
      blind: 'A single sample. It cannot show a queue that drains and refills between samples.',
    },
    {
      id: 'recent-errors',
      title: 'No errors in the recent log window',
      source: { kind: 'text-count', path: 'service.log', pattern: 'ERROR', maxBytes: 131072 },
      healthy: { op: 'lt', value: 1, bad: 'notice' },
      blind: 'Counts inside a byte window, not the whole file — see the window size in the reading detail.',
    },
  ],
});

export const KNOWN_CONFIG_KEYS = ['dataDir', 'specFile', 'only'];

/** @returns {{dataDir: string, specFile: string, only: string[], specPath: string, unknownKeys: string[]}} */
export function resolveConfig(config = {}, env = process.env) {
  const raw = config && typeof config === 'object' ? config : {};
  // The loader passes `config` through unvalidated when a plugin exports no
  // `Config` schema (cordis fiber.ts: `if (!runtime.Config) return config`), so a
  // mistyped key would otherwise be swallowed without a trace. Name them instead:
  // a config key this plugin ignores is exactly the kind of silence that turns
  // into "I set it and nothing happened".
  const unknownKeys = Object.keys(raw).filter((key) => !KNOWN_CONFIG_KEYS.includes(key));
  const dataDir = firstString(raw.dataDir, env.DSH_HEALTH_READOUT_DATA_DIR) || DEFAULT_DATA_DIR;
  const specFile = firstString(raw.specFile, env.DSH_HEALTH_READOUT_SPEC) || DEFAULT_SPEC_FILE;
  const only = Array.isArray(raw.only)
    ? raw.only.filter((x) => typeof x === 'string')
    : firstString(raw.only, env.DSH_HEALTH_READOUT_ONLY)
      ? String(firstString(raw.only, env.DSH_HEALTH_READOUT_ONLY)).split(',').map((s) => s.trim()).filter(Boolean)
      : [];
  const specPath = path.isAbsolute(specFile) ? specFile : path.join(dataDir, specFile);
  return { dataDir, specFile, specPath, only, unknownKeys };
}

function firstString(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c.trim();
  }
  return undefined;
}

/**
 * Validate a list of readings without touching the world.
 *
 * `errors` are things that make a reading meaningless (no id, no source kind,
 * no criterion, no blind spot). `warnings` are things that still evaluate but
 * deserve to be seen (an unknown source kind, a non-firing operator).
 */
export function validateReadings(readings) {
  const errors = [];
  const warnings = [];
  const seen = new Set();
  const kinds = listSourceKinds();
  if (!Array.isArray(readings)) {
    return { ok: false, errors: ['`readings` must be an array'], warnings, count: 0 };
  }
  readings.forEach((reading, i) => {
    const at = `readings[${i}]`;
    if (!reading || typeof reading !== 'object') {
      errors.push(`${at}: not an object`);
      return;
    }
    const id = typeof reading.id === 'string' ? reading.id.trim() : '';
    if (!id) errors.push(`${at}: missing \`id\``);
    else if (seen.has(id)) errors.push(`${at}: duplicate id "${id}"`);
    else seen.add(id);

    if (!reading.source || typeof reading.source !== 'object' || typeof reading.source.kind !== 'string') {
      errors.push(`${id || at}: missing \`source.kind\``);
    } else if (!kinds.includes(reading.source.kind)) {
      warnings.push(`${id || at}: unknown source kind "${reading.source.kind}" — it will read as \`unknown\` (have: ${kinds.join(', ')})`);
    }

    const healthy = reading.healthy;
    if (!healthy || typeof healthy !== 'object' || typeof healthy.op !== 'string') {
      errors.push(`${id || at}: missing \`healthy.op\``);
    } else if (!Object.prototype.hasOwnProperty.call(OPS, healthy.op)) {
      errors.push(`${id || at}: unknown op "${healthy.op}" (have: ${Object.keys(OPS).join(', ')})`);
    }
    if (healthy && healthy.bad !== undefined && STATES.indexOf(healthy.bad) === -1) {
      errors.push(`${id || at}: \`bad\` must be one of ${STATES.join(' | ')}`);
    }

    if (typeof reading.blind !== 'string' || reading.blind.trim() === '') {
      errors.push(`${id || at}: missing \`blind\` — a reading must state what it cannot see`);
    }
    if (typeof reading.title !== 'string' || reading.title.trim() === '') {
      warnings.push(`${id || at}: no \`title\`; the id will be shown instead`);
    }
  });
  return { ok: errors.length === 0, errors, warnings, count: readings.length };
}

/**
 * Load the spec. Never throws: an unreadable or malformed spec degrades to the
 * built-in starter and says so in `warnings` — "I could not read the spec" must
 * never be mistakable for "everything is fine".
 */
export async function loadSpec(cfg) {
  const warnings = [];
  let spec = null;
  let specSource = 'builtin';
  if (cfg && cfg.specPath) {
    try {
      const raw = await readFile(cfg.specPath, 'utf8');
      spec = JSON.parse(raw);
      specSource = cfg.specPath;
    } catch (err) {
      warnings.push(`spec not loaded from ${cfg.specPath} (${err.code || err.message}) — using the built-in starter spec`);
    }
  }
  if (!spec || typeof spec !== 'object') spec = BUILTIN_SPEC;

  const readings = Array.isArray(spec.readings) ? spec.readings : [];
  if (!Array.isArray(spec.readings)) warnings.push('spec has no `readings` array — nothing to evaluate');

  const validation = validateReadings(readings);
  warnings.push(...validation.warnings);
  if (!validation.ok) {
    warnings.push(`spec has ${validation.errors.length} error(s): ${validation.errors.join('; ')}`);
  }
  if (readings.length === 0) {
    warnings.push('spec declares zero readings — the verdict will be `unknown`, never `ok`');
  }
  return { readings, warnings, specSource, specVersion: spec.version ?? null, errors: validation.errors };
}
