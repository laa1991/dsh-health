// scripts/smoke.mjs — exercise the real dsh plugin path, with the real defineTool.
//
// This is the verification that the plain `node --test` suite cannot give: that
// the tool surface itself is acceptable — registration, parameters, output value,
// render. The count of arms is printed by the run itself, on the last line —
// this header used to carry a number ("10/10", 2026-09-28) and the number rotted
// while the run did not, so a count here would be one more thing to re-check.
//
// Prerequisite — make `@deepseek-ai/dsh-tools` resolvable from THIS package:
//   junction  node_modules/@deepseek-ai/dsh-tools  ->  <dsh checkout>/packages/core/tools
// (`dsh-tools` is a workspace package of the harness; its built `lib/index.js`
// is what the running host uses, so this is the real module, not a stub.)
//
// ⚠️ Two facts found while making this run, both of which cost time to re-learn:
//   1. Plain Node cannot resolve `@deepseek-ai/dsh-tools` from a plugin directory
//      — not even for a plugin that works live inside dsh (verified on a live
//      one). The host resolves its own packages itself, so "will this import
//      work?" is not answerable by Node before a mount.
//   2. A profile's node_modules has NO `@deepseek-ai` scope and its .pnpm has no
//      dsh-tools: the runtime does not live in the profile. Point the junction at
//      the harness checkout instead (as above).
//
// ⚠️ And what defineTool hands back is not the literal spec: `parameters` comes
// back as a JSON schema (type + properties), and `declaresExpectation` is not
// carried through verbatim. Assert the contract, not the spec text.
//
// Run:  node scripts/smoke.mjs      Exit: 0 when every arm behaves, 1 otherwise.

import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { registerTools } from '../src/tool.js'

const SPEC = {
  version: 1,
  readings: [
    {
      id: 'heartbeat',
      title: 'Heartbeat is recent',
      source: { kind: 'file-age-seconds', path: 'heartbeat.json' },
      healthy: { op: 'lt', value: 600 },
      unit: 's',
      blind: 'only says the file was written',
    },
    {
      id: 'recent-errors',
      title: 'No ERROR lines in the window',
      source: { kind: 'text-count', path: 'service.log', pattern: 'ERROR' },
      healthy: { op: 'lt', value: 1, bad: 'notice' },
      blind: 'tail window only',
    },
  ],
}

const dir = await mkdtemp(path.join(tmpdir(), 'hr-smoke-'))
await writeFile(path.join(dir, 'readings.json'), JSON.stringify(SPEC), 'utf8')
await writeFile(path.join(dir, 'heartbeat.json'), '{}', 'utf8')
await writeFile(path.join(dir, 'service.log'), 'INFO all good\n', 'utf8')

const captured = []
const ctx = { tools: { register: (tool) => captured.push(tool) } }
let failures = 0
let checks = 0

function check(label, ok, detail = '') {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

try {
  registerTools(ctx, () => ({ dataDir: dir }))
  check('registered exactly one tool', captured.length === 1, `got ${captured.length}`)

  const tool = captured[0]
  check('tool name is health_readout', tool.name === 'health_readout', String(tool.name))
  // What defineTool hands back is not the literal spec: `parameters` comes back
  // as a JSON schema (type + properties), and declarative flags are not carried
  // through verbatim. Assert the contract we actually depend on, and print the
  // real shapes so the next reader does not have to guess.
  console.log(`      tool fields: ${Object.keys(tool).join(', ')}`)
  console.log(`      declaresExpectation: ${JSON.stringify(tool.declaresExpectation)}`)
  console.log(`      parameters: ${JSON.stringify(tool.parameters)}`)
  const paramSchema = tool.parameters || {}
  const paramNames = Object.keys(paramSchema.properties || {}).sort().join(',')
  check('parameters schema names exactly only + selftest', paramSchema.type === 'object' && paramNames === 'only,selftest', paramNames)
  const required = Array.isArray(paramSchema.required) ? paramSchema.required : []
  check('both parameters are optional (nothing is required)', required.length === 0, JSON.stringify(required))
  check('output schema is present', Boolean(tool.output && tool.output.schema && tool.output.render))

  // arm 1 — healthy world
  const value = await tool.execute({}, { signal: AbortSignal.timeout(20000) })
  check('execute returned a value (schema accepted)', Boolean(value) && typeof value === 'object')
  check('verdict is ok', value.verdict === 'ok', `verdict=${value.verdict}`)
  check('two readings evaluated', value.total === 2, `total=${value.total}`)
  check('value carries the auto timestamp', typeof value.at === 'string' && value.at.length > 0)

  const blocks = tool.output.render({}, value)
  check('render returns one text block', Array.isArray(blocks) && blocks.length === 1 && blocks[0].type === 'text')
  check('rendered text starts with the verdict', /^verdict: ok/.test(blocks[0].text))

  // arm 2 — negative control: the watched file disappears
  await rm(path.join(dir, 'heartbeat.json'))
  const gone = await tool.execute({ only: 'heartbeat' }, { signal: AbortSignal.timeout(20000) })
  check('deleting the watched file yields unknown', gone.verdict === 'unknown', `verdict=${gone.verdict}`)
  check('unknown is never rendered as a value', gone.readings[0].value === null, `value=${JSON.stringify(gone.readings[0].value)}`)

  // arm 3 — selftest arm
  const self = await tool.execute({ selftest: true }, { signal: AbortSignal.timeout(20000) })
  check('selftest reports no unfalsifiable criterion', Array.isArray(self.unfalsifiable) && self.unfalsifiable.length === 0,
    JSON.stringify(self.unfalsifiable))

  console.log('')
  console.log('--- rendered by the real tool ---')
  console.log(tool.output.render({}, value)[0].text)
} catch (err) {
  failures += 1
  console.log(`FAIL  threw: ${err && err.stack ? err.stack : err}`)
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log('')
console.log(failures === 0 ? `SMOKE OK (${checks} arms)` : `SMOKE FAILED (${failures}/${checks} arms)`)
process.exitCode = failures === 0 ? 0 : 1
