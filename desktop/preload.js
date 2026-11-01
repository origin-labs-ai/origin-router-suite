"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Minimal, explicit bridge. The renderer gets window controls only — no Node,
// no arbitrary IPC channels.
contextBridge.exposeInMainWorld("originRouterDesktop", {
  isDesktop: true,
  minimize: () => ipcRenderer.send("or:window-minimize"),
  toggleMaximize: () => ipcRenderer.send("or:window-toggle-maximize"),
  close: () => ipcRenderer.send("or:window-close"),
  isMaximized: () => ipcRenderer.invoke("or:window-is-maximized"),
  onMaximizedChange: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, value) => callback(Boolean(value));
    ipcRenderer.on("or:window-maximized", listener);
    return () => ipcRenderer.removeListener("or:window-maximized", listener);
  },
});
