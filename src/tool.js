/**
 * tool.js — the model-facing adapter: one read-only tool, `health_readout`.
 *
 * This file is deliberately thin. The evaluation lives in `readout.js` (no dsh
 * host needed, so it is testable and reusable); this module only declares the
 * tool surface and forwards to it.
 *
 * Conventions followed from the dsh plugin guide (via @huanlin/dsh-plugin-device-info,
 * a working external plugin in this deployment):
 *   - `execute` returns a canonical JSON value; `render` is a separate pure
 *     projection (no I/O, no clock), so a rendered card survives session-log replay.
 *   - Non-ideal domain states (unreadable source, empty spec) live in the value.
 *     Only genuine infrastructure failures reject.
 *   - `exec.signal` is honoured at every await point.
 *   - `@deepseek-ai/dsh-tools` is imported and declared as an **optional**
 *     peerDependency: the host resolves its own packages at runtime, and
 *     `optional: true` keeps pnpm from auto-installing a peer that is not on the
 *     registry. The range carries an explicit prerelease branch, because a bare
 *     `*` does NOT admit prereleases — measured on semver 6.3.1 / 7.8.4 / 7.8.5:
 *     `satisfies('0.1.0-rc.6', '*') === false`, while
 *     `>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0` returns true.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { readout, renderReadout } from './readout.js'
import { listSourceKinds } from './sources.js'

const VALUE_SCHEMA = {
  oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
};

const READING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    state: { type: 'string', required: true, description: 'ok | notice | unknown | degraded | broken' },
    value: VALUE_SCHEMA,
    unit: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    at: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    why: { type: 'string', required: true },
    blind: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    missingBlind: { type: 'boolean', required: true, description: 'True when the reading forgot to state its blind spot.' },
    observed_from: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  },
};

export function registerTools(ctx, getConfig) {
  ctx.tools.register(defineTool({
    name: 'health_readout',
    declaresExpectation: false,
    description:
      'Evaluate the declared health readings and return one verdict. '
      + 'Each reading is declared as source → criterion → verdict in the spec file '
      + `(source kinds: ${listSourceKinds().join(', ')}). Read-only: it composes readings that already exist, `
      + 'it never writes anything and never becomes a source of truth. '
      + 'A reading whose source cannot be read is reported as `unknown`, never as 0 and never as ok.',
    parameters: {
      only: {
        type: 'string',
        description: 'Optional comma-separated reading ids to evaluate. Omit to evaluate every declared reading.',
      },
      selftest: {
        type: 'boolean',
        description: 'When true, additionally prove each criterion can go red by feeding it a counter-example.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          at: { type: 'string', required: true },
          verdict: { type: 'string', required: true, description: 'ok | notice | unknown | degraded | broken' },
          total: { type: 'integer', required: true },
          worst: { type: 'array', required: true, items: { type: 'string' } },
          counts: { type: 'object', required: true, additionalProperties: true },
          spec_source: { type: 'string', required: true },
          spec_version: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          data_dir: { type: 'string', required: true },
          readings: { type: 'array', required: true, items: READING_SCHEMA },
          unfalsifiable: { type: 'array', required: true, items: { type: 'string' } },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderReadout(value) }],
    },
    execute: async (args, exec) => {
      const a = args && typeof args === 'object' ? args : {};
      const only = typeof a.only === 'string' && a.only.trim() !== ''
        ? a.only.split(',').map((s) => s.trim()).filter(Boolean)
        : null;
      return readout({
        config: getConfig(),
        only,
        selftest: a.selftest === true,
        signal: exec && exec.signal,
      });
    },
  }));
}

export { readout, renderReadout }
