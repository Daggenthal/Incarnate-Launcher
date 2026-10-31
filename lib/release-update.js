// Is there a newer launcher? Ask GitHub for the latest release and compare versions.
// We don't download or install anything: It shows Update Available, and the button opens the
// release page so you grab the build for your OS.
'use strict';

const REPO = 'Daggenthal/Incarnate-Launcher';

// "v1.2.10" or "1.2.10" -> [1, 2, 10]. Anything with a dash (1.3.0-test) counts as older
function parse(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(-.+)?$/);
  return m ? { n: [+m[1], +(m[2] || 0), +(m[3] || 0)], pre: !!m[4] } : null;
}
function newer(a, b) {
  const x = parse(a); const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] > y.n[i];
  return !x.pre && y.pre;
}

async function check(current, { repo = REPO, timeoutMs = 10000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      signal: ctl.signal, headers: { accept: 'application/vnd.github+json', 'user-agent': 'IncarnateLauncher' } });
    if (r.status === 404) return { ok: true, available: false, current, latest: null, checkedAt: Date.now() };
    if (!r.ok) return { ok: false, error: `GitHub said HTTP ${r.status}`, current, checkedAt: Date.now() };
    const j = await r.json();
    const latest = String(j.tag_name || '').replace(/^v/i, '');
    return { ok: true, available: newer(latest, current), current, latest, url: j.html_url, notes: String(j.body || '').slice(0, 2000),
      published: j.published_at, checkedAt: Date.now() };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? "GitHub didn't answer" : e.message, current, checkedAt: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { check, newer, parse, REPO };
