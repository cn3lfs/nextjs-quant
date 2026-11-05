import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("quantDesktop", {
  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke("quant:select-directory"),
});
