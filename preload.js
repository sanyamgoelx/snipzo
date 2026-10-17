'use strict';
// The pages talk to the main process only through these four calls, on "snz:" channels.
const { contextBridge, ipcRenderer } = require('electron');
const ok = (ch) => typeof ch === 'string' && ch.startsWith('snz:');
contextBridge.exposeInMainWorld('snz', {
  send: (ch, data) => { if (ok(ch)) ipcRenderer.send(ch, data); },
  invoke: (ch, data) => (ok(ch) ? ipcRenderer.invoke(ch, data) : Promise.reject(new Error('bad channel'))),
  on: (ch, fn) => { if (ok(ch)) ipcRenderer.on(ch, (_e, d) => fn(d)); },
  platform: process.platform,
});
