// Patcher: Gets an install folder matching its manifest.
// - A file's good when its size and hash match (MD5, or SHA-256 for Homecoming's newer format).
//   We cache the hashes (with size and mtime) in <install>/.incarnate-launcher.json so a normal
//   start only hashes what changed. Verify hashes everything.
// - Some manifests serve files xz-compressed (compress: 'xz'): The .part is the compressed file,
//   and it gets unpacked and checked once it's all here.
// - Files that moved (an older layout of the same game) get moved into place instead of
//   downloaded again, when the size and hash say it's the same file.
// - Downloads go to <file>.part and resume with HTTP Range, then get checked and moved into
//   place, so a half-done file never gets used.
// - Mirrors: We ping each one first and try the fastest first. If one stays slow (switchSlow)
//   and there's another mirror, we drop it and resume on the next one. 4 downloads at a time,
//   and every finished file reports which mirror it came from ('file').
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const CACHE = '.incarnate-launcher.json';

function hashFile(file, algo) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}
const md5File = (file) => hashFile(file, 'md5');

// Which hash the manifest gives for this file: ['sha256', '...'], ['md5', '...'] or null
const wantHash = (f) => (f.sha256 ? ['sha256', f.sha256] : f.md5 ? ['md5', f.md5] : null);

// Unpack an .xz into dest, hashing on the way. Loaded only when needed
async function unxz(src, dest, algo) {
  const { Readable } = require('stream');
  const { XzReadableStream } = require('xz-decompress');
  const h = algo ? crypto.createHash(algo) : null;
  let size = 0;
  const out = fs.createWriteStream(dest);
  try {
    for await (const chunk of Readable.fromWeb(new XzReadableStream(Readable.toWeb(fs.createReadStream(src))))) {
      if (h) h.update(chunk);
      size += chunk.length;
      if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
    }
  } finally {
    await new Promise((res) => out.end(res));
  }
  return { size, hash: h ? h.digest('hex') : '' };
}

class Patcher extends EventEmitter {
  // opts.switchSlow: Drop a mirror that stays under slowBytes per slowMs (64 KB/s for 30s)
  constructor(dir, manifest, opts = {}) {
    super();
    this.dir = dir;
    this.files = manifest.files;
    this.cancelled = false;
    this.switchSlow = opts.switchSlow !== false;
    this.slowMs = opts.slowMs || 30000;
    this.slowBytes = opts.slowBytes || 64 * 1024 * 30;
    this.rank = new Map(); // mirror host -> ms to answer, Infinity if it never did
  }

