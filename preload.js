// The only bridge between the window and the main process: Named calls and a few events
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const calls = ['info', 'addServer', 'pickManifestFile', 'removeServer', 'select', 'refresh', 'checkHealth', 'chooseFolder',
  'setProfile', 'oldFiles', 'cleanOldFiles', 'setSource', 'setLaunchArgs', 'patch', 'cancelPatch', 'play', 'setSettings', 'open', 'reveal', 'pickInstallFolder', 'moveInstall', 'suggestFolder', 'setFolder', 'knownServers', 'news', 'setFeed', 'appVersion', 'appCheckUpdate', 'appSetAutoUpdate', 'appUpdate',
  'serverLog', 'copyLogs', 'copyCrashes', 'revealLogs', 'welcomeDone'];

const api = {};
for (const c of calls) {
  api[c] = async (arg) => {
    const r = await ipcRenderer.invoke(c, arg);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
}
api.onHealth = (fn) => ipcRenderer.on('health', (_e, d) => fn(d));
api.onPatch = (fn) => ipcRenderer.on('patch', (_e, d) => fn(d));
api.onInfo = (fn) => ipcRenderer.on('info', (_e, d) => fn(d));
api.onAppUpdate = (fn) => ipcRenderer.on('update', (_e, d) => fn(d));
api.onServerLog = (fn) => ipcRenderer.on('slog', (_e, d) => fn(d));
api.onPlayFail = (fn) => ipcRenderer.on('playfail', (_e, d) => fn(d));
api.onGame = (fn) => ipcRenderer.on('game', (_e, d) => fn(d));
api.onResumed = (fn) => ipcRenderer.on('resumed', (_e, d) => fn(d));

contextBridge.exposeInMainWorld('launcher', api);
