'use strict';
/* global launcher */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let info = null;
const patchState = {}; // server id -> latest download progress

const current = () => info && info.servers.find((s) => s.id === info.selected);

function ago(t) {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 5 ? 'just now' : s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
}

function healthWords(h) {
  if (!h) return { cls: '', state: 'Checking...', detail: '' };
  if (h.up === true) {
    const bits = [];
    if (h.players !== null && h.players !== undefined) bits.push(`${h.players.toLocaleString()} online`);
    if (h.serversTotal) bits.push(`${h.serversUp}/${h.serversTotal} ${h.shards ? 'shards' : 'servers'}`);
    if (h.maps) bits.push(`${h.maps.toLocaleString()} maps`);
    if (h.ms !== null && h.ms !== undefined) bits.push(`${h.ms} ms`);
    return { cls: 'up', state: 'Up', detail: [bits.join(' · '), h.message].filter(Boolean).join(' · ') };
  }
  if (h.up === false) return { cls: 'down', state: 'Down', detail: h.error || h.message || '' };
  return { cls: 'unknown', state: 'Unknown', detail: h.error || '' };
}

// "Issue 28, Page 4 - 28.4.8623" -> "Issue 28, Page 4 - Build: 28.4.8623". Whatever the issue,
// page or build is, the build number after the last dash gets "Build:" in front of it
function versionText(v) {
  const m = /^(.*\S)\s+-\s+(\d+(?:\.\d+)+)$/.exec(String(v).trim());
  if (m) return `${m[1]} - Build: ${m[2]}`;
  return /^\d+(\.\d+)+$/.test(String(v).trim()) ? `Build: ${String(v).trim()}` : String(v);
}

// ---- Server list ----

function renderList() {
  const ul = $('#servers');
  ul.innerHTML = info.servers.map((s) => {
    const h = healthWords(s.health);
    const name = s.manifest ? s.manifest.label : s.source;
    return `<li data-id="${esc(s.id)}" class="${s.id === info.selected ? 'on' : ''}">
      <span class="dot ${h.cls}"></span><span class="name">${esc(name)}</span>
      <span class="sub">${esc(h.state)}${s.health && s.health.players != null ? ` · ${s.health.players.toLocaleString()} online` : ''}</span></li>`;
  }).join('');
}

$('#servers').onclick = async (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  info.selected = li.dataset.id;
  await launcher.select(info.selected);
  render();
};

// ---- Selected server ----

