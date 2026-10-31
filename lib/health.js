// Server health: Is it up?
// - Known servers with a public status page (Homecoming's /status/) and/or a shard status API
//   (api.homecomingservers.com/shardstatus/live: [{ name, status }] where status is low, medium,
//   high, offline, starting or maintenance). With both, the API says what's up and how busy,
//   and the page fills in players and maps.
// - Everything else: Try connecting to the login server (-auth host, TCP 2106) and time it.
//   UDP-only servers with no status page just show "unknown".
'use strict';

const net = require('net');
const { loginTarget } = require('./manifest');

function tcpProbe(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host, port });
    const done = (up, error) => { sock.destroy(); resolve({ up, ms: up ? Date.now() - t0 : null, error }); };
    sock.setTimeout(timeoutMs, () => done(false, 'no answer'));
    sock.once('connect', () => done(true));
    sock.once('error', (e) => done(false, e.code || e.message));
  });
}

// Status page as an HTML table. We find columns by their headings so order doesn't matter:
// Name, status (OK/Up/Online), players, maps. Any Total row gets skipped, we add it up ourselves
const cellText = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n)).replace(/\s+/g, ' ').trim();
const num = (t) => { const m = String(t).replace(/[,\s]/g, '').match(/^-?\d+/); return m ? +m[0] : null; };
function parseStatusTable(html) {
  for (const t of String(html).match(/<table[\s\S]*?<\/table>/gi) || []) {
    const rows = (t.match(/<tr[\s\S]*?<\/tr>/gi) || []).map((r) => (r.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || []).map(cellText));
    const hi = rows.findIndex((r) => r.some((c) => /online|players/i.test(c)) && r.some((c) => /status/i.test(c)));
    if (hi < 0) continue;
    const head = rows[hi];
    const col = (re) => head.findIndex((c) => re.test(c));
    const cName = Math.max(0, col(/shard|server|name/i));
    const cStatus = col(/status/i);
    const cOnline = col(/online|players/i);
    const cMaps = col(/map/i);
    const shards = [];
    for (const r of rows.slice(hi + 1)) {
      if (r.length < head.length - 1 || !r[cName] || /^total/i.test(r[cName])) continue;
      shards.push({ name: r[cName].slice(0, 40), up: /^(ok|up|online|running)\b/i.test(r[cStatus] || ''),
        players: num(r[cOnline]), maps: cMaps >= 0 ? num(r[cMaps]) : null });
    }
    if (shards.length) return shards;
  }
  // Homecoming's page is divs instead: One per shard (data-shard="Name"), numbers in
  // .shard-status, .shard-playing and .shard-maps
  const grid = [];
  const rowRe = /<div[^>]*\bdata-shard=['"]([^'"]{1,40})['"][^>]*>([\s\S]*?)(?=<div[^>]*\bdata-shard=|<\/div>\s*<\/div>\s*<\/div>|$)/gi;
  let m;
  while ((m = rowRe.exec(String(html))) && grid.length < 64) {
    const cell = (cls) => { const c = m[2].match(new RegExp(`class=['"][^'"]*\\b${cls}\\b[^'"]*['"][^>]*>([\\s\\S]*?)<\\/div>`, 'i')); return c ? cellText(c[1]) : ''; };
    grid.push({ name: cellText(m[1]), up: /^(ok|up|online|running)\b/i.test(cell('shard-status')), players: num(cell('shard-playing')), maps: num(cell('shard-maps')) });
  }
  return grid.length ? grid : null;
}
async function htmlStatusPage(url, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'text/html', 'user-agent': 'IncarnateLauncher/0.2 (+status)' }, redirect: 'follow' });
    if (!r.ok) return { up: null, error: `status page: HTTP ${r.status}` };
    const shards = parseStatusTable((await r.text()).slice(0, 1024 * 1024));
    if (!shards) return { up: null, error: "status page: couldn't find its table of shards" };
    const sum = (k) => shards.reduce((a, x) => a + (x[k] || 0), 0);
    const up = shards.filter((x) => x.up);
    return { up: up.length > 0, ms: Date.now() - t0, players: sum('players'), serversUp: up.length, serversTotal: shards.length,
      maps: shards.some((x) => x.maps !== null) ? sum('maps') : null, shards, message: '', source: 'statuspage' };
  } catch (e) {
    return { up: null, error: e.name === 'AbortError' ? "the status page didn't answer" : `status page: ${e.cause ? e.cause.code || e.cause.message : e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// Shard status API: The official word on each shard (up, how busy, starting, maintenance)
const API_STATES = { low: 'up', medium: 'up', high: 'up', offline: 'down', starting: 'starting', maintenance: 'maintenance' };
async function shardStatusApi(url, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'IncarnateLauncher/0.2 (+status)' }, redirect: 'follow' });
    if (!r.ok) return { error: `status API: HTTP ${r.status}` };
    const j = await r.json();
    if (!Array.isArray(j)) return { error: 'status API: not a list of shards' };
    const shards = j.filter((x) => x && typeof x.name === 'string' && typeof x.status === 'string').slice(0, 64).map((x) => {
      const st = String(x.status).toLowerCase();
      return { name: x.name.slice(0, 40), state: API_STATES[st] || 'unknown', load: /^(low|medium|high)$/.test(st) ? st : null, up: API_STATES[st] === 'up', players: null, maps: null };
    });
    return { shards, ms: Date.now() - t0 };
  } catch (e) {
    return { error: e.name === 'AbortError' ? "the status API didn't answer" : `status API: ${e.cause ? e.cause.code || e.cause.message : e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// API shards with the page's numbers matched up by name. Shards only the page has (test and
// event shards) go at the end
function mergeShards(api, page) {
  const byName = new Map((page || []).map((x) => [x.name.toLowerCase(), x]));
  const out = api.map((x) => {
    const p = byName.get(x.name.toLowerCase());
    byName.delete(x.name.toLowerCase());
    return p ? { ...x, players: p.players, maps: p.maps } : x;
  });
  for (const p of byName.values()) out.push({ ...p, state: p.up ? 'up' : 'down', load: null, extra: true });
  return out;
}

async function checkHealth(manifest, extra = {}) {
  const profile = manifest.profiles[0];
  const target = profile ? loginTarget(profile.params) : null;
  if (extra.statusApi || extra.statusPage) {
    const [a, pg] = await Promise.all([
      extra.statusApi ? shardStatusApi(extra.statusApi) : null,
      extra.statusPage ? htmlStatusPage(extra.statusPage) : null]);
    const page = pg && !pg.error ? pg : null;
    if (a && !a.error) {
      const shards = mergeShards(a.shards, page && page.shards);
      const main = shards.filter((x) => !x.extra);
      const up = main.filter((x) => x.up).length;
      const sum = (k) => shards.reduce((t, x) => t + (x[k] || 0), 0);
      const maint = main.filter((x) => x.state === 'maintenance').length;
      return { up: up > 0 ? true : maint ? null : false, ms: a.ms, serversUp: up, serversTotal: main.length,
        players: page ? sum('players') : null, maps: page && shards.some((x) => x.maps !== null) ? sum('maps') : null,
        shards, message: maint ? `${maint} in maintenance` : '', source: 'statusapi', checked: Date.now(),
        pageError: extra.statusPage && !page ? (pg && pg.error) || 'no answer' : undefined,
        error: up === 0 && maint ? 'maintenance' : undefined };
    }
    if (page) return { ...page, checked: Date.now() };
  }
  if (target && target.kind === 'auth') {
    const p = await tcpProbe(target.host, target.port);
    // Refused/unreachable = down. No answer at all is only "unknown", since a firewall that
    // drops everything but game traffic looks exactly like a dead server
    if (!p.up && p.error === 'no answer') return { up: null, source: 'login', error: `the login server (${target.host}:${target.port}) didn't answer; it may only answer the game`, checked: Date.now() };
    // Refused = down. Just say Down, nobody needs to see ECONNREFUSED
    return { ...p, ...(!p.up && p.error === 'ECONNREFUSED' ? { error: '' } : {}), source: 'login', checked: Date.now() };
  }
  return { up: null, source: 'none', error: target ? 'no status page (this server is reached over UDP)' : 'no login address in the manifest', checked: Date.now() };
}

module.exports = { checkHealth, tcpProbe, htmlStatusPage, parseStatusTable, shardStatusApi, mergeShards };
