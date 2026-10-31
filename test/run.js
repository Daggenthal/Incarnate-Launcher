// Tests, no Electron needed: npm test
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { parseManifest, safeRelative, splitParams, loginTarget } = require('../lib/manifest');
const { Patcher, md5File } = require('../lib/patcher');
const { checkHealth, tcpProbe } = require('../lib/health');

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const green = (s) => (color ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s) => (color ? `\x1b[31m${s}\x1b[0m` : s);
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(green(`pass  ${name}`)); } catch (e) { failed++; console.log(red(`FAIL  ${name}: ${e.stack}`)); }
}
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

(async () => {
  await test('manifest: Homecoming-style profiles, files, links', () => {
    const m = parseManifest(`<?xml version="1.0"?>
      <manifest>
        <label>Test &amp; Shard</label>
        <!-- a comment -->
        <profiles>
          <launch exec="bin\\win64\\game.exe" params="-patchdir live -auth 10.0.0.5" order="1">64-bit</launch>
          <launch exec="game32.exe" params='-auth 10.0.0.5' order="0">32-bit</launch>
        </profiles>
        <filelist>
          <file name="piggs\\bin.pigg" size="3" md5="ABC"><url>https://a.example/bin.pigg</url><url>http://b.example/bin.pigg</url></file>
          <file name="../escape.txt" size="1" md5="x"><url>https://a.example/e</url></file>
          <file name="C:\\Windows\\evil.dll" size="1"><url>https://a.example/e</url></file>
        </filelist>
        <webpage>https://example.org</webpage>
        <forums><forum name="Discord" url="https://discord.example"/></forums>
      </manifest>`);
    assert.strictEqual(m.label, 'Test & Shard');
    assert.deepStrictEqual(m.profiles.map((p) => p.name), ['32-bit', '64-bit']);
    assert.strictEqual(m.profiles[1].exec, 'bin\\win64\\game.exe');
    assert.strictEqual(m.files.length, 1, 'paths outside the install folder are dropped');
    assert.strictEqual(m.files[0].name, 'piggs/bin.pigg');
    assert.strictEqual(m.files[0].md5, 'abc');
    assert.strictEqual(m.files[0].urls.length, 2);
    assert.strictEqual(m.forums[0].name, 'Discord');
  });

  await test('safe paths', () => {
    assert.strictEqual(safeRelative('a/b/../c.txt'), 'a/c.txt');
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', '\\\\server\\x', '..']) assert.strictEqual(safeRelative(bad), '', bad);
  });

  await test('params and login target', () => {
    assert.deepStrictEqual(splitParams('-a "b c" d'), ['-a', 'b c', 'd']);
    assert.deepStrictEqual(loginTarget('-patchdir live -auth host.example'), { kind: 'auth', host: 'host.example', port: 2106 });
    assert.strictEqual(loginTarget('-db 127.0.0.1').kind, 'db');
    assert.strictEqual(loginTarget('-console'), null);
  });

  await test('patcher: download, mirror fallback, resume, checksum, cache', async () => {
    const good = Buffer.from('x'.repeat(200000));
    const small = Buffer.from('hello');
    let hits = 0;
    let rangeSeen = null;
    const srv = http.createServer((req, res) => {
      hits++;
      if (req.url === '/broken') { res.writeHead(500); res.end(); return; }
      if (req.url === '/wrong') { res.writeHead(200); res.end('nope!'); return; }
      const body = req.url === '/big' ? good : small;
      const m = /bytes=(\d+)-/.exec(req.headers.range || '');
      if (m) { rangeSeen = Number(m[1]); res.writeHead(206); res.end(body.subarray(Number(m[1]))); return; }
      res.writeHead(200); res.end(body);
    });
    const port = await listen(srv);
    const u = (p) => `http://127.0.0.1:${port}${p}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-'));
    const manifest = { files: [
      { name: 'piggs/big.pigg', size: good.length, md5: md5(good), urls: [u('/broken'), u('/big')] },
      { name: 'small.txt', size: small.length, md5: md5(small), urls: [u('/small')] },
      { name: 'bad.txt', size: 5, md5: md5(small), urls: [u('/wrong')] },
    ] };
    // Half-done download from before: Should resume, not start over
    fs.mkdirSync(path.join(dir, 'piggs'));
    fs.writeFileSync(path.join(dir, 'piggs/big.pigg.part'), good.subarray(0, 50000));
    const p = new Patcher(dir, manifest);
    const need = await p.check();
    assert.strictEqual(need.length, 3);
    const r = await p.download(need);
    assert.strictEqual(rangeSeen, 50000, 'resumed from the partial file');
    assert.deepStrictEqual(r.failed.map((f) => f.name), ['bad.txt'], 'a checksum mismatch fails that file only');
    assert.ok(/checksum/.test(r.failed[0].error));
    assert.strictEqual(await md5File(path.join(dir, 'piggs/big.pigg')), md5(good));
    assert.ok(!fs.existsSync(path.join(dir, 'bad.txt')), 'a bad download never replaces the file');
    // Second run: Good files come from the cache, nothing to do
    hits = 0;
    const again = await new Patcher(dir, manifest).check();
    assert.deepStrictEqual(again.map((f) => f.name), ['bad.txt']);
    assert.strictEqual(hits, 0);
    // Same size, different content: Verify should catch it since it hashes everything
    fs.writeFileSync(path.join(dir, 'small.txt'), 'HELLO');
    const touched = await new Patcher(dir, manifest).check(true);
    assert.ok(touched.some((f) => f.name === 'small.txt'));
    srv.close();
  });

  await test('patcher: fastest mirror first, a slow one dropped and resumed elsewhere, which mirror said', async () => {
    const body = Buffer.alloc(400000, 7);
    // "slow" answers late and trickles, "fast" answers right away
    const mk = (delay, trickle) => http.createServer((req, res) => {
      const m = /bytes=(\d+)-/.exec(req.headers.range || '');
      const from = m ? Number(m[1]) : 0;
      setTimeout(() => {
        if (req.headers.range === 'bytes=0-0') { res.writeHead(206); res.end(body.subarray(0, 1)); return; }
        res.writeHead(m ? 206 : 200);
        if (!trickle) { res.end(body.subarray(from)); return; }
        let at = from;
        const t = setInterval(() => { if (at >= body.length || res.destroyed) { clearInterval(t); res.end(); return; } res.write(body.subarray(at, at + 1000)); at += 1000; }, 50);
        res.on('close', () => clearInterval(t));
      }, delay);
    });
    const slowSrv = mk(150, true);
    const fastSrv = mk(0, false);
    const sp = await listen(slowSrv);
    const fp = await listen(fastSrv);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-'));
    // Slow is listed first, ranking should flip them
    const f1 = { name: 'a.pigg', size: body.length, md5: md5(body), urls: [`http://127.0.0.1:${sp}/a`, `http://localhost:${fp}/a`] };
    const p = new Patcher(dir, { files: [f1] });
    const files = [];
    p.on('file', (x) => files.push(x));
    await p.check();
    const r = await p.download([f1]);
    assert.deepStrictEqual(r.failed, []);
    assert.strictEqual(files[0].host, `localhost:${fp}`, 'the faster mirror was used first');
    // Force slow to the front by hand: It should get dropped for the fast one
    fs.rmSync(path.join(dir, 'a.pigg'));
    const p2 = new Patcher(dir, { files: [f1] }, { slowMs: 300, slowBytes: 200000 });
    p2.rank.set(`127.0.0.1:${sp}`, 1); p2.rank.set(`localhost:${fp}`, 2);
    p2.rankMirrors = async () => []; // keep that order
    const got = [];
    p2.on('file', (x) => got.push(x));
    await p2.check();
    const r2 = await p2.download([f1]);
    assert.deepStrictEqual(r2.failed, []);
    assert.strictEqual(got[0].host, `localhost:${fp}`);
    assert.deepStrictEqual(got[0].slowOn, [`127.0.0.1:${sp}`]);
    assert.strictEqual(await md5File(path.join(dir, 'a.pigg')), md5(body));
    slowSrv.close(); fastSrv.close();
  });

  await test('runners: what runs the game is found (Proton, GE-Proton, Wine on the PATH)', () => {
    const { detectRunners } = require('../lib/runners');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-home-'));
    const mk = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 }); };
    mk(path.join(home, '.local/share/Steam/steamapps/common/Proton 9.0/proton'));
    mk(path.join(home, '.local/share/Steam/compatibilitytools.d/GE-Proton9-20/proton'));
    mk(path.join(home, 'bin/wine'));
    const found = detectRunners({ platform: 'linux', home, env: { PATH: path.join(home, 'bin') } });
    assert.deepStrictEqual(found.map((r) => r.kind), ['wine', 'proton', 'proton']);
    assert.ok(found.some((r) => /GE-Proton9-20/.test(r.name)));
    assert.deepStrictEqual(detectRunners({ platform: 'win32' }).map((r) => r.kind), ['native']);
    assert.deepStrictEqual(detectRunners({ platform: 'linux', home: path.join(home, 'none'), env: { PATH: '' } }), []);
  });

  await test('health: login port, unknown', async () => {
    const tcp = net.createServer((s) => s.end());
    const tport = await listen(tcp);
    assert.strictEqual((await tcpProbe('127.0.0.1', tport)).up, true);
    tcp.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual((await tcpProbe('127.0.0.1', tport, 1000)).up, false);
    const none = await checkHealth({ status: '', profiles: [{ params: '-db 127.0.0.1' }] });
    assert.strictEqual(none.up, null);
  });

  // Homecoming's newer format: A profile -> a package -> packages with their own folders, files
  // by SHA-256, served xz-compressed. The two payloads are tiny real .xz files
  const XZ = {
    a: { size: 6200, sha256: '31ccf968287982c39f962973b3f0ee72ba76b1c012eb5cd0081492dc0293f76d', xz: '/Td6WFoAAATm1rRGAgAhARwAAAAQz1jM4Bg3AEFdADGaSvCEW4DQA1dUXda/iz5sMGVZwWbbyEcwHxSv4S2wcmPOxiDX+q0MW5PBdVD+RGuYjne8BWUD7+bZW2U7u/UAAAAAAKE156k7MQhjAAFduDAAAACAdNmjscRn+wIAAAAABFla' },
    b: { size: 15600, sha256: 'a1f1bc69be5083544f395fbc3973a85347429c7c15f554f908d2c43114134179', xz: '/Td6WFoAAATm1rRGAgAhARwAAAAQz1jM4DzvAE9dADSc7OpmUirQXguTQtURkioGd6J2Xhyd9zq9nMjFahqQNHRfRTdHWEE2q8GOt9T1swO//Mz7SqcJ2OOZmYY1H65D0Jav256hdcu1yZn7TAAAAHzdEAsWUZKfAAFr8HkAAAAPlGX/scRn+wIAAAAABFla' },
  };
  const pkgServer = async () => {
    const wrap = (o) => `-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n-----BEGIN SIGNATURE-----\nAAAA\n-----END SIGNATURE-----\n-----BEGIN CONTENT-----\n${JSON.stringify(o, null, 4)}\n-----END CONTENT-----\n`;
    let base = '';
    const hits = {};
    const file = (name, k) => ({ name, size: XZ[k].size, sha256: XZ[k].sha256, sources: { web: [
      { url: `${base}/bad/${k}.xz`, priority: 30, compress: 'xz' },
      { url: `${base}/content/${k}.xz`, priority: 10, compress: 'xz' }] } });
    const docs = {
      '/profile/live.json': () => wrap({ id: 'live', name: 'Homecoming', package: 'hc_live', packageroot: '/', packageurl: `${base}/pkg/hc_live.json`,
        news: 'https://news.example/live', status: 'https://status.example/live',
        args: ['-profile', '${string:profile}', '-auth', '10.0.0.9', '-assetpath', 'assets/issue24;assets/${string:profile}'],
        arch: [{ id: 'win32', exe: '/bin/win32/live/cityofheroes.exe' }, { id: 'win64', exe: '/bin/win64/live/cityofheroes.exe' }] }),
      '/pkg/hc_live.json': () => wrap({ id: 'hc_live', version: '1.2', displayver: 'Issue 28', dependencies: [
        { name: 'Bin', root: '/bin/win64/live', alternates: [{ id: 'bin', urls: [`${base}/missing.json`, `${base}/pkg/bin.json`] }] },
        { name: 'Piggs', root: '/assets/issue24', alternates: [{ id: 'piggs', urls: [`${base}/pkg/piggs.json`] }] }] }),
      '/pkg/bin.json': () => wrap({ id: 'bin', files: [file('cityofheroes.exe', 'a'), { name: '../../../../escape.dll', size: 1, sha256: 'x', sources: { web: [{ url: `${base}/x`, priority: 1 }] } }] }),
      '/pkg/piggs.json': () => JSON.stringify({ id: 'piggs', files: [file('bin.pigg', 'b')] }), // plain JSON works too
    };
    const srv = http.createServer((req, res) => {
      hits[req.url] = (hits[req.url] || 0) + 1;
      if (docs[req.url]) { res.end(docs[req.url]()); return; }
      const m = /^\/content\/(\w)\.xz$/.exec(req.url);
      if (!m) { res.statusCode = 404; res.end(); return; }
      const body = Buffer.from(XZ[m[1]].xz, 'base64');
      const r = /bytes=(\d+)-/.exec(req.headers.range || '');
      const from = r ? Number(r[1]) : 0;
      if (from >= body.length) { res.statusCode = 416; res.end(); return; }
      res.statusCode = from ? 206 : 200;
      res.end(body.subarray(from));
    });
    base = `http://127.0.0.1:${await listen(srv)}`;
    const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); };
    return { srv, base, hits, get };
  };

  await test('pkg manifest: profile, packages and their folders, launch line, mirrors by priority', async () => {
    const { parsePkgManifest, isPkgManifest } = require('../lib/pkgmanifest');
    const { srv, base, get } = await pkgServer();
    const text = await get(`${base}/profile/live.json`);
    assert.ok(isPkgManifest(text) && !isPkgManifest('<?xml version="1.0"?><manifest/>'));
    const m = await parsePkgManifest(text, `${base}/profile/live.json`, get);
    assert.strictEqual(m.label, 'Homecoming');
    assert.deepStrictEqual(m.files.map((f) => f.name).sort(), ['assets/issue24/bin.pigg', 'bin/win64/live/cityofheroes.exe']);
    const exe = m.files.find((f) => f.name.endsWith('.exe'));
    assert.strictEqual(exe.compress, 'xz');
    assert.ok(exe.urls[0].includes('/content/'), 'lowest priority number first');
    assert.strictEqual(m.profiles[0].exec, 'bin/win64/live/cityofheroes.exe', '64-bit first');
    assert.deepStrictEqual(splitParams(m.profiles[0].params), ['-profile', 'live', '-auth', '10.0.0.9', '-assetpath', 'assets/issue24;assets/live']);
    assert.strictEqual(m.version, 'Issue 28');
    assert.strictEqual(m.statusApi, 'https://status.example/live');
    assert.notStrictEqual(m.signed, true, 'a made-up signature never checks out');
    srv.close();
  });

  await test('pkg manifest: xz downloads unpacked and checked, resumed, old layout moved not downloaded', async () => {
    const { parsePkgManifest } = require('../lib/pkgmanifest');
    const { srv, base, hits, get } = await pkgServer();
    const m = await parsePkgManifest(await get(`${base}/profile/live.json`), '', get);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-'));
    // An install in the old layout: the pigg sits in piggs/, the new list wants assets/issue24/
    fs.mkdirSync(path.join(dir, 'piggs'));
    fs.writeFileSync(path.join(dir, 'piggs', 'bin.pigg'), Buffer.from('issue24 pigg pretend data '.repeat(600)));
    // A half-downloaded .xz from before: resumes from where it stopped
    const exeXz = Buffer.from(XZ.a.xz, 'base64');
    fs.mkdirSync(path.join(dir, 'bin/win64/live'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bin/win64/live/cityofheroes.exe.part'), exeXz.subarray(0, 40));
    const p = new Patcher(dir, m);
    const moved = [];
    p.on('moved', (x) => moved.push(x));
    const need = await p.check();
    assert.deepStrictEqual(moved, [{ from: 'piggs/bin.pigg', to: 'assets/issue24/bin.pigg' }]);
    assert.deepStrictEqual(need.map((f) => f.name), ['bin/win64/live/cityofheroes.exe']);
    let last = null;
    p.on('progress', (d) => { if (d.phase === 'download') last = d; });
    const r = await p.download(need);
    assert.deepStrictEqual(r.failed, []);
    const exe = fs.readFileSync(path.join(dir, 'bin/win64/live/cityofheroes.exe'));
    assert.strictEqual(crypto.createHash('sha256').update(exe).digest('hex'), XZ.a.sha256);
    assert.ok(!fs.existsSync(path.join(dir, 'bin/win64/live/cityofheroes.exe.part')) && !fs.existsSync(path.join(dir, 'bin/win64/live/cityofheroes.exe.unpack')));
    assert.strictEqual(last.bytes, last.totalBytes, 'progress ends at 100%');
    assert.ok(!fs.existsSync(path.join(dir, 'piggs', 'bin.pigg')));
    // Everything's good now, from the cache
    assert.deepStrictEqual(await new Patcher(dir, m).check(), []);
    // A file that's wrong gets caught by its SHA-256 on Verify and downloaded again
    fs.writeFileSync(path.join(dir, 'assets/issue24/bin.pigg'), Buffer.alloc(XZ.b.size, 1));
    const p2 = new Patcher(dir, m);
    assert.deepStrictEqual((await p2.check(true)).map((f) => f.name), ['assets/issue24/bin.pigg']);
    assert.deepStrictEqual((await p2.download(await p2.check(true))).failed, []);
    assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'assets/issue24/bin.pigg'))).digest('hex'), XZ.b.sha256);
    assert.ok(!hits['/bad/a.xz'], 'the lower priority mirror was never needed');
    fs.rmSync(dir, { recursive: true, force: true });
    srv.close();
  });

  await test('pkg manifest: a download that unpacks wrong fails and is cleaned up', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-'));
    const srv = http.createServer((req, res) => res.end(Buffer.from(XZ.a.xz, 'base64')));
    const port = await listen(srv);
    const p = new Patcher(dir, { files: [{ name: 'x.bin', size: XZ.a.size, sha256: XZ.b.sha256, compress: 'xz', urls: [`http://127.0.0.1:${port}/x.xz`] }] });
    const r = await p.download(await p.check());
    assert.strictEqual(r.failed.length, 1);
    assert.ok(/checksum/.test(r.failed[0].error), r.failed[0].error);
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n !== '.incarnate-launcher.json'), []);
    fs.rmSync(dir, { recursive: true, force: true });
    srv.close();
  });

  await test('clean up: only files the launcher tracked (and leftover downloads) are offered or removed', async () => {
    const { oldFiles, removeOldFiles, CACHE } = require('../lib/patcher');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-'));
    const w = (n, b = 'x') => { fs.mkdirSync(path.dirname(path.join(dir, n)), { recursive: true }); fs.writeFileSync(path.join(dir, n), b); };
    w('assets/live/bin.pigg'); w('hc-bin64/cityofheroes.exe', 'xxxx'); w('Qt4.dll'); w('screenshots/me.jpg'); w('settings/keybinds.txt');
    w('assets/live/sound.pigg.part'); w('assets/live/x.pigg.unpack');
    fs.writeFileSync(path.join(dir, CACHE), JSON.stringify({ 'assets/live/bin.pigg': {}, 'hc-bin64/cityofheroes.exe': {}, 'Qt4.dll': {}, 'gone.dll': {}, '../escape': {} }));
    const m = { files: [{ name: 'assets/live/bin.pigg' }] };
    const list = (await oldFiles(dir, m)).map((f) => f.name);
    assert.deepStrictEqual([...list].sort(), ['Qt4.dll', 'assets/live/sound.pigg.part', 'assets/live/x.pigg.unpack', 'hc-bin64/cityofheroes.exe'].sort());
    const r = await removeOldFiles(dir, m, [...list, 'screenshots/me.jpg']);
    assert.strictEqual(r.removed.length, 4);
    assert.deepStrictEqual(r.failed.map((f) => f.name), ['screenshots/me.jpg']);
    assert.ok(fs.existsSync(path.join(dir, 'screenshots/me.jpg')) && fs.existsSync(path.join(dir, 'settings/keybinds.txt')) && fs.existsSync(path.join(dir, 'assets/live/bin.pigg')));
    assert.ok(!fs.existsSync(path.join(dir, 'hc-bin64')), 'empty folder removed');
    assert.deepStrictEqual(await oldFiles(dir, m), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('updates: release versions compare', () => {
    const { newer } = require('../lib/release-update');
    assert.ok(newer('0.2.0', '0.1.9') && newer('1.0.0', '1.0.0-rc1') && !newer('0.1.0', '0.1.0') && !newer('0.9.9', '1.0.0'));
  });

  console.log(failed ? red(`${failed} failed`) : green('all passed'));
  process.exit(failed ? 1 : 0);
})();