function renderDetail() {
  const s = current();
  $('#emptyState').hidden = !!s;
  $('#serverView').hidden = !s;
  if (!s) return;
  const m = s.manifest || { profiles: [], files: [] };
  if (newsFor !== s.id) loadNews(false);
  if (logFor !== s.id) loadServerLog(s.id);
  $('#sName').textContent = m.label || s.source;
  // Under the name: the game version when the manifest says it (Homecoming's does), else where it's from
  const ver = s.manifest && !s.manifest.error && s.manifest.version;
  $('#sSub').textContent = ver ? versionText(ver) : s.source;
  $('#sSub').title = s.source;
  // Health chip ("Up · 1,295 online"). Click it for the shards, players and maps
  const h = healthWords(s.health);
  const online = s.health && s.health.players !== null && s.health.players !== undefined ? ` · ${s.health.players.toLocaleString()} online` : '';
  $('#sHealthChip').innerHTML = `<span class="dot ${h.cls}"></span>${esc(h.state)}${esc(h.cls === 'up' ? online : '')}<span class="caret">▾</span>`;
  renderShards(s);
  $('#sError').hidden = !m.error;
  $('#sError').textContent = m.error || '';

  $('#sProfile').innerHTML = m.profiles.map((p, i) => `<option value="${i}" ${i === s.profile ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  if (document.activeElement !== $('#sArgs')) $('#sArgs').value = s.launchArgs || '';
  if (document.activeElement !== $('#sManifest')) $('#sManifest').value = s.source || '';
  // What the manifest is: its version, and whether we're on a fallback because the main one failed
  const mf = s.manifest || {};
  $('#sManifestNote').textContent = mf.error ? mf.error
    : [mf.version && versionText(mf.version), mf.signed === true && 'Signed',
      mf.fellBack && `Main manifest unreachable (${mf.fellBack}), using the older one`].filter(Boolean).join(' · ');
  $('#sDir').textContent = s.dir || 'Not chosen yet';
  $('#sRevealBtn').hidden = !s.dir;

  // Files
  const ps = patchState[s.id];
  const busy = s.patching || (ps && (ps.phase === 'check' || ps.phase === 'download'));
  $('#sPatchBtn').hidden = $('#sVerifyBtn').hidden = busy || !m.files.length;
  $('#sCancelBtn').hidden = !busy;
  $('#sPatchBtn').disabled = $('#sVerifyBtn').disabled = !s.dir || !m.files.length;
  $('#sBar').hidden = !busy;
  if (!m.files.length) $('#sPatchText').textContent = 'This manifest has no file list: the install folder is used as it is.';
  else if (!ps) $('#sPatchText').textContent = `${m.files.length} files in the manifest.`;
  renderPatch(s.id);

  const links = [];
  // If the manifest and the profile have different sites, label them by host
  const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return 'Website'; } };
  const prof = m.profiles[s.profile || 0];
  const two = !!(m.webpage && prof && prof.website && prof.website !== m.webpage);
  if (m.webpage) links.push({ name: two ? hostOf(m.webpage) : 'Website', url: m.webpage });
  if (prof && prof.website && prof.website !== m.webpage) links.push({ name: two ? hostOf(prof.website) : 'Website', url: prof.website });
  for (const f of m.forums || []) links.push(f);
  $('#sLinks').innerHTML = links.map((l) => `<button class="link" data-url="${esc(l.url)}">${esc(l.name)}</button>`).join('');

  // Not installed yet (no folder, or no game exe in it): Show Install instead of Play
  const install = !s.installed;
  const updating = false;
  const fetching = patchLabel(s);
  $('#playBtn').textContent = fetching || (install ? (s.dir ? 'Install' : 'Install...') : updating ? 'Updating...' : 'Play');
  $('#playBtn').title = fetching ? 'The game is being downloaded: the progress is under Files'
    : install ? (s.dir ? `Download the game into ${s.dir}` : 'Pick where the game goes, then download it')
    : '';
  $('#playBtn').disabled = !!m.error || !m.profiles.length || busy || updating || (install && !m.files.length);
}

// What Play says while files are going: Downloading (first install), Updating (new files) or
// Checking (comparing with the manifest), with a %. '' when nothing's happening
function patchLabel(s) {
  const p = s && patchState[s.id];
  if (!p || !s.patching) return '';
  if (p.phase === 'check') return `Checking ${p.total ? Math.floor(100 * p.done / p.total) : 0}%`;
  if (p.phase === 'download') {
    const pct = p.totalBytes ? Math.floor(100 * p.bytes / p.totalBytes) : 0;
    return `${s.installed ? 'Updating' : 'Downloading'} ${pct}%`;
  }
  return '';
}

// Download speed over the last 10 seconds (so one slow file doesn't tank it) and time left.
// null until we have 2 seconds of samples; resets on a new download
const rates = {};
function rateOf(id, bytes) {
  const now = Date.now();
  let r = rates[id];
  if (!r || bytes < r.last) r = rates[id] = { samples: [], last: 0 };
  r.last = bytes;
  r.samples.push([now, bytes]);
  while (r.samples.length > 2 && now - r.samples[0][0] > 10000) r.samples.shift();
  const [t0, b0] = r.samples[0];
  return now - t0 < 2000 ? null : Math.max(0, (bytes - b0) / ((now - t0) / 1000));
}
// "About 12 minutes left", "About 1 minute left", "Almost done" under a minute, hours past 60
function timeLeft(sec) {
  if (!isFinite(sec)) return '';
  if (sec < 60) return 'Almost done';
  const m = Math.round(sec / 60);
  const mins = (n) => `${n} minute${n === 1 ? '' : 's'}`;
  if (m < 60) return `About ${mins(m)} left`;
  const h = Math.floor(m / 60);
  return `About ${h} hour${h === 1 ? '' : 's'}${m % 60 ? ` ${mins(m % 60)}` : ''} left`;
}

function renderPatch(id) {
  const s = current();
  if (!s || s.id !== id) return;
  const p = patchState[id];
  if (!p) return;
  const label = patchLabel(s);
  if (label) $('#playBtn').textContent = label;
  const bar = $('#sBarFill');
  // Same info in the bar next to Play
  const going = s.patching && (p.phase === 'check' || p.phase === 'download');
  $('#dlBox').hidden = !going;
  $('#dlCancel').hidden = !going;
  if (going) $('#playMsg').textContent = '';
  if (p.phase === 'check') {
    $('#sPatchText').textContent = `Checking files: ${p.done}/${p.total}`;
    bar.style.width = `${p.total ? (100 * p.done / p.total) : 0}%`;
    $('#dlText').textContent = `Checking files: ${p.done} of ${p.total}`;
    $('#dlFill').style.width = bar.style.width;
  } else if (p.phase === 'download') {
    const mb = (n) => (n / 1048576).toFixed(n > 1048576 * 100 ? 0 : 1);
    const r = rateOf(id, p.bytes);
    const speed = r === null ? 'measuring speed'
      : info.settings.speedUnit === 'mbps' ? `${(r * 8 / 1e6).toFixed(1)} Mbps` : `${(r / 1048576).toFixed(1)} MB/s`;
    const eta = r ? timeLeft((p.totalBytes - p.bytes) / r) : '';
    const left = eta ? ` · ${eta}` : '';
    $('#sPatchText').textContent = `Downloading: ${mb(p.bytes)} of ${mb(p.totalBytes)} MB · ${speed}${left} · ${p.file}`;
    bar.style.width = `${p.totalBytes ? (100 * p.bytes / p.totalBytes) : 0}%`;
    $('#dlText').textContent = `${s.installed ? 'Updating' : 'Downloading'}: ${mb(p.bytes)} of ${mb(p.totalBytes)} MB · ${speed}${left}`;
    $('#dlFill').style.width = bar.style.width;
  } else if (p.phase === 'done') {
    const failed = p.failed && p.failed.length;
    const gone = failed && p.failed.every((f) => /HTTP (404|410)\b/.test(f.error));
    $('#sPatchText').textContent = gone ? `${failed} files aren't on this server's download servers: its file list is out of date on their end, so Repair can't fix it.`
      : failed ? `${failed} files failed: ${p.failed.slice(0, 3).map((f) => `${f.name} (${f.error})`).join(', ')}`
      : p.verify ? (p.updated ? `Repaired: ${p.updated} files didn't match their checksum and were downloaded again.` : 'Every file matches its checksum: nothing to repair.')
      : p.updated ? `Up to date (${p.updated} files updated).` : 'Up to date.';
    $('#sPatchText').className = failed ? 'msg bad' : 'msg ok';
  } else if (p.phase === 'move') {
    $('#sPatchText').textContent = `Moving: ${p.done} of ${p.total} files`;
  } else if (p.phase === 'moved') {
    $('#sPatchText').textContent = `Moved ${p.moved} files from ${p.from}.`;
  } else if (p.phase === 'cancelled') {
    $('#sPatchText').textContent = 'Stopped. Downloads pick up where they left off next time.';
  }
}

