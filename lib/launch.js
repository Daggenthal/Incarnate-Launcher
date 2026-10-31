// Starting the game: Directly on Windows, or through CrossOver, Wine, Proton or umu-run on
// macOS and Linux.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { splitParams } = require('./manifest');

const CROSSOVER_WINE = '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine';

function defaultRunner() {
  if (process.platform === 'win32') return { kind: 'native' };
  if (process.platform === 'darwin') return { kind: 'crossover', wine: CROSSOVER_WINE, bottle: 'Incarnate' };
  return { kind: 'wine', wine: 'wine', prefix: '' };
}

function launch({ dir, profile, runner, extraArgs = [], log = 'ignore' }) {
  const exe = profile.exec.replace(/\\/g, '/');
  if (!fs.existsSync(path.join(dir, exe))) throw new Error(`${profile.exec} isn't in ${dir}. Patch first, or check the install folder.`);
  const env = { ...process.env };
  let args = [...splitParams(profile.params), ...extraArgs];
  // Under Wine/CrossOver the game sees your folders on Z:, so full paths in the options
  // (-assetpath /home/..., or a ; list of them) become Z:/home/...
  if (runner.kind !== 'native') args = args.map((a) => a.split(';').map((p) => (p.startsWith('/') ? `Z:${p}` : p)).join(';'));
  let cmd, argv;
  if (runner.kind === 'native') {
    cmd = path.join(dir, exe); argv = args;
  } else if (runner.kind === 'crossover') {
    if (!fs.existsSync(runner.wine)) throw new Error(`CrossOver's wine isn't at ${runner.wine}. Install CrossOver or change it in Settings.`);
    cmd = runner.wine; argv = ['--bottle', runner.bottle || 'Incarnate', exe, ...args];
    env.WINEDEBUG = env.WINEDEBUG || 'fixme-all';
  } else if (runner.kind === 'proton') {
    // Proton outside Steam: Needs its own prefix (STEAM_COMPAT_DATA_PATH, made on first run) and
    // to know where Steam is, since it reads a few files from there
    if (!runner.proton || !fs.existsSync(runner.proton)) throw new Error(`Proton isn't at ${runner.proton || '(not set)'}. Pick another way to run the game in Settings.`);
    cmd = runner.proton; argv = ['run', exe, ...args];
    env.STEAM_COMPAT_DATA_PATH = runner.prefix || path.join(dir, '.proton-prefix');
    env.STEAM_COMPAT_CLIENT_INSTALL_PATH = runner.steam || '';
    fs.mkdirSync(env.STEAM_COMPAT_DATA_PATH, { recursive: true });
  } else if (runner.kind === 'umu') {
    if (!runner.umu || !fs.existsSync(runner.umu)) throw new Error(`umu-run isn't at ${runner.umu || '(not set)'}. Pick another way to run the game in Settings.`);
    cmd = runner.umu; argv = [exe, ...args];
    env.WINEPREFIX = runner.prefix || path.join(dir, '.umu-prefix');
    env.GAMEID = env.GAMEID || 'umu-0';
  } else {
    cmd = runner.wine || 'wine'; argv = [exe, ...args];
    if (runner.prefix) env.WINEPREFIX = runner.prefix;
    // The Wine the launcher installed: its own prefix, made on first run, and no "install Wine
    // Mono / Gecko?" boxes (the game needs neither)
    if (runner.managed) {
      if (runner.prefix) fs.mkdirSync(path.dirname(runner.prefix), { recursive: true });
      env.WINEDLLOVERRIDES = [env.WINEDLLOVERRIDES, 'mscoree,mshtml='].filter(Boolean).join(';');
    }
    env.WINEDEBUG = env.WINEDEBUG || 'fixme-all';
  }
  // Debug mode: Game and Wine output go to a log file instead of nowhere
  let stdio = 'ignore';
  if (log !== 'ignore') { const fd = fs.openSync(log, 'a'); stdio = ['ignore', fd, fd]; }
  const child = spawn(cmd, argv, { cwd: dir, env, detached: true, stdio });
  if (Array.isArray(stdio)) fs.closeSync(stdio[1]);
  child.unref();
  return child;
}

module.exports = { launch, defaultRunner, CROSSOVER_WINE };
