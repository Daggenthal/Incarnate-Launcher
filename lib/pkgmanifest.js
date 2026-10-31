// Homecoming's newer manifest format (what their own launcher uses now). Two kinds of JSON, both
// wrapped like this, with the cert and signature first:
//
//   -----BEGIN CERTIFICATE----- ... -----BEGIN SIGNATURE----- ... -----BEGIN CONTENT-----
//   { json } -----END CONTENT-----
//
// A profile (profile/live.json) says how to start the game and which package it needs:
//   { id, name, package, packageurl, packageroot, args: [...], arch: [{ id, exe }], news, status, links }
// A package (pkg/hc_live.json) either lists files, or other packages each with their own folder:
//   { files: [{ name, size, sha256, sources: { web: [{ url, priority, compress }] } }] }
//   { dependencies: [{ name, root, alternates: [{ id, urls, version }] }] }
//
// We turn all of that into the same shape parseManifest() gives back, so the rest of the launcher
// doesn't care which format a server uses.
'use strict';

const crypto = require('crypto');
const { safeRelative } = require('./manifest');

// Does this look like one of these (and not an XML manifest)?
function isPkgManifest(text) {
  const t = String(text || '').trimStart();
  return t.startsWith('-----BEGIN') || t.startsWith('{');
}

// Split the wrapper. Plain JSON (no wrapper) works too, just unsigned
function unwrap(text) {
  const block = (name) => {
    const m = new RegExp(`-----BEGIN ${name}-----\\r?\\n?([\\s\\S]*?)\\r?\\n?-----END ${name}-----`).exec(text);
    return m ? m[1] : null;
  };
  const content = block('CONTENT');
  if (content === null) return { json: JSON.parse(text), signed: null };
  const cert = block('CERTIFICATE');
  const sig = block('SIGNATURE');
  return { json: JSON.parse(content), signed: cert && sig ? checkSignature(cert, sig, content) : null };
}