// ---- Actions ----

let playAfter = null; // Play checks for updates first, then starts the game if that went fine
async function patch(verify) {
  const s = current();
  patchState[s.id] = { phase: 'check', done: 0, total: s.manifest.files.length };
  s.patching = true;
  render();
  let r = null;
  try { r = await launcher.patch({ id: s.id, verify }); } catch (e) { setMsg(e.message, 'bad'); }
  s.patching = false;
  try { info = await launcher.info(); } catch { /* keep */ }
  render();
  // Play kicked this off, so start the game once the files are good
  const go = playAfter === s.id;
  playAfter = null;
  if (go && r && !r.failed.length) startGame(current());
  else if (r && r.failed.length) {
    const gone = r.failed.every((f) => /HTTP (404|410)\b/.test(f.error));
    setMsg(gone ? `${r.failed.length} files aren't on this server's download servers (their file list is out of date on their end), so the game can't start yet.`
      : `${r.failed.length} files couldn't be downloaded${go ? ', so the game wasn\'t started' : ''}. Settings, Logs has why.`, 'bad');
  }
}
$('#sPatchBtn').onclick = () => patch(false);
$('#sVerifyBtn').onclick = () => patch(true);
// Clean Up Old Files: Show what would go, remove only on yes
$('#sCleanBtn').onclick = async () => {
  const s = current(); if (!s) return;
  const b = $('#sCleanBtn');
  b.disabled = true;
  let list = [];
  try { list = await launcher.oldFiles({ id: s.id }); } finally { b.disabled = false; }
  const mb = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const total = list.reduce((t, f) => t + f.size, 0);
  $('#cdText').textContent = list.length ? `${list.length} file${list.length === 1 ? '' : 's'} (${mb(total)}) that ${s.label || 'this server'} doesn't use anymore:` : 'Nothing to clean up. Every file the launcher put here is still in use.';
  $('#cdList').innerHTML = list.slice(0, 200).map((f) => `<li><span class="path">${esc(f.name)}</span> <span class="dim">${mb(f.size)}</span></li>`).join('') + (list.length > 200 ? `<li class="dim">...and ${list.length - 200} more</li>` : '');
  $('#cdGo').hidden = !list.length;
  $('#cdNo').textContent = list.length ? 'Cancel' : 'Close';
  $('#cdGo').onclick = async () => {
    $('#cdGo').disabled = true;
    try {
      const r = await launcher.cleanOldFiles({ id: s.id, names: list.map((f) => f.name) });
      $('#cdText').textContent = `Removed ${r.removed.length} files (${mb(r.bytes)}).${r.failed.length ? ` ${r.failed.length} couldn't be removed; Logs has why.` : ''}`;
      $('#cdList').innerHTML = ''; $('#cdGo').hidden = true; $('#cdNo').textContent = 'Close';
    } catch (e) {
      $('#cdText').textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    } finally { $('#cdGo').disabled = false; }
  };
  $('#cleanDlg').showModal();
};
$('#cdNo').onclick = () => $('#cleanDlg').close();
$('#sCancelBtn').onclick = () => { playAfter = null; launcher.cancelPatch(current().id); };
$('#dlCancel').onclick = () => { playAfter = null; launcher.cancelPatch(current().id); };
// Change...: Pick a new folder. If the game's already installed, move it there (or start fresh)
$('#sDirBtn').onclick = async () => {
  const s = current();
  try {
    if (!s.dir) { askFolder(s); return; }
    const r = await launcher.pickInstallFolder(s.id);
    if (!r) return;
    if (r.installed && confirm(`Move the game files from\n${s.dir}\nto\n${r.dir}?\n\nCancel uses the new folder without moving (the game downloads there again).`)) {
      setMsg('Moving the game files...', '');
      info = await launcher.moveInstall({ id: s.id, dir: r.dir });
      setMsg(`Moved to ${r.dir}`, 'ok');
    } else {
      const v = await launcher.setFolder({ id: s.id, dir: r.dir, force: true });
      info = v.view || info;
    }
    render();
  } catch (e) { setMsg(e.message, 'bad'); }
};
$('#sRevealBtn').onclick = () => launcher.reveal(current().dir);
$('#sArgs').onchange = async (e) => { const s = current(); if (!s) return; s.launchArgs = await launcher.setLaunchArgs({ id: s.id, args: e.target.value }); e.target.value = s.launchArgs; };
// Change a server's manifest: Checked first, so a typo can't break the server
$('#sManifestBtn').onclick = async () => {
  const s = current(); if (!s) return;
  const b = $('#sManifestBtn');
  b.disabled = true; b.textContent = 'Checking...';
  try {
    info = await launcher.setSource({ id: s.id, source: $('#sManifest').value });
    render();
    $('#sManifestNote').textContent = `Changed. ${$('#sManifestNote').textContent}`;
  } catch (e) {
    $('#sManifestNote').textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  } finally { b.disabled = false; b.textContent = 'Change'; }
};
$('#sManifest').onkeydown = (e) => { if (e.key === 'Enter') $('#sManifestBtn').click(); };
$('#sProfile').onchange = (e) => { current().profile = Number(e.target.value); launcher.setProfile({ id: current().id, index: e.target.value }); };
$('#sLinks').onclick = (e) => { const u = e.target.dataset.url; if (u) launcher.open(u); };

