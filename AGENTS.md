# dsh-health-readout — Agent Guide

## What this is

A read-only dsh plugin: declarations in, one verdict out. Each reading is
`source → criterion → verdict`, and every reading carries the blind spot it
cannot see. Host half only — no client bundle, no build step, no runtime
dependencies. The files that ship are the files that run.

## The three layers, and why the split is load-bearing

| file | role | the rule that keeps it honest |
|---|---|---|
| `src/criteria.js` | judgement: observation + criterion → state | **pure** — no I/O, no clock, no imports |
| `src/sources.js` | the read side: where a value comes from | **never throws** — an unreadable world returns `{known: false, reason}` |
| `src/readout.js` | evaluation end to end | **no dsh import** — this is why the tests can run without a host |
| `src/spec.js` | declarations, config resolution, validation | `config` → env → default; a missing `blind` is an error |
| `src/tool.js` | the model-facing adapter (`defineTool`) | thin — schema plus forwarding, nothing else |
| `src/index.js` | plugin entry (`name` / `inject` / `apply`) | resolves the patch row, hands config through |

Splitting `readout.js` from `tool.js` is not tidiness: as long as evaluation has
no harness import, it can be tested, scripted (`scripts/readout-cli.mjs`) and
reasoned about without a running dsh.

## Two hard rules (enforced by the API, not by intention)

1. **"Cannot tell" is never zero.** An unreadable source maps to `unknown` —
   never `ok`, never `0`, never `false`. `unknown` is always reported, and it
   moves the verdict on its own (`aggregate` gives it more weight than `notice`).
2. **Every criterion must be able to fire.** `counterExampleFor()` produces, for
   each operator, an input that makes the criterion fail; `assertFirable()` runs
   that over a whole spec, and `selftest: true` (or `--selftest`) reports any
   criterion that stayed green. A criterion nobody can falsify is decoration, and
   it is named as such.

Plus **R3**: every reading states its blind spot. `blind` missing is a
validation error, and `missingBlind` is printed rather than quietly omitted.

## Three things this plugin must never do

- **Never write.** No state, no cache, no ledger, no lock file. The moment it
  persists something it stops being a readout and becomes one more thing that
  can be wrong.
- **Never fold across lines.** "How many records are still open" is a query, not
  a reading; point the spec at a file that already carries that number and keep
  the fold in whatever produced it.
- **Never become a source of truth.** It composes readings that already exist;
  the exit for those readings stays with their producers.

## Commands

```sh
node --test test/criteria.test.mjs test/sources.test.mjs test/spec.test.mjs test/readout.test.mjs
node scripts/smoke.mjs                                   # the real defineTool; see its header for the peer junction
node scripts/readout-cli.mjs --spec <file> [--selftest] [--json] [--gate]
```

`--gate` exits 1 on `degraded`, `broken` **or `unknown`**: a gate that passes
while blind is not a gate.

## Gotchas (measured, not guessed — each one cost a round)

- `@deepseek-ai/dsh-tools` **cannot be resolved by plain Node from a plugin
  directory**, not even for plugins that work live inside dsh; the host resolves
  its own packages. For a local run, junction
  `node_modules/@deepseek-ai/dsh-tools` to `<checkout>/packages/core/tools`.
- `defineTool` returns `parameters` **as a JSON schema** (`{type, properties}`)
  and does not carry `declaresExpectation` through verbatim — assert the
  contract, not the literal spec you passed in.
- A plugin that exports no `Config` schema has its `config` passed through
  **unvalidated** (`vendor/cordis/src/fiber.ts`, `resolveConfig`: `if
  (!runtime.Config) return config`) ⇒ the plugin itself names the keys it
  ignores (`config key(s) ignored: …`).
- Tail reads drop the first line **only when the byte before the window is not a
  line break**; dropping it blindly turns "one whole record in the window" into
  "no record at all".

## Publishing state

- `dsh.bundle.patch` is declared — that is what makes the repo installable via
  `dsh plugin add`, and it is the first thing the index checks. Declaring only
  `dsh.client` is not installable.
- Not `private`; MIT licensed (`LICENSE`); authored as
  `laa1991 <285244165+laa1991@users.noreply.github.com>`.
- Repo: <https://github.com/laa1991/dsh-health>, topic `dsh-plugin`. The repo is
  `dsh-health` while the package stays `dsh-health-readout`, because `dsh-health`
  is already taken on npm by another account (a 0.0.1 name reservation, for the
  same niche) — do not "fix" that mismatch.
- Not published to npm, and nothing needs building: the index does not require an
  npm release, and `dsh plugin --profile <name> add <git-url>` installs exactly
  these files.
- `@deepseek-ai/dsh-tools` is declared as an **optional peerDependency** with an
  explicit prerelease branch. `src/tool.js`'s header carries the measurement that
  forced that shape: a bare `*` does not match prereleases, and the harness is a
  prerelease.
