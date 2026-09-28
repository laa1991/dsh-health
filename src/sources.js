/**
 * sources.js — the read side: "where does this reading come from?"
 *
 * Every reader returns exactly one of two shapes:
 *
 *   { known: true,  value, unit?, at?, detail? }   — we saw something
 *   { known: false, reason }                       — we did not
 *
 * Readers never throw for an unreadable world. A missing file, a truncated
 * JSON line, a refused connection and an empty directory are all *observations
 * about our own instruments*, not exceptions: they come back as `known: false`
 * and the criteria layer turns that into `unknown` (never `ok`, never 0).
 *
 * Large files are read from the tail only. A readout that has to load a 1 GB
 * session log is a readout that gets disabled the first time it is slow — and
 * a disabled readout measures nothing at all.
 */

import { open, stat, readdir, access, readFile } from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const DEFAULT_TAIL_BYTES = 256 * 1024;
export const DEFAULT_HTTP_TIMEOUT_MS = 5000;

/** Placeholders a path may use. Kept small on purpose: every placeholder is a
 *  way for a spec to mean something different than the reader thinks. */
export function makeVars(vars = {}) {
  return {
    home: os.homedir(),
    dataDir: undefined,
    ...vars,
  };
}

export function expandPath(input, vars) {
  if (typeof input !== 'string' || input.trim() === '') return null;
  let p = input.trim();
  if (p === '~') p = vars.home;
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(vars.home, p.slice(2));
  p = p.replace(/\$\{(\w+)\}/g, (match, key) => {
    const v = vars[key];
    if (v === undefined || v === null || v === '') return match; // leave it visibly unresolved
    return String(v);
  });
  if (p.includes('${')) return p; // unresolved placeholder: the stat below will fail loudly, as `known:false`
  if (!path.isAbsolute(p) && vars.dataDir) p = path.join(vars.dataDir, p);
  return path.resolve(p);
}

function known(value, extra = {}) {
  return { known: true, value, ...extra };
}

function unknown(reason) {
  return { known: false, reason };
}

function iso(mtimeMs) {
  return new Date(mtimeMs).toISOString();
}

/** Read the last `maxBytes` of a file and split it into lines.
 *
 *  A window that starts mid-file may start mid-record. The first line is
 *  dropped only when the byte immediately before the window is not a line
 *  break — i.e. only when that line really is a fragment. Dropping it blindly
 *  would turn "one whole record in the window" into "no record at all", which
 *  is the one thing this module must never do: report `unknown` about
 *  something it actually saw. */
export async function readTailLines(file, maxBytes = DEFAULT_TAIL_BYTES) {
  const st = await stat(file);
  const start = Math.max(0, st.size - maxBytes);
  const length = st.size - start;
  const handle = await open(file, 'r');
  try {
    const buf = Buffer.alloc(Number(length));
    await handle.read(buf, 0, Number(length), Number(start));
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (start > 0 && lines.length > 0 && !(await byteBeforeIsLineBreak(handle, start))) lines.shift();
    return { lines, truncated: start > 0, sizeBytes: st.size, mtimeMs: st.mtimeMs };
  } finally {
    await handle.close();
  }
}

async function byteBeforeIsLineBreak(handle, start) {
  if (start <= 0) return true;
  const prev = Buffer.alloc(1);
  await handle.read(prev, 0, 1, start - 1);
  return prev[0] === 0x0a || prev[0] === 0x0d;
}

/** Dotted access: `a.b.0.c`. Returns undefined rather than throwing, so a
 *  field that moved shows up as `unknown` instead of as a crash. */
export function getPath(root, field) {
  if (typeof field !== 'string' || field.trim() === '') return root;
  let cur = root;
  for (const seg of field.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    // `.length` works on arrays and strings because "how many items" is a
    // reading shape of its own (remedies applied, files pending, entries open).
    // Without it, `remedies: []` is unreadable and every empty list looks like
    // a failed comparison rather than an empty list.
    if (seg === 'length' && (Array.isArray(cur) || typeof cur === 'string')) {
      cur = cur.length;
      continue;
    }
    cur = Array.isArray(cur) && /^\d+$/.test(seg) ? cur[Number(seg)] : cur[seg];
  }
  return cur;
}