// Actually start the game (after the update check below)
async function startGame(s) {
  try {
    await launcher.play({ id: s.id });
    render();
    setMsg('Starting the game.', 'ok');
  } catch (e) { setMsg(e.message, 'bad'); }
}

// Play: Install if needed, otherwise check for updates (fast when nothing changed, it only
// compares size and date), grab what's new, then start the game
$('#playBtn').onclick = async () => {
  const s = current();
  if (!s.installed && !s.dir) { pendingInstall = s.id; askFolder(s); return; }
  if (!s.manifest || !s.manifest.files.length) { startGame(s); return; }
  playAfter = s.installed ? s.id : null;
  patch(false);
};

$('#removeBtn').onclick = async () => {
  const s = current();
  if (!confirm(`Remove ${s.manifest ? s.manifest.label : s.source} from the list? Its game files stay where they are.`)) return;
  info = await launcher.removeServer(s.id);
  $('#settings').close();
  render();
};

async function addServer(src) {
  $('#addMsg').className = 'msg';
  $('#addMsg').textContent = 'Reading the manifest...';
  try {
    info = await launcher.addServer(src);
    $('#addUrl').value = '';
    $('#addMsg').textContent = '';
  } catch (e) { $('#addMsg').className = 'msg bad'; $('#addMsg').textContent = e.message; render(); return; }
  render();
  loadKnown();
  // New server: Ask where it goes before downloading anything
  const s = current();
  if (s && !s.dir && s.manifest && s.manifest.files.length) askFolder(s);
}

// ---- Known servers ----

async function loadKnown() {
  try {
    const list = await launcher.knownServers();
    $('#knownSel').innerHTML = '<option value="">Add a known server...</option>'
      + list.map((k) => `<option value="${esc(k.source)}" ${k.added ? 'disabled' : ''}>${esc(k.name)}${k.added ? ' (added)' : ''}</option>`).join('');
  } catch { /* older main.js */ }
}
$('#knownSel').onchange = (e) => { const v = e.target.value; e.target.value = ''; if (v) addServer(v); };
loadKnown();

// ---- Install folder for a new server: We suggest one, they confirm ----

let fdServer = null;
async function askFolder(s) {
  fdServer = s;
  $('#fdName').textContent = s.manifest ? s.manifest.label : 'this server';
  $('#fdPath').textContent = (await launcher.suggestFolder(s.id)).dir;
  $('#fdMsg').textContent = ''; $('#fdMsg').className = 'msg';
  $('#folderDlg').showModal();
}
async function useFolder(dir, force) {
  try {
    const r = await launcher.setFolder({ id: fdServer.id, dir, force });
    if (r.needsConfirm) {
      if (!confirm(`${r.dir} already has ${r.count} things in it. Use it anyway? Files the manifest names get replaced; nothing else is touched.`)) return;
      return useFolder(dir, true);
    }
    info = r.view;
    $('#folderDlg').close();
    render();
    installIfPending();
  } catch (e) { $('#fdMsg').className = 'msg bad'; $('#fdMsg').textContent = e.message; }
}
$('#fdUse').onclick = () => useFolder($('#fdPath').textContent, false);
$('#fdPick').onclick = async () => {
  try { info = await launcher.chooseFolder(fdServer.id); $('#folderDlg').close(); render(); installIfPending(); }
  catch (e) { $('#fdMsg').className = 'msg bad'; $('#fdMsg').textContent = e.message; }
};
$('#fdLater').onclick = () => { pendingInstall = null; $('#folderDlg').close(); };
let pendingInstall = null;
function installIfPending() {
  const s = current();
  if (pendingInstall && s && s.id === pendingInstall && s.dir) { pendingInstall = null; patch(false); }
}

// ---- News ----