  // Ping every mirror at once by asking for 1 byte of a file it has (5s max). Fastest first;
  // ties keep the manifest's order
  async rankMirrors(files) {
    const sample = new Map();
    for (const f of files) for (const u of f.urls) { try { const h = new URL(u).host; if (!sample.has(h)) sample.set(h, u); } catch { /* bad url */ } }
    if (sample.size < 2) return [];
    const timed = await Promise.all([...sample].map(async ([host, url]) => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      const t0 = Date.now();
      try {
        const r = await fetch(url, { signal: ctl.signal, headers: { range: 'bytes=0-0' } });
        const ms = Date.now() - t0;
        ctl.abort(); // we only care that it answered
        return { host, ms: r.ok || r.status === 206 ? ms : Infinity, status: r.status };
      } catch { return { host, ms: Infinity, status: 0 }; } finally { clearTimeout(t); }
    }));
    for (const x of timed) this.rank.set(x.host, x.ms);
    const out = timed.sort((a, b) => a.ms - b.ms);
    this.emit('mirrors', out);
    return out;
  }

  ordered(urls) {
    const ms = (u) => { try { const v = this.rank.get(new URL(u).host); return v === undefined ? 1e9 : v; } catch { return 1e9; } };
    return urls.map((u, i) => ({ u, i })).sort((a, b) => ms(a.u) - ms(b.u) || a.i - b.i).map((x) => x.u);
  }

  cancel() { this.cancelled = true; if (this.ctl) for (const c of this.ctl) c.abort(); }

  async loadCache() {
    try { return JSON.parse(await fsp.readFile(path.join(this.dir, CACHE), 'utf8')); } catch { return {}; }
  }

  async saveCache(cache) {
    try { await fsp.writeFile(path.join(this.dir, CACHE), JSON.stringify(cache)); } catch { /* read-only folder: hash again next time */ }
  }

  // Which files need downloading. verify = hash everything, not just what changed
  async check(verify = false) {
    const cache = verify ? {} : await this.loadCache();
    const need = [];
    let i = 0;
    for (const f of this.files) {
      if (this.cancelled) break;
      this.emit('progress', { phase: 'check', done: i++, total: this.files.length, file: f.name });
      const full = path.join(this.dir, f.name);
      let st;
      try { st = await fsp.stat(full); } catch { need.push(f); continue; }
      if (f.size && st.size !== f.size) { need.push(f); continue; }
      const want = wantHash(f);
      if (!want) continue; // no hash in the manifest, so size will have to do
      const [algo, hash] = want;
      const c = cache[f.name];
      const fresh = c && c.size === st.size && c.mtime === st.mtimeMs;
      let got = fresh ? c[algo] : null;
      if (!got) {
        got = await hashFile(full, algo);
        cache[f.name] = { ...(fresh ? c : {}), size: st.size, mtime: st.mtimeMs, [algo]: got };
      }
      if (got !== hash) need.push(f);
    }
    const left = this.cancelled ? need : await this.reuse(need, cache);
    await this.saveCache(cache);
    return left;
  }

  // Missing files that are already here somewhere else in the folder (same name and size, and
  // the hash matches) get moved into place. That's an older layout of the same game, e.g.
  // Homecoming's piggs/ that are now assets/issue24/. Returns what still needs downloading
  async reuse(need, cache) {
    const missing = need.filter((f) => wantHash(f) && f.size);
    if (!missing.length) return need;
    const wanted = new Set(this.files.map((f) => f.name));
    const byName = new Map();
    const walk = async (rel, depth) => {
      let list;
      try { list = await fsp.readdir(path.join(this.dir, rel), { withFileTypes: true }); } catch { return; }
      for (const e of list) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (depth < 5 && !e.name.startsWith('.')) await walk(r, depth + 1); continue; }
        if (!e.isFile() || e.name.endsWith('.part') || e.name === CACHE || wanted.has(r)) continue;
        const k = e.name.toLowerCase();
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push(r);
      }
    };
    await walk('', 0);
    const left = [];
    for (const f of need) {
      const want = wantHash(f);
      const cands = want && f.size ? byName.get(path.posix.basename(f.name).toLowerCase()) || [] : [];
      let moved = false;
      for (const r of cands) {
        if (this.cancelled) break;
        const from = path.join(this.dir, r);
        try {
          const st = await fsp.stat(from);
          if (st.size !== f.size) continue;
          this.emit('progress', { phase: 'check', done: this.files.length, total: this.files.length, file: `${r} (moving)` });
          if (await hashFile(from, want[0]) !== want[1]) continue;
          const to = path.join(this.dir, f.name);
          await fsp.mkdir(path.dirname(to), { recursive: true });
          await fsp.rename(from, to);
          const st2 = await fsp.stat(to);
          cache[f.name] = { size: st2.size, mtime: st2.mtimeMs, [want[0]]: want[1] };
          delete cache[r];
          cands.splice(cands.indexOf(r), 1);
          this.emit('moved', { from: r, to: f.name });
          moved = true;
          break;
        } catch { /* couldn't, so download it */ }
      }
      if (!moved) left.push(f);
    }
    return left;
  }

  async download(need) {
    const total = need.reduce((n, f) => n + (f.size || 0), 0);
    let done = 0;
    const failed = [];
    const queue = [...need];
    this.ctl = new Set();
    const tick = (file) => this.emit('progress', { phase: 'download', bytes: done, totalBytes: total, file, left: queue.length });
    await this.rankMirrors(need);
    const worker = async () => {
      while (queue.length && !this.cancelled) {
        const f = queue.shift();
        try {
          await this.fetchOne(f, (n) => { done += n; tick(f.name); });
        } catch (e) {
          if (!this.cancelled) failed.push({ name: f.name, error: e.message });
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    const cache = await this.loadCache();
    for (const f of need) {
      if (failed.some((x) => x.name === f.name)) continue;
      const want = wantHash(f);
      try { const st = await fsp.stat(path.join(this.dir, f.name)); cache[f.name] = { size: st.size, mtime: st.mtimeMs, ...(want ? { [want[0]]: want[1] } : {}) }; } catch { /* fine */ }
    }
    await this.saveCache(cache);
    return { failed, cancelled: this.cancelled };
  }

  async fetchOne(f, onBytes) {
    if (!f.urls.length) throw new Error('no download address in the manifest');
    const full = path.join(this.dir, f.name);
    const part = `${full}.part`;
    await fsp.mkdir(path.dirname(full), { recursive: true });
    const urls = this.ordered(f.urls);
    const t0 = Date.now();
    // Bytes already counted for this file, so resuming on another mirror doesn't count the
    // .part twice
    const seen = { n: 0 };
    let lastError;
    const slowOn = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const host = new URL(url).host;
      try {
        const res = await this.fetchFrom(url, part, f, onBytes, seen, this.switchSlow && i < urls.length - 1);
        const want = wantHash(f);
        if (f.compress === 'xz') {
          // Unpack next to it, check that, then swap it in
          const tmp = `${full}.unpack`;
          let got;
          try { got = await unxz(part, tmp, want && want[0]); } catch (e) {
            await fsp.rm(tmp, { force: true }); await fsp.rm(part, { force: true });
            throw new Error(`couldn't unpack it from ${host}: ${e.message}`);
          }
          await fsp.rm(part, { force: true });
          if ((f.size && got.size !== f.size) || (want && got.hash !== want[1])) {
            await fsp.rm(tmp, { force: true });
            throw new Error(`checksum mismatch from ${host}`);
          }
          await fsp.rename(tmp, full);
          // Progress counts the compressed bytes; top it up to the file's real size
          if (f.size > seen.n) { onBytes(f.size - seen.n); seen.n = f.size; }
        } else {
          if (want && await hashFile(part, want[0]) !== want[1]) { await fsp.rm(part, { force: true }); throw new Error(`checksum mismatch from ${host}`); }
          await fsp.rename(part, full);
        }
        this.emit('file', { name: f.name, host, bytes: res.bytes, ms: Date.now() - t0, slowOn });
        return;
      } catch (e) {
        lastError = e;
        if (e.slow) slowOn.push(host);
        if (this.cancelled) throw e;
      }
    }
    throw lastError;
  }

  // canSwitch: There's another mirror to fall back on, so a slow one can be dropped (.part stays)
  async fetchFrom(url, part, f, onBytes, seen, canSwitch) {
    let have = 0;
    try { have = (await fsp.stat(part)).size; } catch { /* new */ }
    // f.size is the unpacked size, so these only work for files that aren't compressed
    const plain = !f.compress;
    if (plain && f.size && have > f.size) { await fsp.rm(part, { force: true }); have = 0; }
    if (plain && f.size && have === f.size) return { bytes: 0 }; // already done last time, just needs checking
    const ctl = new AbortController();
    this.ctl.add(ctl);
    let slow = false;
    let got = 0;
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: have ? { range: `bytes=${have}-` } : {} });
      if (r.status === 416 && have) { r.body && r.body.cancel().catch(() => {}); return { bytes: 0 }; } // nothing past what we have: it's all here
      if (r.status === 200 && have) { have = 0; } // server ignored the Range header, start over
      else if (!(r.status === 200 || r.status === 206)) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
      if (have > seen.n) { onBytes(have - seen.n); seen.n = have; }
      const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
      // Slow = under slowBytes in a slowMs window
      let winStart = Date.now();
      let winBytes = 0;
      const watch = canSwitch ? setInterval(() => {
        if (Date.now() - winStart < this.slowMs) return;
        if (winBytes < this.slowBytes) { slow = true; ctl.abort(); }
        winStart = Date.now(); winBytes = 0;
      }, Math.min(1000, this.slowMs / 4)) : null;
      try {
        for await (const chunk of r.body) {
          if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
          got += chunk.length; winBytes += chunk.length;
          if (have + got > seen.n) { onBytes(have + got - seen.n); seen.n = have + got; }
        }
      } finally {
        if (watch) clearInterval(watch);
        await new Promise((res) => out.end(res));
      }
      return { bytes: got };
    } catch (e) {
      if (slow && !this.cancelled) {
        const err = new Error(`slow from ${new URL(url).host}: switched mirrors`);
        err.slow = true;
        throw err;
      }
      throw e;
    } finally {
      this.ctl.delete(ctl);
    }
  }
}

