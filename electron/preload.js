'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const listeners = new Map();
let nextId = 1;

ipcRenderer.on('silly:event', (_, name, payload) => {
  for (const [id, listener] of listeners) {
    if (listener.name === name) {
      try { listener.handler({ event: name, id, payload }); }
      catch (_) { console.error('桌面事件处理失败'); }
    }
  }
});

async function invoke(channel, name, arg) {
  const reply = await ipcRenderer.invoke(channel, name, arg);
  if (reply.error !== undefined) throw new Error(reply.error);
  return reply.value;
}

const currentWindow = {
  setIgnoreCursorEvents: value => invoke('silly:window', 'setIgnoreCursorEvents', value),
  startDragging: () => invoke('silly:window', 'startDragging'),
  close: () => invoke('silly:window', 'close')
};

contextBridge.exposeInMainWorld('__TAURI__', {
  core: { invoke: (cmd, args) => invoke('silly:invoke', cmd, args) },
  event: {
    listen: async (name, handler) => {
      const id = nextId++;
      listeners.set(id, { name, handler });
      return () => { listeners.delete(id); };
    }
  },
  window: { getCurrentWindow: () => currentWindow }
});

const endDrag = () => ipcRenderer.send('silly:drag-end');
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  document.addEventListener(type, endDrag, true);
}
window.addEventListener('blur', endDrag, true);
