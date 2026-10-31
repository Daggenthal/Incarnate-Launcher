// Incarnate Launcher: The main process. Window, saved servers/settings, and everything the window asks for.
// Most of the real work lives in lib/: manifest.js, patcher.js (downloads), health.js,
// launch.js (starting the game) and runners.js (Wine, Proton, etc).
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, safeStorage, Notification, clipboard, screen } = require('electron');
const { detectRunners, pickRunner } = require('./lib/runners');
const { parseManifest, splitParams } = require('./lib/manifest');
const { isPkgManifest, parsePkgManifest } = require('./lib/pkgmanifest');
const { checkHealth } = require('./lib/health');
const { Patcher, oldFiles, removeOldFiles } = require('./lib/patcher');
const { fetchNews } = require('./lib/news');
const { launch, defaultRunner } = require('./lib/launch');
const releaseUpdate = require('./lib/release-update'); // checks GitHub for new releases

const DEBUG = process.env.LAUNCHER_DEBUG === '1' || process.argv.includes('--debug');
let win = null;
let store, accounts;
const manifests = {};   // server id -> parsed manifest, or { error }
const health = {};      // server id -> last health result
const patchers = {};    // server id -> the Patcher that's running
const send = (ch, d) => { if (win && !win.isDestroyed()) win.webContents.send(ch, d); };
const log = (...a) => { if (DEBUG) console.log('[launcher]', ...a); };

// ---- Saved stuff: Servers and settings, kept in the app's own folder ----

function storeFile() { return path.join(app.getPath('userData'), 'launcher.json'); }

function loadStore() {
  let s;
  try { s = JSON.parse(fs.readFileSync(storeFile(), 'utf8')); } catch { s = null; }
  if (!s) {
    s = { servers: [], settings: { runner: defaultRunner(), theme: 'auto' }, selected: null };
    s.selected = s.servers[0] ? s.servers[0].id : null;
    s.settings.runner = pickRunner(runners) || defaultRunner();
    s.settings.welcome = true; // show the first-run server picker once
  }
  s.settings.runner = { ...defaultRunner(), ...(s.settings.runner || {}) };
  // Known servers that moved to a new manifest address: point the saved ones at it. The files
  // that are already there get checked (and moved, if the layout changed) on the next update
  for (const srv of s.servers) {
    const k = KNOWN_SERVERS.find((x) => (x.legacy || []).includes(srv.source));
    if (k) { srv.source = k.source; srv.profile = 0; }
  }
  // If whatever they used to run the game got removed (uninstalled CrossOver, deleted a Proton),
  // swap in the first one we find; Settings will show it
  if (!runnerUsable(s.settings.runner) && runners.length) s.settings.runner = pickRunner(runners);
  return s;
}

// What can run the game on this computer, looked up once at start
const runners = detectRunners();
function runnerUsable(r) {
  if (!r) return false;
  if (r.kind === 'native') return process.platform === 'win32';
  const p = r.kind === 'proton' ? r.proton : r.kind === 'umu' ? r.umu : r.wine;
  if (!p) return false;
  return path.isAbsolute(p) ? fs.existsSync(p) : runners.some((x) => x.wine === p) || !!require('./lib/runners').onPath(p);
}

// ---- Logs: One per server, next to its game log. Downloads, failures, game starts and early
// exits all go here, and the Logs card shows it ----
function logDir() { return path.join(app.getPath('userData'), 'logs'); }
function serverLogFile(s, kind) { return path.join(logDir(), `${s.label || s.id}${kind === 'launcher' ? '.launcher' : ''}.log`.replace(/[^\w. -]/g, '_')); }
function slog(id, line) {
  const s = server(id);
  if (!s) return;
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    const f = serverLogFile(s, 'launcher');
    try { if (fs.statSync(f).size > 5 << 20) fs.renameSync(f, f.replace(/\.log$/, '.prev.log')); } catch { /* new */ }
    fs.appendFileSync(f, `${stamp} ${line}\n`);
  } catch (e) { log('server log:', e.message); }
  send('slog', { id, line: `${stamp} ${line}` });
}
function tail(file, bytes) {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const len = Math.min(st.size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const t = buf.toString('utf8');
    return len < st.size ? t.slice(t.indexOf('\n') + 1) : t;
  } catch { return ''; }
}
// Crash reports the game leaves in its folder (logs/crashes/, *.dmp, crash*.txt/log), newest first
function crashFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 2 && !/^(piggs|assets|data)$/i.test(e.name)) walk(full, depth + 1); continue; }
      if (/\.dmp$/i.test(e.name) || /crash/i.test(e.name) || /[\\/]crashes$/i.test(d)) {
        try { out.push({ file: full, time: fs.statSync(full).mtimeMs }); } catch { /* gone */ }
      }
    }
  };
  if (dir) walk(dir, 0);
  return out.sort((a, b) => b.time - a.time);
}

