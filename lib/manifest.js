// Manifests: The format Tequila, LaunchCat and Homecoming's launcher all use.
//
//   <manifest>
//     <label>My Shard</label>
//     <profiles>
//       <launch exec="bin\win64\game.exe" params="-auth 1.2.3.4 -patchdir live" order="0">Live</launch>
//     </profiles>
//     <filelist>
//       <file name="piggs/bin.pigg" size="123" md5="..."><url>https://.../bin.pigg</url></file>
//     </filelist>
//     <webpage>https://...</webpage>        what Tequila shows as news (see lib/news.js)
//     <poster_image url="https://..."/>
//     <forums><forum name="Discord" url="https://..."/></forums>
//   </manifest>
//
'use strict';

const path = require('path');
const { parse, child, all } = require('./xml');

function text(el) { return el ? el.text.trim() : ''; }

function parseManifest(xmlText, source) {
  const root = parse(xmlText);
  const m = child(root, 'manifest');
  if (!m) throw new Error('not a launcher manifest (no <manifest> element)');
  const label = text(child(m, 'label')) || source || 'Unnamed server';
  const profiles = all(child(m, 'profiles'), 'launch').map((l, i) => ({
    name: text(l) || `Profile ${i + 1}`,
    exec: (l.attrs.exec || '').trim(),
    params: (l.attrs.params || '').trim(),
    order: Number(l.attrs.order ?? i) || 0,
    architecture: l.attrs.architecture || '',
    // Extras LaunchCat / Thunderspy added: MOTD, the profile's website, its icon
    motd: /^https?:\/\//i.test(l.attrs.motd || '') ? l.attrs.motd : '',
    website: /^https?:\/\//i.test(l.attrs.website || '') ? l.attrs.website : '',
    icon: /^https?:\/\//i.test(l.attrs.icon || '') ? l.attrs.icon : '',
  })).filter((p) => p.exec).sort((a, b) => a.order - b.order);
  const files = [];
  for (const f of all(child(m, 'filelist'), 'file')) {
    const name = safeRelative(f.attrs.name || '');
    if (!name) continue; // never write outside the install folder!
    files.push({
      name,
      size: Number(f.attrs.size || 0),
      md5: (f.attrs.md5 || '').toLowerCase(),
      urls: all(f, 'url').map(text).filter((u) => /^https?:\/\//i.test(u)),
    });
  }
  return {
    label,
    profiles,
    files,
    webpage: text(child(m, 'webpage')),
    poster: (child(m, 'poster_image') || { attrs: {} }).attrs.url || '',
    forums: all(child(m, 'forums'), 'forum').map((f) => ({ name: f.attrs.name || text(f), url: f.attrs.url || '' })).filter((f) => /^https?:/i.test(f.url)),
  };
}

// Turn a manifest file name into a safe path inside the install folder. Returns '' if it tries
// to get out (absolute paths, drive letters, "..")
function safeRelative(name) {
  const n = name.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!n || n.startsWith('/') || /^[a-z]:/i.test(n)) return '';
  const norm = path.posix.normalize(n);
  if (norm === '..' || norm.startsWith('../') || norm.split('/').includes('..')) return '';
  return norm;
}

// Split params the way the Windows command line does (quotes keep words together)
function splitParams(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s || ''))) out.push(m[1] ?? m[2]);
  return out;
}

// Where the client logs in: -auth <host> (login server, TCP 2106), or -db / -cs <host> which
// go straight to the game servers over UDP (can't probe those by connecting)
function loginTarget(params) {
  const a = splitParams(params);
  // host, host:port or [v6]:port. Some clients take -authport N to move the login port
  const hostPort = (v, def) => {
    const m = String(v).match(/^\[([^\]]+)\](?::(\d+))?$/) || String(v).match(/^([^:]+)(?::(\d+))?$/);
    return m ? { host: m[1], port: m[2] ? +m[2] : def } : { host: v, port: def };
  };
  let authPort = 0;
  for (let i = 0; i < a.length - 1; i++) if (a[i].toLowerCase() === '-authport' && /^\d+$/.test(a[i + 1])) authPort = +a[i + 1];
  for (let i = 0; i < a.length - 1; i++) {
    const k = a[i].toLowerCase();
    if (k === '-auth') { const t = hostPort(a[i + 1], 2106); return { kind: 'auth', host: t.host, port: authPort || t.port }; }
    if (k === '-db' || k === '-cs') { const t = hostPort(a[i + 1], 7000); return { kind: 'db', ...t }; }
  }
  return null;
}

module.exports = { parseManifest, safeRelative, splitParams, loginTarget };