// ---- Old files: Ones this launcher put in the folder that the manifest doesn't list anymore ----
// Only files in our checksum cache count (we downloaded or checked them for this server), plus
// leftover .part / .unpack downloads. Anything else in the folder (screenshots, costumes,
// settings, files from other launchers) is never listed, so it can't be removed by accident.
async function oldFiles(dir, manifest) {
  const keep = new Set(manifest.files.map((f) => f.name));
  let cache = {};
  try { cache = JSON.parse(await fsp.readFile(path.join(dir, CACHE), 'utf8')); } catch { /* none yet */ }
  const out = new Map();
  const add = async (rel) => {
    const safe = require('./manifest').safeRelative(rel);
    if (!safe || out.has(safe)) return;
    try { const st = await fsp.stat(path.join(dir, safe)); if (st.isFile()) out.set(safe, st.size); } catch { /* not there */ }
  };
  for (const name of Object.keys(cache)) if (!keep.has(name)) await add(name);
  const walk = async (rel, depth) => {
    let list;
    try { list = await fsp.readdir(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (depth < 5 && !e.name.startsWith('.')) await walk(r, depth + 1); } else if (/\.(part|unpack)$/.test(e.name)) await add(r);
    }
  };
  await walk('', 0);
  return [...out].map(([name, size]) => ({ name, size })).sort((a, b) => a.name.localeCompare(b.name));
}