// System notification for when a download/update finishes, since the window is probably behind
// something by then. Linux goes through libnotify, or notify-send if Electron can't
function notify(title, body) {
  try {
    if (Notification.isSupported()) { new Notification({ title, body }).show(); return; }
  } catch { /* fall through */ }
  if (process.platform === 'linux') execFile('notify-send', ['-a', 'Incarnate Launcher', title, body], () => {});
}

function saveStore() {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  fs.writeFileSync(storeFile(), JSON.stringify(store, null, 2));
}

function newId() { return crypto.randomBytes(6).toString('hex'); }
const server = (id) => store.servers.find((s) => s.id === id);

// ---- Manifests ----

// A manifest (or one of the files it points at) as text: a web address or a file here
async function getText(src) {
  if (/^https?:\/\//i.test(src)) {
    const r = await fetch(src, { headers: { 'user-agent': `IncarnateLauncher/${app.getVersion()}` }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(src).host}`);
    return r.text();
  }
  return fs.readFileSync(src, 'utf8');
}

// XML (Tequila, LaunchCat, most servers) or Homecoming's signed JSON, whichever it is
async function readManifest(src) {
  const text = await getText(src);
  if (!isPkgManifest(text)) return parseManifest(text, src);
  const m = await parsePkgManifest(text, src, getText);
  if (m.signed === false) log('manifest', src, "signature didn't check out (still used)");
  return m;
}

async function loadManifest(srv) {
  try {
    const known = KNOWN_SERVERS.find((k) => k.source === srv.source);
    try {
      manifests[srv.id] = await readManifest(srv.source);
    } catch (e) {
      if (!known || !known.fallback) throw e;
      // Their main manifest is down: use the older one so the server still shows up and plays
      log('manifest', srv.source, `failed (${e.message}), using`, known.fallback);
      manifests[srv.id] = await readManifest(known.fallback);
      manifests[srv.id].fellBack = e.message;
    }
    // Use our name for known servers (Thunderspy's manifest just calls itself "City of Heroes")
    if (known) manifests[srv.id].label = known.name;
    log('manifest', srv.source, manifests[srv.id].files.length, 'files');
  } catch (e) {
    manifests[srv.id] = { error: `Couldn't read the manifest: ${e.message}`, label: srv.label || srv.source, profiles: [], files: [] };
  }
  if (!manifests[srv.id].error) { srv.label = manifests[srv.id].label; saveStore(); }
  return manifests[srv.id];
}

function view() {
  return {
    platform: process.platform,
    debug: DEBUG,
    runners,
    logDir: logDir(),
    runnerOk: runnerUsable(store.settings.runner),
    // First-run server picker: Shows once for new players; --welcome brings it back
    welcome: !!store.settings.welcome || process.argv.includes('--welcome'),
    settings: store.settings,
    selected: store.selected,
    servers: store.servers.map((s) => ({
      id: s.id, source: s.source, dir: s.dir, profile: s.profile || 0, feed: s.feed || '', launchArgs: s.launchArgs || '',
      installed: isInstalled(s),
      manifest: manifests[s.id] || null,
      health: health[s.id] || null,
      patching: !!patchers[s.id],
    })),
  };
}

// ---- Known servers: Their public manifests, plus a news page if the manifest doesn't have
// one. Picked from the Add box, and each one gets its own install folder ----
const KNOWN_SERVERS = [
  // Homecoming: Their launcher's own profile (signed JSON, lib/pkgmanifest.js). The old XML is
  // stuck on an older build (files 404), so it's only a fallback if the new one can't be reached
  { name: 'Homecoming', source: 'https://manifest.cohhc.gg/profile/live.json', fallback: 'http://patch.savecoh.com/manifest.xml',
    legacy: ['http://patch.savecoh.com/manifest.xml', 'https://patch.savecoh.com/manifest.xml'], site: 'https://homecomingservers.com/', statusPage: 'https://forums.homecomingservers.com/status/',
    statusApi: 'https://api.homecomingservers.com/shardstatus/live', newsJson: 'https://newsfeed.homecomingservers.com/live' },
  { name: 'Thunderspy', source: 'https://thunderspy.net/manifest/live.xml', site: 'https://thunderspy.net/', feed: 'https://thunderspy.net/news' },
  { name: 'Rebirth', source: 'https://join.cityofheroesrebirth.com/Manifests/Rebirth.xml', site: 'https://www.cityofheroesrebirth.com/' },
  { name: 'Cake: New Dawn', source: 'https://evolution-newdawn.com/ultramanifest26.xml', site: 'https://evolution-newdawn.com/' },
  { name: 'Unity', source: 'https://cityofheroesunity.com/i26Unity.xml', site: 'https://cityofheroesunity.com/' },
];

// ---- Install folders: Every server gets its own, and never inside (or around) another one's.
// A patch only writes what its manifest lists, but that could still clobber another server ----
const inside = (a, b) => { const r = path.relative(b, a); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
function folderProblem(id, dir) {
  const s = server(id);
  dir = path.resolve(dir);
  if (dir === path.parse(dir).root || dir === path.resolve(app.getPath('home'))) return 'Pick a folder of its own, not a whole disk or your home folder.';
  for (const o of store.servers) {
    if (o.id === id || !o.dir) continue;
    if (inside(dir, o.dir) || inside(o.dir, dir)) return `${o.label || 'Another server'} is installed in ${o.dir}: each server needs a folder of its own.`;
  }
  return '';
}
const folderName = (label) => String(label || 'Server').replace(/[^\w .-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Server';

// ---- News: Whatever the manifest points at, cached for 10 minutes ----
const news = {}; // server id -> last news we got

// Is the game installed? Looks for the picked profile's exe in the install folder
function isInstalled(s) {
  const m = manifests[s.id];
  if (!s.dir || !m || m.error) return false;
  const p = m.profiles[s.profile || 0] || m.profiles[0];
  if (!p || !p.exec) return false;
  return fs.existsSync(path.join(s.dir, p.exec.replace(/\\/g, '/')));
}

// ---- Health: Every 30 seconds, or when someone hits Check Now ----

async function refreshHealth(id) {
  const m = manifests[id];
  if (!m || m.error) return;
  const s = server(id);
  const known = s && KNOWN_SERVERS.find((k) => k.source === s.source);
  health[id] = await checkHealth(m, { statusPage: known && known.statusPage, statusApi: (known && known.statusApi) || m.statusApi });
  send('health', { id, health: health[id] });
}
async function refreshAllHealth() { await Promise.all(store.servers.map((s) => refreshHealth(s.id))); }

// ---- Window ----

// Put the window back where it was and the size it was, since updates restart the launcher.
// If that spot isn't on any screen anymore (unplugged monitor), just use the default
function savedBounds() {
  const w = store.window;
  if (!w || !(w.width >= 860 && w.height >= 560)) return { width: 1100, height: 720 };
  const size = { width: w.width, height: w.height };
  if (!Number.isFinite(w.x) || !Number.isFinite(w.y)) return size;
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
    w.x + 100 <= a.x + a.width && w.x + w.width - 100 >= a.x && w.y >= a.y - 10 && w.y + 40 <= a.y + a.height);
  return onScreen ? { ...size, x: w.x, y: w.y } : size;
}

function rememberBounds() {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  const maximized = win.isMaximized();
  // When maximized, save the normal size so un-maximizing later still goes back to it
  const b = maximized ? win.getNormalBounds() : win.getBounds();
  store.window = { x: b.x, y: b.y, width: b.width, height: b.height, maximized };
}

function createWindow() {
  win = new BrowserWindow({
    ...savedBounds(), minWidth: 860, minHeight: 560,
    title: 'Incarnate Launcher',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#101218' : '#f4f5f8',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Windows and Linux get Electron's default File/Edit/View/Window bar, which does nothing useful
  // here, so it goes. macOS keeps its menu (that's where Cmd+Q and copy/paste live). Debug mode
  // keeps it everywhere for View, Toggle Developer Tools
  if (process.platform !== 'darwin' && !DEBUG) win.removeMenu();
  if (store.window && store.window.maximized) win.maximize();
  let t = null;
  const later = () => { clearTimeout(t); t = setTimeout(() => { rememberBounds(); saveStore(); }, 600); };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, later);
  win.on('close', () => { clearTimeout(t); rememberBounds(); saveStore(); });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// ---- Calls from the window ----

const calls = {
  info: () => view(),

  async addServer(source) {
    source = String(source || '').trim();
    if (!source) throw new Error('Paste a manifest address (https://...) or pick a manifest file.');
    if (!/^https?:\/\//i.test(source) && !fs.existsSync(source)) throw new Error("That isn't a web address or a file on this computer.");
    const srv = { id: newId(), source, dir: '' };
    const m = await loadManifest(srv);
    if (m.error) throw new Error(m.error);
    store.servers.push(srv);
    store.selected = srv.id;
    saveStore();
    refreshHealth(srv.id);
    return view();
  },

  async pickManifestFile() {
    const r = await dialog.showOpenDialog(win, { title: 'Pick a launcher manifest', filters: [{ name: 'Manifest', extensions: ['xml'] }], properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  },

  removeServer(id) {
    store.servers = store.servers.filter((s) => s.id !== id);
    if (store.selected === id) store.selected = store.servers[0] ? store.servers[0].id : null;
    saveStore();
    return view();
  },

  select(id) { store.selected = id; saveStore(); return true; },

  async refresh(id) { const s = server(id); if (s) { await loadManifest(s); await refreshHealth(id); } return view(); },

  async checkHealth(id) { await refreshHealth(id); return health[id]; },

  async chooseFolder(id) {
    const s = server(id);
    const r = await dialog.showOpenDialog(win, { title: `Install folder for ${s.label || 'this server'}`, defaultPath: s.dir || calls.suggestFolder(id).dir, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return view();
    const problem = folderProblem(id, r.filePaths[0]);
    if (problem) throw new Error(problem);
    s.dir = r.filePaths[0];
    saveStore();
    return view();
  },

  // Folder from the picker. We only check it here; Change... decides to move or start fresh
  async pickInstallFolder(id) {
    const s = server(id);
    const r = await dialog.showOpenDialog(win, { title: `New install folder for ${s.label || 'this server'}`, defaultPath: s.dir || calls.suggestFolder(id).dir, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return null;
    const problem = folderProblem(id, r.filePaths[0]);
    if (problem) throw new Error(problem);
    return { dir: r.filePaths[0], installed: isInstalled(s) };
  },

  // Move an install: Only the manifest's files (and our checksum cache) go to the new folder.
  // Same disk is a rename, otherwise copy then delete. Nothing else in the old folder gets touched
  async moveInstall({ id, dir }) {
    const s = server(id);
    const m = manifests[id];
    if (!s || !s.dir || !m || m.error) throw new Error('Nothing to move');
    if (patchers[id]) throw new Error('Wait for the download to finish first');
    dir = path.resolve(String(dir || ''));
    const problem = folderProblem(id, dir);
    if (problem) throw new Error(problem);
    const from = s.dir;
    if (path.resolve(from) === dir) return view();
    const names = [...m.files.map((f) => f.name), '.incarnate-launcher.json'];
    let moved = 0;
    for (const n of names) {
      const a = path.join(from, n);
      const b = path.join(dir, n);
      if (!fs.existsSync(a)) continue;
      await fs.promises.mkdir(path.dirname(b), { recursive: true });
      try { await fs.promises.rename(a, b); } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        await fs.promises.copyFile(a, b);
        await fs.promises.unlink(a);
      }
      moved++;
      if (moved % 20 === 0) send('patch', { id, phase: 'move', done: moved, total: names.length });
    }
    s.dir = dir;
    saveStore();
    send('patch', { id, phase: 'moved', moved, from });
    return view();
  },

  // Default spot for a new server: Its own folder under Games
  suggestFolder(id) {
    const s = server(id);
    return { dir: path.join(app.getPath('home'), 'Games', 'City of Heroes', folderName(s.label)) };
  },

  // They picked a folder. Make it if needed; if it already has someone else's files in it,
  // they have to confirm again (force)
  setFolder({ id, dir, force }) {
    const s = server(id);
    if (!s) throw new Error('No such server');
    dir = path.resolve(String(dir || ''));
    const problem = folderProblem(id, dir);
    if (problem) throw new Error(problem);
    let entries = [];
    try { entries = fs.readdirSync(dir).filter((f) => !f.startsWith('.')); } catch { /* new */ }
    if (entries.length && s.dir !== dir && !force) return { needsConfirm: true, dir, count: entries.length };
    fs.mkdirSync(dir, { recursive: true });
    s.dir = dir;
    saveStore();
    return { ok: true, view: view() };
  },

  knownServers() {
    const have = new Set(store.servers.map((x) => x.source));
    return KNOWN_SERVERS.map((k) => ({ ...k, added: have.has(k.source) }));
  },

  async news({ id, force }) {
    const s = server(id);
    const m = manifests[id];
    if (!s || !m || m.error) return { motd: '', sections: [], errors: [] };
    if (!force && news[id] && Date.now() - news[id].at < 10 * 60 * 1000) return news[id];
    const profile = m.profiles[s.profile || 0] || m.profiles[0];
    const known = KNOWN_SERVERS.find((k) => k.source === s.source);
    news[id] = await fetchNews({ manifest: m, profile, feed: s.feed || (known && known.feed) || '', newsJson: (known && known.newsJson) || m.news });
    return news[id];
  },

  setFeed({ id, feed }) {
    const s = server(id);
    feed = String(feed || '').trim();
    if (feed && !/^https?:\/\//i.test(feed)) throw new Error('A news feed is a web address (https://...)');
    s.feed = feed;
    delete news[id];
    saveStore();
    return view();
  },

  // Change a server's manifest address (or file). Checked before it's saved, so a typo doesn't
  // break the server; the install folder stays the same
  async setSource({ id, source }) {
    const s = server(id);
    if (!s) throw new Error('no such server');
    source = String(source || '').trim();
    if (!source) throw new Error('Paste a manifest address (https://...) or pick a manifest file.');
    if (!/^https?:\/\//i.test(source) && !fs.existsSync(source)) throw new Error("That isn't a web address or a file on this computer.");
    if (source === s.source) return view();
    const m = await readManifest(source).catch((e) => { throw new Error(`Couldn't read that manifest: ${e.message}`); });
    slog(id, `Manifest changed: ${s.source} -> ${source}`);
    s.source = source;
    s.profile = 0;
    manifests[id] = m;
    const known = KNOWN_SERVERS.find((k) => k.source === source);
    s.label = known ? known.name : m.label;
    if (known) m.label = known.name;
    saveStore();
    delete news[id];
    refreshHealth(id).catch(() => {});
    return view();
  },

  setProfile({ id, index }) { const s = server(id); s.profile = Number(index) || 0; saveStore(); return true; },

  // Extra launch options for one server (game options like -assetpath)
  setLaunchArgs({ id, args }) {
    const s = server(id);
    s.launchArgs = String(args || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 1000);
    saveStore();
    return s.launchArgs;
  },

  // Patching: Check the files, then grab whatever's missing or changed
  async patch({ id, verify }) {
    const s = server(id);
    const m = manifests[id];
    if (!s.dir) throw new Error('Pick an install folder first.');
    if (patchers[id]) throw new Error('Already patching.');
    fs.mkdirSync(s.dir, { recursive: true });
    const p = new Patcher(s.dir, m, { switchSlow: store.settings.switchSlow !== false });
    patchers[id] = p;
    p.on('progress', (d) => send('patch', { id, ...d }));
    // Log the mirror speeds and where each file came from, so a slow download can be traced
    // back to one bad mirror
    p.on('mirrors', (list) => slog(id, `Mirrors, fastest first: ${list.map((x) => `${x.host} ${x.ms === Infinity ? "(didn't answer)" : `${x.ms} ms`}`).join(', ')}`));
    p.on('moved', (x) => slog(id, `Already had ${x.to} (at ${x.from}): moved it instead of downloading`));
    p.on('file', (x) => {
      // KB under a megabyte, so small files don't read "0.0 MB"
      const amt = (b) => (b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`);
      const rate = x.ms && x.bytes ? `, ${amt(x.bytes / (x.ms / 1000))}/s` : '';
      slog(id, `Got ${x.name} from ${x.host}${x.bytes ? ` (${amt(x.bytes)}${rate})` : ''}${x.slowOn.length ? `; ${x.slowOn.join(', ')} was too slow, so it switched` : ''}`);
    });
    // Remember this download until it's done. If the launcher closes mid-way (update, crash,
    // power goes out), it picks back up on the next start
    const firstInstall = !isInstalled(s);
    store.resume = [...new Set([...(store.resume || []), id])];
    saveStore();
    slog(id, `${verify ? 'Repair' : 'Check'} started: ${m.files.length} files in the manifest, into ${s.dir}`);
    let ended = false;
    try {
      const need = await p.check(!!verify);
      if (!need.length || p.cancelled) {
        ended = true;
        send('patch', { id, phase: 'done', updated: 0, verify: !!verify });
        slog(id, p.cancelled ? 'Stopped while checking' : 'Every file is up to date');
        return { updated: 0, failed: [] };
      }
      const mb = (need.reduce((a, f) => a + (f.size || 0), 0) / 1048576).toFixed(1);
      slog(id, `${need.length} files to download (${mb} MB)`);
      const r = await p.download(need);
      ended = true;
      send('patch', { id, phase: r.cancelled ? 'cancelled' : 'done', updated: need.length - r.failed.length, failed: r.failed, verify: !!verify });
      const label = s.label || 'The game';
      if (r.cancelled) slog(id, 'Stopped (Cancel): the next check picks up where it left off');
      else {
        for (const f of r.failed) slog(id, `FAILED ${f.name}: ${f.error}`);
        slog(id, r.failed.length ? `Done with ${r.failed.length} files failed, ${need.length - r.failed.length} downloaded` : `Done: ${need.length} files downloaded`);
        // Every mirror 404'd: The manifest lists files the server doesn't have anymore. Nothing
        // we can do about that from here, so just say so
        const gone = r.failed.filter((f) => /HTTP (404|410)\b/.test(f.error)).length;
        if (gone && gone === r.failed.length) {
          slog(id, `${gone} files aren't on ${label}'s download servers any more: their file list (manifest) is out of date on their end. Repair can't fix that; it's up to them.`);
          notify(`${label}: files missing on their end`, `${gone} files the server lists aren't on its download servers. That's on their side, not yours.`);
        } else if (r.failed.length) notify(`${label}: download failed`, `${r.failed.length} files couldn't be downloaded. Settings, Logs has which and why.`);
        else notify(firstInstall ? `${label} is installed` : `${label} is up to date`, firstInstall ? 'The download finished. Ready to play.' : `${need.length} files updated. Ready to play.`);
      }
      return { updated: need.length - r.failed.length, failed: r.failed };
    } catch (e) {
      ended = true;
      slog(id, `FAILED: ${e.message}`);
      notify(`${s.label || 'The game'}: download failed`, e.message);
      throw e;
    } finally {
      delete patchers[id];
      if (ended) { store.resume = (store.resume || []).filter((x) => x !== id); saveStore(); }
    }
  },

  // Clean Up Old Files: List first, then remove only what the player said yes to
  async oldFiles({ id }) {
    const s = server(id); const m = manifests[id];
    if (!s || !s.dir || !m || m.error) return [];
    return oldFiles(s.dir, m);
  },
  async cleanOldFiles({ id, names }) {
    const s = server(id); const m = manifests[id];
    if (!s || !s.dir || !m || m.error) throw new Error('No install folder or manifest for this server.');
    if (patchers[id]) throw new Error('Wait for the download to finish first.');
    const r = await removeOldFiles(s.dir, m, Array.isArray(names) ? names : []);
    slog(id, `Cleaned up ${r.removed.length} old files (${(r.bytes / 1048576).toFixed(1)} MB)${r.failed.length ? `, ${r.failed.length} couldn't be removed` : ''}`);
    for (const f of r.failed) slog(id, `Couldn't remove ${f.name}: ${f.error}`);
    return r;
  },

  cancelPatch(id) { if (patchers[id]) patchers[id].cancel(); return true; },

  async play({ id }) {
    const s = server(id);
    const m = manifests[id];
    if (!m || m.error) throw new Error('The manifest could not be read.');
    if (!s.dir) throw new Error('Pick an install folder first.');
    const profile = m.profiles[s.profile || 0] || m.profiles[0];
    if (!profile) throw new Error('The manifest has no launch profile.');
    // Game output always goes to a log (one per server). Past 20 MB the old one becomes .prev.log
    const logFile = serverLogFile(s, 'game');
    let out = 'ignore';
    try {
      fs.mkdirSync(logDir(), { recursive: true });
      try { if (fs.statSync(logFile).size > 20 << 20) fs.renameSync(logFile, logFile.replace(/\.log$/, '.prev.log')); } catch (e) {}
      out = logFile;
      if (DEBUG) log('game log:', logFile);
    } catch (e) { log('game log: not writable:', e.message); }
    const extraArgs = splitParams(s.launchArgs || '');
    if (extraArgs.length) log('launch options:', extraArgs.join(' '));
    const r = store.settings.runner;
    const how = r.kind === 'native' ? 'directly' : `with ${r.name || r.kind}`;
    let child;
    try {
      child = launch({ dir: s.dir, profile, runner: r, extraArgs, log: out });
    } catch (e) {
      slog(id, `Couldn't start ${profile.exec} ${how}: ${e.message}`);
      throw e;
    }
    slog(id, `Started ${profile.exec} ${how}`);
    // If Wine/Proton/the game dies within a few seconds, that runner probably doesn't work here.
    // Tell them, and point at Settings to try a different one
    const started = Date.now();
    let early = false;
    const failed = (why) => {
      if (Date.now() - started > 20000) return false;
      early = true;
      const msg = `The game stopped right after starting ${how} (${why}). Try another way to run it in Settings, under "Run the Game With". The game log has the details.`;
      slog(id, `FAILED: ${msg}`);
      send('playfail', { id, message: msg });
      return true;
    };
    // After that, keep the line under Play honest: running, closed, or closed on a crash. A crash
    // later on (or an error box the game sits on) used to leave "Starting the game." up forever
    const alive = setTimeout(() => send('game', { id, state: 'running' }), 8000);
    child.on('error', (e) => { clearTimeout(alive); failed(e.message); });
    child.on('exit', (code, sig) => {
      clearTimeout(alive);
      const why = sig ? `signal ${sig}` : `exit code ${code}`;
      if ((code || sig) && failed(why)) return;
      if (early) return;
      if (code || sig) {
        slog(id, `The game closed unexpectedly (${why})`);
        send('game', { id, state: 'crashed', why });
      } else {
        slog(id, 'The game closed');
        send('game', { id, state: 'closed' });
      }
    });
    return {};
  },

  setSettings(patch) {
    store.settings = { ...store.settings, ...patch, runner: { ...store.settings.runner, ...(patch.runner || {}) } };
    saveStore();
    if (patch.theme) nativeTheme.themeSource = patch.theme === 'auto' ? 'system' : patch.theme;
    return view();
  },

  // ---- Updates: Newest release on GitHub, checked at launch ----
  appVersion() { return { version: app.getVersion(), auto: store.settings.appUpdateAuto !== false, last: lastUpdateCheck }; },
  appCheckUpdate() { return checkAppUpdate(); },
  appSetAutoUpdate(on) { store.settings.appUpdateAuto = !!on; saveStore(); return true; },
  appUpdate() { if (lastUpdateCheck && lastUpdateCheck.url) shell.openExternal(lastUpdateCheck.url); return { opened: true }; },

  // ---- Logs card ----
  serverLog(id) {
    const s = server(id);
    return { text: tail(serverLogFile(s, 'launcher'), 64 << 10), file: serverLogFile(s, 'launcher'), gameLog: serverLogFile(s, 'game'),
      crashes: crashFiles(s.dir).length };
  },
  // Everything you'd want in a bug report: Launcher version, how it runs the game, this
  // server's log, and the tail end of the game's log
  copyLogs(id) {
    const s = server(id);
    const r = store.settings.runner;
    const text = [`Incarnate Launcher ${app.getVersion()} on ${process.platform} ${require('os').release()} (${process.arch})`,
      `Server: ${s.label || s.source} (${s.source})`, `Install folder: ${s.dir || '(none)'}`,
      `Runs the game: ${r.kind}${r.name ? ` (${r.name})` : ''} ${r.wine || r.proton || r.umu || ''}`,
      '', '== Launcher ==', tail(serverLogFile(s, 'launcher'), 64 << 10).trim() || '(nothing yet)',
      '', '== Game (last part) ==', tail(serverLogFile(s, 'game'), 48 << 10).trim() || '(no game log yet)'].join('\n');
    clipboard.writeText(`${text}\n`);
    return { chars: text.length };
  },
  copyCrashes(id) {
    const s = server(id);
    const files = crashFiles(s.dir).slice(0, 5);
    if (!files.length) return { count: 0 };
    const parts = files.map((f) => {
      const when = new Date(f.time).toLocaleString();
      if (/\.dmp$/i.test(f.file)) return `== ${f.file} (${when}) ==\nA minidump (binary): attach the file itself.`;
      return `== ${f.file} (${when}) ==\n${tail(f.file, 64 << 10).trim()}`;
    });
    clipboard.writeText(`${parts.join('\n\n')}\n`);
    return { count: files.length };
  },
  revealLogs() { fs.mkdirSync(logDir(), { recursive: true }); shell.openPath(logDir()); return true; },
  welcomeDone() { store.settings.welcome = false; saveStore(); return true; },

  open(url) { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return true; },
  reveal(dir) { if (dir && fs.existsSync(dir)) shell.openPath(dir); return true; },
};

for (const [name, fn] of Object.entries(calls)) {
  ipcMain.handle(name, async (_e, arg) => {
    try { return { ok: true, value: await fn(arg) }; } catch (e) { log(name, 'failed:', e.message); return { ok: false, error: e.message }; }
  });
}

let lastUpdateCheck = null;
async function checkAppUpdate() {
  const r = await releaseUpdate.check(app.getVersion());
  lastUpdateCheck = r;
  send('update', r);
  if (r.available) notify('Incarnate Launcher update', `Version ${r.latest} is out. Settings has the download.`);
  return r;
}

// ---- Start ----

// Windows won't show notifications without an app id
if (process.platform === 'win32') app.setAppUserModelId('com.incarnate.launcher');

app.whenReady().then(async () => {
  store = loadStore();
  nativeTheme.themeSource = store.settings.theme === 'auto' || !store.settings.theme ? 'system' : store.settings.theme;
  createWindow();
  await Promise.all(store.servers.map(loadManifest));
  send('info', view());
  refreshAllHealth();
  // Pick back up any downloads that got cut off last time (same as Check for Updates)
  for (const id of store.resume || []) {
    const s = server(id);
    if (!s || !s.dir || !manifests[id] || manifests[id].error) continue;
    slog(id, 'The launcher closed during a download: picking it up where it left off');
    send('resumed', { id });
    calls.patch({ id, verify: false }).catch((e) => log('resume:', e.message));
  }
  setInterval(refreshAllHealth, 30 * 1000);
  // Check for launcher updates once at launch, unless it's turned off in Settings
  if (store.settings.appUpdateAuto !== false) setTimeout(() => checkAppUpdate().catch(() => {}), 6000);
});

app.on('window-all-closed', () => app.quit());