let newsFor = '';
async function loadNews(force) {
  const s = current();
  if (!s) return;
  const id = s.id;
  newsFor = id;
  if (force) $('#newsBody').innerHTML = '<p class="dim">Loading...</p>';
  let n;
  try { n = await launcher.news({ id, force }); } catch (e) { n = { motd: '', sections: [], errors: [e.message] }; }
  if (newsFor !== id) return;
  const parts = [];
  // Only show a feed's title when there's more than one, and never if it's just "News" again
  const many = n.sections.length > 1;
  const head = (sec) => {
    const t = sec.title || new URL(sec.url).host;
    return many && !/^\s*(latest\s+)?news\s*$/i.test(t) ? `<h3 class="newsSrc">${esc(t)}</h3>` : '';
  };
  const day = (d) => { const x = new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00` : d); return isNaN(x) ? d : x.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }); };
  // We skip the manifest's MOTD ("NCSOFT has granted..."). It never changes and just pushes the
  // real news down
  for (const sec of n.sections) {
    if (sec.kind === 'feed') {
      parts.push(`${head(sec)}<ul class="posts">${sec.items.map((it) => `<li class="post">
        ${it.date ? `<div class="postDate">${esc(day(it.date))}</div>` : ''}
        <div class="postTitle">${it.link ? `<button class="link" data-url="${esc(it.link)}">${esc(it.title || it.link)}</button>` : esc(it.title)}</div>
        ${it.summary ? `<p class="postBody">${esc(it.summary).replace(/\n/g, '<br>')}</p>` : ''}
        ${it.link ? `<button class="link more" data-url="${esc(it.link)}">Read More →</button>` : ''}</li>`).join('')}</ul>`);
    } else if (sec.kind === 'text') {
      parts.push(`<div class="motd">${esc(sec.text).replace(/\n/g, '<br>')}</div>`);
    } else {
      parts.push(`${head(sec)}${sec.blocks.map((b) => (b.heading ? `<h4>${esc(b.text)}</h4>` : `<p>${esc(b.text)}</p>`)).join('')}
        <button class="link more" data-url="${esc(sec.url)}">Open the Page →</button>`);
    }
  }
  if (!parts.length) parts.push(`<p class="dim">${n.errors.length ? `Couldn't get the news: ${esc(n.errors.join('; '))}` : 'This server\'s manifest has no news page or message of the day. Settings, News feed adds one.'}</p>`);
  else if (n.errors.length) parts.push(`<p class="dim">Not reachable: ${esc(n.errors.join('; '))}</p>`);
  $('#newsBody').innerHTML = parts.join('');
}
$('#newsBody').onclick = (e) => { const u = e.target.dataset && e.target.dataset.url; if (u) launcher.open(u); };
$('#newsRefresh').onclick = async () => {
  const b = $('#newsRefresh');
  b.disabled = true; b.textContent = 'Refreshing...';
  try { await loadNews(true); } finally { b.disabled = false; b.textContent = '↻ Refresh'; }
};
$('#addBtn').onclick = () => addServer($('#addUrl').value);
$('#addUrl').onkeydown = (e) => { if (e.key === 'Enter') addServer($('#addUrl').value); };
$('#addFileBtn').onclick = async () => { const f = await launcher.pickManifestFile(); if (f) addServer(f); };

function setMsg(text, cls = '') { $('#playMsg').textContent = text; $('#playMsg').className = `msg ${cls}`; }

// ---- Theme and Settings ----

function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
  for (const b of document.querySelectorAll('#theme button')) b.classList.toggle('on', b.dataset.theme === t);
}
$('#theme').onclick = async (e) => {
  const t = e.target.dataset.theme;
  if (!t) return;
  applyTheme(t);
  info = await launcher.setSettings({ theme: t });
};

$('#settingsBtn').onclick = () => {
  const r = info.settings.runner;
  const f = $('#runnerFields');
  if (info.platform === 'win32') {
    f.innerHTML = '<p class="dim">The game runs directly on Windows. Nothing to set here.</p>';
  } else {
    // What we found on this computer, then anything they set by hand
    const found = info.runners || [];
    const same = (x) => x.kind === r.kind && (x.wine || x.proton || x.umu) === (r.wine || r.proton || r.umu);
    const cur = found.findIndex(same);
    const opts = found.map((x, i) => `<option value="f${i}" ${i === cur ? 'selected' : ''}>${esc(x.name)}</option>`).join('')
      + ['crossover', 'wine', 'proton', 'umu'].map((k) => `<option value="${k}" ${cur < 0 && r.kind === k ? 'selected' : ''}>${{ crossover: 'CrossOver', wine: 'Wine', proton: 'Proton', umu: 'umu-run' }[k]} (set the program below)</option>`).join('');
    f.innerHTML = `
      ${found.length ? '' : '<p class="msg bad">Nothing that runs Windows games was found here. Install CrossOver or Wine (macOS), or Wine or Proton (Linux), then reopen Settings.</p>'}
      ${info.runnerOk ? '' : '<p class="msg bad">The way the game is set to run isn\'t on this computer any more: pick another.</p>'}
      <div class="field"><label>Run the Game With</label><select id="rKind">${opts}</select></div>
      <div class="field"><label id="rProgLabel">Program</label><input id="rWine" value="${esc(r.wine || r.proton || r.umu || '')}" spellcheck="false"></div>
      <div class="field" id="rBottleRow"><label>CrossOver bottle</label><input id="rBottle" value="${esc(r.bottle || '')}" spellcheck="false"></div>
      <div class="field" id="rPrefixRow"><label>Prefix</label><input id="rPrefix" value="${esc(r.prefix || '')}" placeholder="Default" spellcheck="false"></div>
      <p class="dim">If the game doesn't start, or stops right away, try another one here: Proton often runs it when Wine doesn't.</p>`;
    const kindOf = () => { const v = $('#rKind').value; return v[0] === 'f' ? found[+v.slice(1)].kind : v; };
    const sync = () => {
      const k = kindOf();
      $('#rBottleRow').hidden = k !== 'crossover';
      $('#rPrefixRow').hidden = k === 'crossover';
      $('#rProgLabel').textContent = { crossover: "CrossOver's wine", wine: 'Wine program', proton: 'Proton (its proton file)', umu: 'umu-run' }[k];
      $('#rPrefix').placeholder = k === 'wine' ? 'Default (~/.wine)' : 'Default (in the install folder)';
    };
    $('#rKind').onchange = () => {
      const v = $('#rKind').value;
      if (v[0] === 'f') { const x = found[+v.slice(1)]; $('#rWine').value = x.wine || x.proton || x.umu || ''; if (x.bottle) $('#rBottle').value = x.bottle; }
      else $('#rWine').value = v === 'crossover' ? '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine' : v === 'wine' ? 'wine' : '';
      sync();
    };
    sync();
  }
  $('#debugTools').hidden = !info.debug;
  $('#setSpeed').value = info.settings.speedUnit === 'mbps' ? 'mbps' : 'mbs';
  $('#setSwitchSlow').checked = info.settings.switchSlow !== false;
  $('#setLogDir').textContent = info.logDir || '';
  $('#setLogDir').title = info.logDir || '';
  $('#debugNote').textContent = info.debug ? 'Debug mode is on: the game\'s output is saved in the launcher\'s logs folder.'
    : 'Debug mode (more detail in the logs): start the launcher with --debug.';
  const cur = current();
  // This Server: Whatever's picked in the list (game settings, files, logs)
  $('#serverSec').hidden = !cur;
  if (cur) {
    $('#setServerName').textContent = cur.manifest ? cur.manifest.label : cur.source;
    $('#removeName').textContent = cur.manifest ? cur.manifest.label : cur.source;
    loadServerLog(cur.id);
  }
  if (cur) $('#feedUrl').value = cur.feed || '';
  loadSoftware();
  $('#settings').showModal();
};
$('#settingsClose').onclick = () => $('#settings').close();
$('#settingsSave').onclick = async () => {
  if (info.platform !== 'win32') {
    const found = info.runners || [];
    const v = $('#rKind').value;
    const base = v[0] === 'f' ? found[+v.slice(1)] : { kind: v, name: '' };
    const prog = $('#rWine').value.trim();
    const runner = { ...base, wine: '', proton: '', umu: '', bottle: $('#rBottle').value.trim(), prefix: $('#rPrefix').value.trim() };
    runner[base.kind === 'proton' ? 'proton' : base.kind === 'umu' ? 'umu' : 'wine'] = prog;
    info = await launcher.setSettings({ runner });
  }
  const cur = current();
  if (cur && ($('#feedUrl').value.trim() !== (cur.feed || ''))) {
    try { info = await launcher.setFeed({ id: cur.id, feed: $('#feedUrl').value }); newsFor = ''; } catch (e) { alert(e.message); return; }
  }
  render();
  $('#settings').close();
};

// ---- Events ----

launcher.onHealth(({ id, health }) => {
  const s = info && info.servers.find((x) => x.id === id);
  if (!s) return;
  s.health = health;
  render();
  if (id === newsFor && health && health.shards) loadNews(false);
});
launcher.onPatch((p) => {
  patchState[p.id] = p;
  if (p.phase === 'done' || p.phase === 'cancelled') { const s = info.servers.find((x) => x.id === p.id); if (s) s.patching = false; render(); }
  else renderPatch(p.id);
});
launcher.onInfo((v) => { info = v; render(); });

function render() {
  if (!info) return;
  applyTheme(info.settings.theme || 'auto');
  renderList();
  renderDetail();
}

setInterval(() => { if (info) renderDetail(); }, 15000); // keeps "checked N s ago" fresh
launcher.info().then((v) => { info = v; render(); if (info.welcome) showWelcome(); else needRunner(); });

// ---- Launcher updates ----

let swInfo = null;
let swLast = null;

function renderSoftware() {
  const avail = !!(swLast && swLast.ok && swLast.available);
  $('#appUpdateBtn').hidden = !avail;
  $('#swUpdate').hidden = !avail;
  if (!swInfo) return;
  $('#swVersion').textContent = swInfo.version;
  $('#swAuto').checked = swInfo.auto;
  const r = swLast;
  $('#swStatus').textContent = !r ? 'Not checked yet'
    : !r.ok ? `Couldn't check: ${r.error}`
    : avail ? `Version ${r.latest} is out. Download Update opens its page: grab the one for your system.`
    : `Up to date (checked ${new Date(r.checkedAt).toLocaleTimeString()})`;
  $('#swNew').innerHTML = avail && r.notes ? r.notes.split('\n').map((l) => l.replace(/^[-*] ?/, '').trim()).filter(Boolean).slice(0, 10)
    .map((l) => `<li>${esc(l)}</li>`).join('') : '';
}

async function loadSoftware() {
  try { swInfo = await launcher.appVersion(); swLast = swInfo.last || swLast; } catch { return; }
  renderSoftware();
}

async function swUpdate() {
  if (!swLast || !swLast.available) return;
  await launcher.appUpdate();
}

$('#swCheck').onclick = async () => {
  $('#swCheck').disabled = true; $('#swStatus').textContent = 'Checking...';
  try { swLast = await launcher.appCheckUpdate(); } catch (e) { swLast = { ok: false, error: e.message }; }
  $('#swCheck').disabled = false;
  renderSoftware();
};
$('#swUpdate').onclick = swUpdate;
$('#appUpdateBtn').onclick = swUpdate;
$('#swAuto').onchange = async (e) => { await launcher.appSetAutoUpdate(e.target.checked); if (swInfo) swInfo.auto = e.target.checked; };
launcher.onAppUpdate((r) => { swLast = r; renderSoftware(); });
loadSoftware();

// ---- Logs card: What the launcher did for this server, newest at the bottom ----

let logFor = '';
const logClass = (l) => (/FAILED|failed|Couldn't|stopped right after/.test(l) ? 'bad' : /Done: |up to date|Started /.test(l) ? 'ok' : '');
function showLog(text) {
  const lines = String(text || '').split('\n').filter((l) => l.trim()).slice(-300);
  const box = $('#sLog');
  box.innerHTML = lines.length ? lines.map((l) => { const c = logClass(l); return c ? `<span class="${c}">${esc(l)}</span>` : esc(l); }).join('\n')
    : '<span class="dim">Nothing yet. Downloads and starts of the game show here.</span>';
  box.scrollTop = box.scrollHeight;
}
async function loadServerLog(id) {
  logFor = id;
  try {
    const r = await launcher.serverLog(id);
    if (logFor !== id) return;
    showLog(r.text);
    $('#sCopyCrashes').disabled = !r.crashes;
    $('#sCopyCrashes').title = r.crashes ? `${r.crashes} crash report${r.crashes === 1 ? '' : 's'} in the install folder (the newest 5 are copied)` : 'No crash reports in the install folder';
  } catch (e) { showLog(`Couldn't read the log: ${e.message}`); }
}
launcher.onServerLog(({ id, line }) => {
  if (id !== logFor) return;
  const box = $('#sLog');
  if (box.querySelector('.dim')) box.innerHTML = '';
  const c = logClass(line);
  box.insertAdjacentHTML('beforeend', `${box.innerHTML ? '\n' : ''}${c ? `<span class="${c}">${esc(line)}</span>` : esc(line)}`);
  box.scrollTop = box.scrollHeight;
  if (/FAILED/.test(line)) loadServerLog(id); // refresh the crash report count after a failed start
});
const logMsg = (t, c = '') => { $('#sLogMsg').textContent = t; $('#sLogMsg').className = `msg ${c}`; };
$('#sCopyLogs').onclick = async () => {
  const s = current(); if (!s) return;
  try { await launcher.copyLogs(s.id); logMsg('Copied: paste it in a bug report or a chat', 'ok'); } catch (e) { logMsg(e.message, 'bad'); }
};
$('#sCopyCrashes').onclick = async () => {
  const s = current(); if (!s) return;
  try { const r = await launcher.copyCrashes(s.id); logMsg(r.count ? `Copied ${r.count} crash report${r.count === 1 ? '' : 's'}` : 'No crash reports in the install folder', r.count ? 'ok' : ''); } catch (e) { logMsg(e.message, 'bad'); }
};
$('#sLogsFolder').onclick = () => launcher.revealLogs();

// The game died right after starting (Wine/Proton couldn't run it): Say so next to Play
launcher.onPlayFail(({ id, message }) => { if (current() && current().id === id) setMsg(message, 'bad'); });
// The game after it got going: running, closed (the line clears), or closed on a crash
launcher.onGame(({ id, state, why }) => {
  if (state === 'crashed') loadServerLog(id);
  if (!current() || current().id !== id) return;
  if (state === 'running') setMsg('The game is running.', 'ok');
  else if (state === 'closed') setMsg('');
  else if (state === 'crashed') setMsg(`The game closed unexpectedly (${why}). Copy Logs (Settings, This Server) has the details for your server's staff.`, 'bad');
});
// A download that got cut off last time, picked back up at start
launcher.onResumed(({ id }) => { if (current() && current().id === id) setMsg('Picking the download up where it left off...', 'ok'); });

// ---- First run: Pick the servers you play on. --welcome shows it again ----

async function showWelcome() {
  let known = [];
  try { known = await launcher.knownServers(); } catch { /* offline, but the address box still works */ }
  $('#wlList').innerHTML = known.map((k, i) => `<label class="${k.added ? 'added' : ''}"><input type="checkbox" data-i="${i}" ${k.added ? 'checked disabled' : ''}>
    <span><span class="wlName">${esc(k.name)}</span>${k.added ? ' <span class="dim">(added)</span>' : ''}<br><span class="wlSite">${esc(k.site || k.source)}</span></span></label>`).join('')
    || '<p class="dim">Couldn\'t load the list of known servers. Add one by its manifest address.</p>';
  $('#wlUrl').value = '';
  $('#wlMsg').textContent = '';
  $('#wlAdd').onclick = async () => {
    const picks = [...$$('#wlList input:checked:not(:disabled)')].map((x) => known[+x.dataset.i].source);
    const url = $('#wlUrl').value.trim();
    if (url) picks.push(url);
    if (!picks.length) { $('#wlMsg').textContent = 'Tick a server, or paste a manifest address.'; return; }
    $('#wlAdd').disabled = true;
    for (const src of picks) {
      $('#wlMsg').className = 'msg'; $('#wlMsg').textContent = `Adding ${src}...`;
      try { info = await launcher.addServer(src); } catch (e) { $('#wlMsg').className = 'msg bad'; $('#wlMsg').textContent = `${src}: ${e.message}`; $('#wlAdd').disabled = false; return; }
    }
    $('#wlAdd').disabled = false;
    await launcher.welcomeDone();
    $('#welcomeDlg').close();
    render();
    needRunner();
  };
  $('#wlSkip').onclick = async () => { await launcher.welcomeDone(); $('#welcomeDlg').close(); needRunner(); };
  $('#welcomeDlg').showModal();
}
$('#showWelcome').onclick = () => { $('#settings').close(); showWelcome(); };

$('#setLogOpen').onclick = () => launcher.revealLogs();
$('#setLogCopy').onclick = async () => { try { await navigator.clipboard.writeText(info.logDir || ''); $('#setLogCopy').textContent = 'Copied'; setTimeout(() => { $('#setLogCopy').textContent = 'Copy'; }, 1500); } catch { /* no clipboard */ } };
$('#setSpeed').onchange = async () => { info = await launcher.setSettings({ speedUnit: $('#setSpeed').value }); };

// ---- Nothing to run Windows games with: Say what to install, once per start. If they already
// have CrossOver, Wine or Proton this never shows ----

function needRunner() {
  if (!info || info.platform === 'win32' || (info.runners && info.runners.length)) return;
  const mac = info.platform === 'darwin';
  $('#rdText').textContent = mac
    ? "City of Heroes is a Windows game, so on a Mac it runs through a compatibility layer. The launcher didn't find one. Install one of these:"
    : "City of Heroes is a Windows game, so on Linux it runs through Wine or Proton. The launcher didn't find either. Install one of these:";
  const items = mac ? [
    ['CrossOver', 'Paid, with a free trial. The easiest and most reliable.', 'https://www.codeweavers.com/crossover'],
    ['Whisky', 'Free. Uses Apple\'s Game Porting Toolkit.', 'https://getwhisky.app/'],
    ['Wine (Homebrew)', 'Free. In a terminal: brew install --cask wine-stable', 'https://wiki.winehq.org/MacOS'],
  ] : [
    ['Proton (through Steam)', 'Free. Install Steam, then any Proton version from its library (Tools). GE-Proton works too.', 'https://store.steampowered.com/about/'],
    ['Wine', 'Free. From your package manager, for example: sudo apt install wine, or sudo dnf install wine', 'https://wiki.winehq.org/Download'],
    ['umu-run', 'Free. Proton without Steam.', 'https://github.com/Open-Wine-Components/umu-launcher'],
  ];
  $('#rdList').innerHTML = items.map(([n, d, u]) => `<li><button class="link" data-url="${esc(u)}">${esc(n)}</button><span class="dim"> ${esc(d)}</span></li>`).join('');
  $('#rdList').onclick = (e) => { const u = e.target.dataset.url; if (u) launcher.open(u); };
  $('#rdOk').onclick = () => $('#runnerDlg').close();
  $('#runnerDlg').showModal();
}

// ---- Health chip dropdown: Each shard's status, players and maps ----

function renderShards(s) {
  const hl = s.health;
  const box = $('#sShards');
  const h = healthWords(hl);
  const num = (v) => (v === null || v === undefined ? '' : v.toLocaleString());
  const dotOf = (x) => (x.up ? 'up' : x.state === 'starting' || x.state === 'maintenance' ? 'unknown' : 'down');
  const stateOf = (x) => (x.up ? 'Up' : x.state === 'starting' ? 'Starting' : x.state === 'maintenance' ? 'Maintenance' : 'Down');
  const load = (x) => (x.load ? x.load[0].toUpperCase() + x.load.slice(1) : '');
  // Summary up top: The status, then a tile for each number so nothing wraps
  const tiles = [];
  if (hl) {
    if (hl.players !== null && hl.players !== undefined) tiles.push(['Online', num(hl.players)]);
    if (hl.serversTotal) tiles.push([hl.shards ? 'Shards Up' : 'Servers Up', `${hl.serversUp}/${hl.serversTotal}`]);
    if (hl.maps) tiles.push(['Maps', num(hl.maps)]);
    if (hl.ms !== null && hl.ms !== undefined) tiles.push(['Ping', `${hl.ms} ms`]);
  }
  let html = `<section class="popSec popHead"><div class="popState"><span class="dot ${h.cls || 'unknown'}"></span><b>${esc(h.state)}</b>${hl && hl.message ? `<span class="dim">${esc(hl.message)}</span>` : ''}</div>
    ${tiles.length ? `<div class="tiles">${tiles.map(([k, v]) => `<div class="tile"><span class="tv">${esc(v)}</span><span class="tk">${esc(k)}</span></div>`).join('')}</div>`
      : h.detail ? `<p class="dim">${esc(h.detail)}</p>` : ''}</section>`;
  // Live shards, then test shards (the ones only the status page has)
  const table = (rows, total) => `<table class="shards"><colgroup><col><col class="cS"><col class="cL"><col class="cN"><col class="cN"></colgroup><thead><tr><th>Shard</th><th>Status</th><th>Load</th><th>Online</th><th>Maps</th></tr></thead><tbody>${rows.map((x) => `<tr class="${x.up ? '' : 'off'}">
      <td><span class="dot ${dotOf(x)}"></span>${esc(x.name)}</td><td>${stateOf(x)}</td><td>${esc(load(x))}</td><td>${num(x.players)}</td><td>${num(x.maps)}</td></tr>`).join('')}</tbody>${total || ''}</table>`;
  if (hl && hl.shards) {
    const live = hl.shards.filter((x) => !x.extra);
    const test = hl.shards.filter((x) => x.extra);
    const sum = (list, k) => (list.some((x) => x[k] !== null && x[k] !== undefined) ? list.reduce((t, x) => t + (x[k] || 0), 0) : null);
    const total = (list) => `<tfoot><tr class="total"><td>Total</td><td>${list.filter((x) => x.up).length}/${list.length} Up</td><td></td><td>${num(sum(list, 'players'))}</td><td>${num(sum(list, 'maps'))}</td></tr></tfoot>`;
    if (live.length) html += `<section class="popSec"><h4>${test.length ? 'Live Shards' : 'Shards'}</h4>${table(live, total(live))}</section>`;
    if (test.length) html += `<section class="popSec"><h4>Test Shards</h4>${table(test, total(test))}</section>`;
    if (hl.pageError) html += `<section class="popSec"><p class="dim">Players and maps: ${esc(hl.pageError)}</p></section>`;
  }
  html += `<section class="popSec popFoot dim">${hl ? `<span>Checked ${esc(ago(hl.checked))}</span>` : '<span></span>'}<button class="link" id="sRecheck">Check Now</button></section>`;
  box.innerHTML = html;
  $('#sRecheck').onclick = async (e) => { e.stopPropagation(); await launcher.checkHealth(s.id); };
}
$('#sHealthChip').onclick = (e) => { e.stopPropagation(); $('#sShards').hidden = !$('#sShards').hidden; };
document.addEventListener('click', (e) => { if (!e.target.closest('.healthWrap')) $('#sShards').hidden = true; });

$('#setSwitchSlow').onchange = async () => { info = await launcher.setSettings({ switchSlow: $('#setSwitchSlow').checked }); };
