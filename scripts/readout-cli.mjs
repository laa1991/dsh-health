#!/usr/bin/env node
/**
 * readout-cli.mjs — run a spec and print its verdict, without a dsh host.
 *
 * The plugin's tool needs a running harness; a readout often does not. This is
 * the same evaluator behind a command line, which is what makes the result
 * usable from a scheduled task, a pre-flight check, or a shell prompt.
 *
 * usage:
 *   node scripts/readout-cli.mjs --spec <file> [--data-dir <dir>] [--only a,b] [--selftest] [--json] [--gate]
 *
 * exit:
 *   0  normally (it prints a verdict, including a bad one)
 *   1  with --gate, when the verdict is `degraded`, `broken` **or `unknown`** —
 *      a gate that passes while blind is not a gate.
 *   2  bad usage
 */

import { readout, renderReadout } from '../src/readout.js'

const argv = process.argv.slice(2)
const has = (name) => argv.includes(`--${name}`)
const opt = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
}

if (has('help') || has('h')) {
  console.log('usage: node scripts/readout-cli.mjs --spec <file> [--data-dir <dir>] [--only a,b] [--selftest] [--json] [--gate]')
  process.exit(2)
}
if (argv.length > 0 && !has('spec') && !has('data-dir')) {
  console.error('readout-cli: nothing to read — pass --spec <file> or --data-dir <dir> (or --help)')
  process.exit(2)
}

const config = {}
if (opt('spec')) config.specFile = opt('spec')
if (opt('data-dir')) config.dataDir = opt('data-dir')
const only = opt('only') ? opt('only').split(',').map((s) => s.trim()).filter(Boolean) : null

const value = await readout({ config, only, selftest: has('selftest') })

if (has('json')) console.log(JSON.stringify(value, null, 2))
else console.log(renderReadout(value))

if (has('gate') && ['degraded', 'broken', 'unknown'].includes(value.verdict)) process.exitCode = 1
