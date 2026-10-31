// Wine for Linux players who don't have Wine or Proton: The launcher downloads a self-contained
// build (Kron4ek's Wine-Builds on GitHub) into its own folder. No password, nothing system-wide,
// and it runs the 64-bit game without any 32-bit libraries (the "wow64" builds).
//
// It takes the newest *stable* Wine (the x.0 releases, like 11.0), not the newest development one:
// dev builds come every two weeks and sometimes break (11.20 crashed on start on some systems).
// The download is checked against the SHA-256 GitHub publishes for it, resumes if cut off, and
// shows speed and time left like a game download (it goes through lib/patcher.js).
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { Patcher } = require('./patcher');

const REPO = 'Kron4ek/Wine-Builds';

// Can we offer it here? Only Linux on x64: on ARM there's no x86 Wine that runs without an emulator
function supported(platform = process.platform, arch = process.arch) {
  return platform === 'linux' && arch === 'x64';
}

// The newest stable release's wow64 build: { version, name, url, size, sha256, page }
async function findStable({ timeoutMs = 15000 } = {}) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'IncarnateLauncher' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`GitHub said HTTP ${r.status}`);
  const list = await r.json();
  const stable = list.filter((x) => !x.prerelease && !x.draft && /^\d+\.0$/.test(x.tag_name))
    .sort((a, b) => Number(b.tag_name.split('.')[0]) - Number(a.tag_name.split('.')[0]));
  for (const rel of stable) {
    const name = `wine-${rel.tag_name}-amd64-wow64.tar.xz`;
    const a = (rel.assets || []).find((x) => x.name === name);
    const sha = a && /^sha256:([0-9a-f]{64})$/.exec(a.digest || '');
    if (a && sha) return { version: rel.tag_name, name, url: a.browser_download_url, size: a.size, sha256: sha[1], page: rel.html_url };
  }
  throw new Error('no stable Wine build with a checksum found');
}

// What's installed: the folders under dir that have bin/wine, newest version first
function installed(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.map((n) => ({ n, m: /^wine-(\d+)\.(\d+)/.exec(n) }))
    .filter((x) => x.m && fs.existsSync(path.join(dir, x.n, 'bin', 'wine')))
    .sort((a, b) => Number(b.m[1]) - Number(a.m[1]) || Number(b.m[2]) - Number(a.m[2]))
    .map((x) => ({ version: `${x.m[1]}.${x.m[2]}`, folder: path.join(dir, x.n), wine: path.join(dir, x.n, 'bin', 'wine') }));
}

// The runner Settings and lib/launch.js use for it. Its own prefix, so it never touches ~/.wine
function runnerFor(w, prefix) {
  return { kind: 'wine', name: `Wine ${w.version} (installed by the launcher)`, wine: w.wine, prefix, managed: true };
}

// Unpack a .tar.xz with xz-decompress piped into tar (every Linux has tar; not every one has xz)
async function untarXz(file, dest) {
  const { Readable } = require('stream');
  const { XzReadableStream } = require('xz-decompress');
  await fsp.mkdir(dest, { recursive: true });
  const tar = spawn('tar', ['-x', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  tar.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve, reject) => {
    tar.on('error', reject);
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar: ${err.trim() || `exit code ${code}`}`))));
  });
  try {
    for await (const chunk of Readable.fromWeb(new XzReadableStream(Readable.toWeb(fs.createReadStream(file))))) {
      if (!tar.stdin.write(chunk)) await new Promise((res) => tar.stdin.once('drain', res));
    }
  } finally {
    tar.stdin.end();
  }
  await done;
}

// Download, check, unpack, and drop older versions. Emits 'progress' like a game download
// ({ phase: 'download', bytes, totalBytes } then { phase: 'unpack' }), and 'mirrors'/'file'
class WineInstall extends EventEmitter {
  constructor(dir) { super(); this.dir = dir; this.patcher = null; this.cancelled = false; }
  cancel() { this.cancelled = true; if (this.patcher) this.patcher.cancel(); }
  async run(build) {
    const dl = path.join(this.dir, '.download');
    await fsp.mkdir(dl, { recursive: true });
    const p = this.patcher = new Patcher(dl, { files: [{ name: build.name, size: build.size, sha256: build.sha256, md5: '', compress: '', urls: [build.url] }] });
    p.on('progress', (d) => this.emit('progress', d));
    const need = await p.check();
    if (need.length) {
      const r = await p.download(need);
      if (r.cancelled || this.cancelled) return { cancelled: true };
      if (r.failed.length) throw new Error(r.failed[0].error);
    }
    this.emit('progress', { phase: 'unpack' });
    const tmp = path.join(this.dir, `.unpack-${process.pid}`);
    await fsp.rm(tmp, { recursive: true, force: true });
    await untarXz(path.join(dl, build.name), tmp);
    // The archive holds one folder, wine-11.0-amd64-wow64/
    const top = (await fsp.readdir(tmp)).find((n) => fs.existsSync(path.join(tmp, n, 'bin', 'wine')));
    if (!top) throw new Error("the download didn't have bin/wine in it");
    const final = path.join(this.dir, top);
    await fsp.rm(final, { recursive: true, force: true });
    await fsp.rename(path.join(tmp, top), final);
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.rm(dl, { recursive: true, force: true });
    // Older ones go, now that this one's in place
    for (const w of installed(this.dir)) if (w.folder !== final) await fsp.rm(w.folder, { recursive: true, force: true });
    return installed(this.dir).find((w) => w.folder === final);
  }
}

// Remove everything the launcher installed (Settings)
async function removeAll(dir) { await fsp.rm(dir, { recursive: true, force: true }); }

module.exports = { supported, findStable, installed, runnerFor, untarXz, WineInstall, removeAll, REPO };