async function exists(file) {
  try {
    await access(file, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

// --- readers ----------------------------------------------------------------

export const READERS = {
  /** Seconds since the file was last written. The bread-and-butter "is it still alive" reading. */
  'file-age-seconds': async (source, vars) => {
    const file = expandPath(source.path, vars);
    if (!file) return unknown('no path given');
    try {
      const st = await stat(file);
      const ageSeconds = Math.max(0, Math.round((Date.now() - st.mtimeMs) / 1000));
      return known(ageSeconds, { unit: 's', at: iso(st.mtimeMs), detail: file });
    } catch (err) {
      return unknown(`stat failed: ${err.code || err.message}`);
    }
  },

  'file-size': async (source, vars) => {
    const file = expandPath(source.path, vars);
    if (!file) return unknown('no path given');
    try {
      const st = await stat(file);
      return known(Number(st.size), { unit: 'B', at: iso(st.mtimeMs), detail: file });
    } catch (err) {
      return unknown(`stat failed: ${err.code || err.message}`);
    }
  },

  /** Existence is a real boolean observation: `false` is knowledge, not ignorance. */
  'file-exists': async (source, vars) => {
    const file = expandPath(source.path, vars);
    if (!file) return unknown('no path given');
    return known(await exists(file), { detail: file });
  },

  'json-field': async (source, vars) => {
    const file = expandPath(source.path, vars);
    if (!file) return unknown('no path given');
    try {
      const raw = await readFile(file, 'utf8');
      const data = JSON.parse(raw);
      const value = getPath(data, source.field);
      if (value === undefined) return unknown(`field "${source.field}" absent`);
      return known(value, { unit: source.unit, detail: file });
    } catch (err) {
      return unknown(`json read failed: ${err.code || err.message}`);
    }
  },

  /** Last parseable line of a JSONL file, then a dotted field inside it.
   *  Skips trailing half-written lines and non-JSON lines instead of giving up:
   *  a log that is being appended to right now is the normal case, not an error. */
  'jsonl-last-field': async (source, vars) => {
    const file = expandPath(source.path, vars);
    if (!file) return unknown('no path given');
    try {
      const { lines, truncated, mtimeMs } = await readTailLines(file, source.maxBytes || DEFAULT_TAIL_BYTES);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        let parsed;
        try {
          parsed = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        const value = getPath(parsed, source.field);
        if (value === undefined) return unknown(`field "${source.field}" absent in last line`);
        return known(value, {
          unit: source.unit,
          at: iso(mtimeMs),
          detail: `${file}${truncated ? ' (tail)' : ''}`,
        });
      }
      return unknown('no parseable JSON line in tail');
    } catch (err) {
      return unknown(`jsonl read failed: ${err.code || err.message}`);
    }
  },

  /** Occurrences of a regex in the tail window. Reports the window size in
   *  `detail` on purpose: a count over an unknown window is not a count. */
  'text-count': async (source, vars) => {
    const file = expandPath(source.path, vars);
    if (!file) return unknown('no path given');
    if (typeof source.pattern !== 'string' || source.pattern === '') return unknown('no pattern given');
    let re;
    try {
      re = new RegExp(source.pattern, source.flags || 'g');
    } catch (err) {
      return unknown(`bad pattern: ${err.message}`);
    }
    try {
      const maxBytes = source.maxBytes || DEFAULT_TAIL_BYTES;
      const { lines, truncated, sizeBytes, mtimeMs } = await readTailLines(file, maxBytes);
      const hay = lines.join('\n');
      const matches = hay.match(re);
      return known(matches ? matches.length : 0, {
        at: iso(mtimeMs),
        detail: `${file} — counted over ${truncated ? `last ${maxBytes} B` : `whole file (${sizeBytes} B)`}`,
      });
    } catch (err) {
      return unknown(`text read failed: ${err.code || err.message}`);
    }
  },

  /** Files in a directory, optionally filtered by suffix. */
  'dir-count': async (source, vars) => {
    const dir = expandPath(source.path, vars);
    if (!dir) return unknown('no path given');
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const files = entries.filter((e) => e.isFile());
      const matching = source.suffix ? files.filter((e) => e.name.endsWith(source.suffix)) : files;
      return known(matching.length, { detail: `${dir}${source.suffix ? ` *${source.suffix}` : ''}` });
    } catch (err) {
      return unknown(`readdir failed: ${err.code || err.message}`);
    }
  },

  /** Read a field from an HTTP JSON endpoint (another process, another port).
   *  Always timed out, never retried here: retrying is a policy, and policy
   *  belongs to the caller, not to the reading. */
  'http-json-field': async (source, vars) => {
    if (typeof source.url !== 'string' || source.url === '') return unknown('no url given');
    const url = source.url.replace(/\$\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));
    const timeoutMs = source.timeoutMs || DEFAULT_HTTP_TIMEOUT_MS;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return unknown(`HTTP ${res.status}`);
      const data = await res.json();
      const value = getPath(data, source.field);
      if (value === undefined) return unknown(`field "${source.field}" absent`);
      return known(value, { unit: source.unit, at: new Date().toISOString(), detail: `${url} (HTTP ${res.status})` });
    } catch (err) {
      const why = err && err.name === 'TimeoutError' ? `timeout after ${timeoutMs} ms` : `${err && (err.code || err.name || err.message)}`;
      return unknown(`fetch failed: ${why}`);
    }
  },
};

export function listSourceKinds() {
  return Object.keys(READERS);
}

/**
 * Dispatch one source declaration to its reader.
 * An unknown `kind` is an unreadable reading, not a crash — a typo in a spec
 * must not take the whole readout down with it.
 */
export async function readSource(source, vars) {
  if (!source || typeof source !== 'object') return unknown('no source declared');
  const reader = READERS[source.kind];
  if (!reader) return unknown(`unknown source kind "${source.kind}" (have: ${listSourceKinds().join(', ')})`);
  try {
    return await reader(source, vars);
  } catch (err) {
    // Readers are written not to throw; this is the belt to their braces.
    return unknown(`reader threw: ${err && (err.code || err.message)}`);
  }
}