// We don't know exactly how they sign, so try the usual ways. true = it checks out, false = it
// doesn't with any of them (could just be us), null = nothing to check. Never blocks anything
function checkSignature(certB64, sigB64, content) {
  try {
    const pem = `-----BEGIN CERTIFICATE-----\n${certB64.replace(/\s+/g, '').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
    const key = new crypto.X509Certificate(pem).publicKey;
    const sig = Buffer.from(sigB64.replace(/\s+/g, ''), 'base64');
    const bodies = [content, `${content}\n`, content.trim(), content.replace(/\r\n/g, '\n')];
    for (const algo of ['sha256', 'sha512', 'sha384', 'sha1']) {
      for (const b of bodies) {
        try { if (crypto.verify(algo, Buffer.from(b), key, sig)) return true; } catch { /* wrong algo for this key */ }
      }
    }
    return false;
  } catch { return null; }
}

// Fetch one of their JSON files, trying each url it's listed under
async function getJson(urls, get) {
  let lastError;
  for (const u of urls) {
    try { return unwrap(await get(u)); } catch (e) { lastError = e; }
  }
  throw lastError || new Error('no address for it');
}

// "/bin/win64" + "/live" + "cityofheroes.exe" -> "bin/win64/live/cityofheroes.exe" (or '' if
// it tries to get out of the install folder)
function joinRoot(...parts) {
  const p = parts.filter(Boolean).join('/').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+/, '');
  return safeRelative(p);
}

// A package's files, plus everything its dependencies pull in, each under its own root
async function packageFiles(pkg, root, get, seen, info) {
  const out = [];
  if (seen.has(pkg.id || root)) return out;
  seen.add(pkg.id || root);
  for (const f of pkg.files || []) {
    const name = joinRoot(root, f.name);
    if (!name) continue; // never write outside the install folder!
    const web = ((f.sources && f.sources.web) || []).filter((s) => /^https?:\/\//i.test(s.url || ''))
      .map((s, i) => ({ ...s, i })).sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50) || a.i - b.i);
    // Keep the mirrors that pack it the same way as the best one, so one file has one format
    const compress = web.length ? (web[0].compress || '') : '';
    out.push({
      name,
      size: Number(f.size || 0),
      md5: (f.md5 || '').toLowerCase(),
      sha256: (f.sha256 || '').toLowerCase(),
      compress: compress === 'none' ? '' : compress,
      urls: web.filter((s) => (s.compress || '') === (web[0].compress || '')).map((s) => s.url),
    });
  }
  const deps = await Promise.all((pkg.dependencies || []).map(async (d) => {
    const alt = (d.alternates || [])[0];
    if (!alt || !(alt.urls || []).length) return [];
    const { json, signed } = await getJson(alt.urls, get);
    info.signed.push(signed);
    info.packages.push({ id: alt.id || json.id, name: d.name, version: alt.version || json.version });
    return packageFiles(json, joinRoot(root, d.root) || root, get, seen, info);
  }));
  for (const list of deps) out.push(...list);
  return out;
}

// Quote an argument if it has spaces, so splitParams() gives it back in one piece
const quote = (a) => (/\s/.test(a) ? `"${a}"` : a);

// Profile or package text -> the launcher's manifest shape. get(url) fetches text
async function parsePkgManifest(text, source, get) {
  const top = unwrap(text);
  const info = { signed: [top.signed], packages: [] };
  let profileJson = null;
  let pkg = top.json;
  let root = '';
  if (top.json.package || top.json.packageurl) {
    profileJson = top.json;
    const urls = [top.json.packageurl].filter(Boolean);
    if (!urls.length) throw new Error(`the profile names package ${top.json.package} but not where it is`);
    const p = await getJson(urls, get);
    info.signed.push(p.signed);
    pkg = p.json;
    root = top.json.packageroot || '';
  }
  info.packages.unshift({ id: pkg.id, name: pkg.name, version: pkg.displayver || pkg.version });
  const files = await packageFiles(pkg, root, get, new Set(), info);
  if (!files.length) throw new Error('the package lists no files');

  // How to start it: one profile per exe (64-bit first), same arguments
  const profiles = [];
  if (profileJson) {
    const vars = { profile: profileJson.id || 'live' };
    const args = (profileJson.args || []).map((a) => String(a).replace(/\$\{string:(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)));
    const params = args.map(quote).join(' ');
    const arch = [...(profileJson.arch || [])].sort((a, b) => (a.id === 'win64' ? 0 : 1) - (b.id === 'win64' ? 0 : 1));
    arch.forEach((a, i) => {
      const exec = joinRoot(profileJson.packageroot, a.exe);
      if (exec) profiles.push({ name: `${profileJson.name || 'Play'}${arch.length > 1 ? ` (${a.id === 'win64' ? '64-bit' : a.id === 'win32' ? '32-bit' : a.id})` : ''}`, exec, params, order: i, architecture: a.id || '', motd: '', website: '', icon: '' });
    });
  }

  const signed = info.signed.filter((x) => x !== null);
  return {
    label: (profileJson && profileJson.name) || pkg.name || source || 'Unnamed server',
    profiles,
    files,
    webpage: '',
    poster: '',
    forums: ((profileJson && profileJson.links) || []).filter((l) => /^https?:/i.test(l.url || '')).map((l) => ({ name: l.name || l.url, url: l.url })),
    format: 'pkg',
    version: pkg.displayver || pkg.version || '',
    packages: info.packages,
    // true: every signature checked out; false: at least one didn't; null: nothing signed
    signed: signed.length ? signed.every(Boolean) : null,
    news: (profileJson && /^https?:/i.test(profileJson.news || '')) ? profileJson.news : '',
    statusApi: (profileJson && /^https?:/i.test(profileJson.status || '')) ? profileJson.status : '',
  };
}

module.exports = { isPkgManifest, parsePkgManifest, unwrap, checkSignature };
