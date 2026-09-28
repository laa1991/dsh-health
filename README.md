# dsh-health-readout

**Declare where to read, what counts as healthy, and what each failure means — get one verdict.**

A read-only [dsh](https://github.com/deepseek-harness) plugin. It composes readings that already
exist (files, JSON endpoints, log tails) and returns a single verdict with per-reading detail.
It never writes anything, never keeps state, and never becomes a source of truth.

```jsonc
{
  "readings": [{
    "id": "queue-depth",
    "title": "Queue depth is under the ceiling",
    "source":  { "kind": "json-field", "path": "status.json", "field": "queueDepth" },
    "healthy": { "op": "lt", "value": 8, "bad": "degraded" },
    "blind":   "A single sample: a queue that drains and refills between samples looks identical to a quiet one."
  }]
}
```

## Three rules, built into the API

These are not style preferences. Each one is a bug we shipped somewhere before it became a rule,
and here they are enforced by the type shapes and by tests rather than by good intentions:

1. **"Cannot tell" is never zero.** A source that cannot be read yields `unknown` — never `ok`,
   never `0`, never `false`. `unknown` is always printed, and it moves the verdict on its own.
2. **Every criterion must be able to fire.** `selftest: true` feeds each declared criterion its own
   counter-example and reports any criterion that stayed green — a criterion nobody can falsify is
   decoration, and it is reported as such.
3. **Every reading states its blind spot.** `blind` is required. A reading whose limits are unstated
   reads like a reading whose limits do not exist.

## Install

```
dsh plugin --profile <name> add dsh-health-readout      # npm
dsh plugin --profile <name> add ./dsh-health-readout-0.1.0.tgz
dsh plugin --profile <name> add <git-url>               # prebuilt: no build step, no postinstall
```

The package ships exactly the files that run (no build, no `prepare` script, no runtime
dependencies), so a git install needs no build permission from the user.

## Configure

Every value resolves in this order: the plugin row's `config:` block → environment variable →
built-in default.

| setting | config key | environment variable | default |
|---|---|---|---|
| where readings live | `dataDir` | `DSH_HEALTH_READOUT_DATA_DIR` | `~/.dsh-health-readout` |
| the declarations | `specFile` | `DSH_HEALTH_READOUT_SPEC` | `readings.json` (inside `dataDir`) |
| evaluate only some ids | `only` | `DSH_HEALTH_READOUT_ONLY` | all |

> **The data directory is deliberately not a dsh platform directory.** dsh may rebuild its own
> directories on upgrade; a user's readings must not be inside something that can be rebuilt out
> from under them. Point `dataDir` anywhere you control.

Relative paths inside the spec resolve against `dataDir`. `~` and `${dataDir}` are expanded.

## The spec

Copy `examples/readings.example.json` to `<dataDir>/readings.json` and edit it.

**Source kinds**

| kind | reads | required fields |
|---|---|---|
| `file-age-seconds` | seconds since a file was written | `path` |
| `file-size` | bytes | `path` |
| `file-exists` | whether a path exists (`false` is knowledge, not ignorance) | `path` |
| `json-field` | a dotted path inside a JSON file | `path`, `field` |
| `jsonl-last-field` | a dotted path in the last parseable JSONL line (tail-read) | `path`, `field`, `maxBytes?` |
| `text-count` | regex matches in the last `maxBytes` of a file | `path`, `pattern`, `maxBytes?`, `flags?` |
| `dir-count` | files in a directory, optionally by suffix | `path`, `suffix?` |
| `http-json-field` | a dotted path in a JSON endpoint (always timed out) | `url`, `field`, `timeoutMs?` |

**Operators** (`healthy.op`): `lt` `lte` `gt` `gte` `eq` `neq` `between` `matches` `exists` `absent`.

**States** (`healthy.bad`, default `degraded`), ordered by severity —
the worst reading decides the verdict:

`ok` < `notice` < `unknown` < `degraded` < `broken`

`unknown` sits above `notice` on purpose: a readout that cannot see part of the world must not
report a confident `ok`.

## The tool

`health_readout` — one read-only call, two optional arguments:

- `only` — comma-separated reading ids to evaluate.
- `selftest` — also prove every declared criterion can go red.

The rendered output lists each reading with its value, its verdict, its reason and its blind spot,
and prints the unreadable ones separately (`"Could not read" is not "fine".`).

## Tests

```
node --test test/criteria.test.mjs test/sources.test.mjs test/spec.test.mjs test/readout.test.mjs
```

43 tests, no test framework and no fixtures on disk. The two arms worth knowing about: deleting a
watched file must move the verdict to `unknown` (never leaving it at `ok`), and a deliberately
unfalsifiable criterion (`matches: ".*"`) must be reported as such by `selftest`.

## Limitations (stated, not hidden)

- **No cross-line folding.** A reading is one value from one place. "How many records are still
  open" means folding several JSONL lines into a state, which is a query, not a reading. Point the
  spec at a file that already carries that number (a derived snapshot) and keep the fold in
  whatever produced it — this plugin composes readings, it does not become a query engine.
- **No history.** Every reading is one sample of the present. Trends need a recorder, and a
  recorder is a writer — out of scope for a readout.
- **No `changed-within` operator.** Comparing to a previous value requires state; see above.
- **`unknown` is noisy by design.** A missing file moves the verdict. That is the intended trade:
  silence about a blind spot is more expensive than a loud report about one.
- **A spec may read any file the dsh process can read.** That is the trust model: the user writes
  the spec, the user owns the paths.
- **Host-only.** No browser half, no settings UI; the verdict reaches the model as a tool result.

## License

MIT.
