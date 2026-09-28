/**
 * index.js — dsh-health-readout plugin entry (host half).
 *
 * A bundle-style dsh plugin: `package.json` declares `dsh.bundle.patch`, the
 * patch inserts exactly one plugin row, and this module is what that row
 * resolves to. There is no client half and no build step — the published files
 * are the files that run.
 *
 * @module dsh-health-readout
 */

import { registerTools } from './tool.js'

export const name = 'dsh-health-readout'

/** The only service this plugin needs. Tool registration is effect-based, so
 *  disposing the plugin fiber (e.g. on config change) unregisters cleanly. */
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const cfg = config && typeof config === 'object' ? config : {}
  registerTools(ctx, () => cfg)
}
