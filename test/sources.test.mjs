// sources.test.mjs — the read side.
//
// The load-bearing check here is the negative one: a source that cannot be read
// must come back as `known: false` with a reason, and must never be dressed up
// as a zero, a false or an empty string.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, utimes, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readSource, makeVars, expandPath, getPath, readTailLines, listSourceKinds } from '../src/sources.js'

async function fixtureDir() {
  return await mkdtemp(path.join(tmpdir(), 'hr-src-'))
}

test('file-age-seconds reads an age and reports the file it read', async () => {
  const dir = await fixtureDir()
  const file = path.join(dir, 'heartbeat.json')
  await writeFile(file, '{}', 'utf8')
  const then = new Date(Date.now() - 3000 * 1000)
  await utimes(file, then, then)

  const res = await readSource({ kind: 'file-age-seconds', path: 'heartbeat.json' }, makeVars({ dataDir: dir }))
  assert.equal(res.known, true)
  assert.ok(res.value >= 2990 && res.value <= 3010, `age looked wrong: ${res.value}`)
  assert.equal(res.unit, 's')
  assert.equal(res.detail, file)
})

test('a missing file is `known: false` with a reason — not an age of 0', async () => {
  const dir = await fixtureDir()
  const res = await readSource({ kind: 'file-age-seconds', path: 'nope.json' }, makeVars({ dataDir: dir }))
  assert.equal(res.known, false)
  assert.notEqual(res.value, 0)
  assert.match(res.reason, /ENOENT/)
})

test('file-exists treats false as knowledge, not as ignorance', async () => {
  const dir = await fixtureDir()
  await writeFile(path.join(dir, 'here.txt'), 'x', 'utf8')
  const vars = makeVars({ dataDir: dir })
  assert.deepEqual(await readSource({ kind: 'file-exists', path: 'here.txt' }, vars), {
    known: true,
    value: true,
    detail: path.join(dir, 'here.txt'),
  })
  const absent = await readSource({ kind: 'file-exists', path: 'gone.txt' }, vars)
  assert.equal(absent.known, true)
  assert.equal(absent.value, false)
})

test('json-field walks a dotted path and reports a moved field as unreadable', async () => {
  const dir = await fixtureDir()
  await writeFile(path.join(dir, 'status.json'), JSON.stringify({ a: { b: [{ c: 7 }] }, queueDepth: 3 }), 'utf8')
  const vars = makeVars({ dataDir: dir })

  const nested = await readSource({ kind: 'json-field', path: 'status.json', field: 'a.b.0.c' }, vars)
  assert.equal(nested.value, 7)

  const flat = await readSource({ kind: 'json-field', path: 'status.json', field: 'queueDepth' }, vars)
  assert.equal(flat.value, 3)

  // `.length` is how an empty-or-not list becomes readable at all
  const listLen = await readSource({ kind: 'json-field', path: 'status.json', field: 'a.b.length' }, vars)
  assert.equal(listLen.value, 1)
  const strLen = await readSource({ kind: 'json-field', path: 'status.json', field: 'queueDepth.length' }, vars)
  assert.equal(strLen.known, false, 'a number has no length — that is unreadable, not zero')

  const moved = await readSource({ kind: 'json-field', path: 'status.json', field: 'a.b.9.c' }, vars)
  assert.equal(moved.known, false)
  assert.match(moved.reason, /absent/)

  const broken = path.join(dir, 'broken.json')
  await writeFile(broken, '{ not json', 'utf8')
  const bad = await readSource({ kind: 'json-field', path: broken, field: 'x' }, vars)
  assert.equal(bad.known, false)
  assert.match(bad.reason, /json read failed/)
})

test('jsonl-last-field skips a half-written trailing line instead of giving up', async () => {
  const dir = await fixtureDir()
  const file = path.join(dir, 'log.jsonl')
  await writeFile(
    file,
    ['{"seq":1,"ok":true}', '{"seq":2,"ok":true}', '{"seq":3,"ok":tr'].join('\n'),
    'utf8',
  )
  const res = await readSource({ kind: 'jsonl-last-field', path: 'log.jsonl', field: 'seq' }, makeVars({ dataDir: dir }))
  assert.equal(res.known, true)
  assert.equal(res.value, 2, 'should fall back to the last parseable line')
})