// Remove the files picked from oldFiles() (only those), then any folders that end up empty
async function removeOldFiles(dir, manifest, names) {
  const allowed = new Map((await oldFiles(dir, manifest)).map((f) => [f.name, f]));
  let cache = {};
  try { cache = JSON.parse(await fsp.readFile(path.join(dir, CACHE), 'utf8')); } catch { /* none */ }
  const removed = [];
  const failed = [];
  const dirs = new Set();
  for (const n of names) {
    if (!allowed.has(n)) { failed.push({ name: n, error: 'not an old file of this server' }); continue; }
    try {
      await fsp.rm(path.join(dir, n));
      delete cache[n];
      removed.push(allowed.get(n));
      for (let d = path.posix.dirname(n); d && d !== '.'; d = path.posix.dirname(d)) dirs.add(d);
    } catch (e) { failed.push({ name: n, error: e.message }); }
  }
  // Deepest first, and only if empty (rmdir refuses otherwise)
  for (const d of [...dirs].sort((a, b) => b.split('/').length - a.split('/').length)) {
    try { await fsp.rmdir(path.join(dir, d)); } catch { /* not empty, keep it */ }
  }
  try { await fsp.writeFile(path.join(dir, CACHE), JSON.stringify(cache)); } catch { /* fine */ }
  return { removed, failed, bytes: removed.reduce((t, f) => t + f.size, 0) };
}

module.exports = { Patcher, md5File, hashFile, oldFiles, removeOldFiles, CACHE };
