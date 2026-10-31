// What can run the game (it's a Windows exe). We look once at start, list them in Settings,
// and new players just get the first one we find.
//
//   Windows:  the game directly (native)
//   macOS:    CrossOver, Whisky's Wine, or a Wine on the PATH (Homebrew, Wine Stable.app)
//   Linux:    a Wine on the PATH, Proton (Steam's, or GE-Proton in compatibilitytools.d), or
//             umu-run (Proton outside Steam)
//
// Each runner is { kind, name, wine | proton | umu, ... }, which is what lib/launch.js wants.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CROSSOVER_WINE = '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine';

function onPath(name, env = process.env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, name);
    try { if (fs.statSync(full).isFile()) { fs.accessSync(full, fs.constants.X_OK); return full; } } catch { /* nope */ }
  }
  return null;
}

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

// Proton builds: Steam's own (steamapps/common/Proton*) and custom ones like GE-Proton
// (compatibilitytools.d), sorted oldest to newest
function protons(home) {
  const steams = [path.join(home, '.steam', 'steam'), path.join(home, '.local', 'share', 'Steam'),
    path.join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam')];
  const out = [];
  const seen = new Set();
  for (const steam of steams) {
    for (const sub of [path.join('steamapps', 'common'), 'compatibilitytools.d']) {
      let names = [];
      try { names = fs.readdirSync(path.join(steam, sub)); } catch { continue; }
      for (const n of names.sort()) {
        const proton = path.join(steam, sub, n, 'proton');
        if (!/proton/i.test(n) || !exists(proton)) continue;
        const real = fs.realpathSync(proton);
        if (seen.has(real)) continue;
        seen.add(real);
        out.push({ kind: 'proton', name: n, proton, steam });
      }
    }
  }
  return out;
}

function detectRunners({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'win32') return [{ kind: 'native', name: 'Windows (runs the game directly)' }];
  const found = [];
  if (platform === 'darwin') {
    if (exists(CROSSOVER_WINE)) found.push({ kind: 'crossover', name: 'CrossOver', wine: CROSSOVER_WINE, bottle: 'Incarnate' });
    const whisky = path.join(home, 'Library', 'Application Support', 'com.isaacmarovitz.Whisky', 'Libraries', 'Wine', 'bin', 'wine64');
    if (exists(whisky)) found.push({ kind: 'wine', name: "Whisky's Wine", wine: whisky, prefix: '' });
    for (const p of ['/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine', '/Applications/Wine Staging.app/Contents/Resources/wine/bin/wine']) {
      if (exists(p)) found.push({ kind: 'wine', name: path.basename(path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(p)))))).replace(/\.app$/, ''), wine: p, prefix: '' });
    }
  }
  const wine = onPath('wine', env) || onPath('wine64', env);
  if (wine && !found.some((r) => r.wine === wine)) found.push({ kind: 'wine', name: `Wine (${wine})`, wine, prefix: '' });
  if (platform !== 'darwin') {
    // Newest Proton first, it usually runs the game better
    for (const p of protons(home).reverse()) found.push({ ...p, name: `Proton: ${p.name}` });
    const umu = onPath('umu-run', env);
    if (umu) found.push({ kind: 'umu', name: 'umu-run (Proton outside Steam)', umu });
  }
  return found;
}

// What a new player gets: The first one we found, or null if there's nothing
function pickRunner(found) { return found.length ? { ...found[0] } : null; }

module.exports = { detectRunners, pickRunner, protons, onPath, CROSSOVER_WINE };