test('jsonl-last-field reads from the tail, not from the head', async () => {
  const dir = await fixtureDir()
  const file = path.join(dir, 'big.jsonl')
  const filler = `${'x'.repeat(4096)}\n`
  const lines = []
  for (let i = 0; i < 200; i += 1) lines.push(`${filler}{"seq":${i}}`)
  await writeFile(file, lines.join('\n'), 'utf8')

  const res = await readSource(
    { kind: 'jsonl-last-field', path: 'big.jsonl', field: 'seq', maxBytes: 1024 },
    makeVars({ dataDir: dir }),
  )
  assert.equal(res.known, true)
  assert.equal(res.value, 199)
  assert.match(res.detail, /tail/)
})

test('text-count states the window it counted over', async () => {
  const dir = await fixtureDir()
  const file = path.join(dir, 'service.log')
  await writeFile(file, ['INFO ok', 'ERROR one', 'ERROR two'].join('\n'), 'utf8')
  const vars = makeVars({ dataDir: dir })

  const hits = await readSource({ kind: 'text-count', path: 'service.log', pattern: 'ERROR' }, vars)
  assert.equal(hits.value, 2)
  assert.match(hits.detail, /whole file/)

  const windowed = await readSource(
    { kind: 'text-count', path: 'service.log', pattern: 'ERROR', maxBytes: 12 },
    vars,
  )
  assert.match(windowed.detail, /last 12 B/)
})

test('dir-count counts files only, and can filter by suffix', async () => {
  const dir = await fixtureDir()
  await mkdir(path.join(dir, 'nested'))
  await writeFile(path.join(dir, 'a.json'), '{}', 'utf8')
  await writeFile(path.join(dir, 'b.json'), '{}', 'utf8')
  await writeFile(path.join(dir, 'c.txt'), 'x', 'utf8')
  const vars = makeVars({ dataDir: dir })
  assert.equal((await readSource({ kind: 'dir-count', path: '.' }, vars)).value, 3)
  assert.equal((await readSource({ kind: 'dir-count', path: '.', suffix: '.json' }, vars)).value, 2)
})

test('an unknown source kind is an unreadable reading, not a crash', async () => {
  const res = await readSource({ kind: 'no-such-kind' }, makeVars({}))
  assert.equal(res.known, false)
  assert.match(res.reason, /unknown source kind/)
  assert.ok(listSourceKinds().includes('file-age-seconds'))
})

test('path expansion: ~, ${dataDir} and relative paths', () => {
  const vars = makeVars({ dataDir: '/data/dir' })
  assert.equal(expandPath('~', vars), vars.home)
  assert.equal(expandPath('${dataDir}/x.json', vars), path.resolve('/data/dir/x.json'))
  assert.equal(expandPath('sub/x.json', vars), path.resolve('/data/dir/sub/x.json'))
  // an unresolved placeholder is left visible so the stat below fails loudly
  assert.match(expandPath('${notASetting}/x.json', vars), /\$\{notASetting\}/)
  assert.equal(expandPath('', vars), null)
})

test('getPath is total: nothing throws on a missing branch', () => {
  assert.equal(getPath({ a: 1 }, 'a'), 1)
  assert.equal(getPath(null, 'a.b'), undefined)
  assert.equal(getPath({ a: null }, 'a.b'), undefined)
})

test('readTailLines drops the partial first line but keeps whole ones', async () => {
  const dir = await fixtureDir()
  const file = path.join(dir, 'x.jsonl')
  // byte map: 0-9 'a'×10 · 10 '\n' · 11-17 '{"n":1}' · 18 '\n' · 19-25 '{"n":2}' · 26 '\n'
  await writeFile(file, 'aaaaaaaaaa\n{"n":1}\n{"n":2}\n', 'utf8')

  // window starts exactly on a line boundary → both records are whole
  const aligned = await readTailLines(file, 16)
  assert.equal(aligned.truncated, true)
  assert.deepEqual(aligned.lines, ['{"n":1}', '{"n":2}'])

  // window starts mid-record (byte 15) → the fragment is dropped, not parsed
  const cut = await readTailLines(file, 12)
  assert.equal(cut.truncated, true)
  assert.deepEqual(cut.lines, ['{"n":2}'])

  // whole file → nothing is dropped
  const whole = await readTailLines(file, 4096)
  assert.equal(whole.truncated, false)
  assert.deepEqual(whole.lines, ['aaaaaaaaaa', '{"n":1}', '{"n":2}'])
})
