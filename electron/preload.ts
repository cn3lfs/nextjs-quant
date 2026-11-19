import { contextBridge, ipcRenderer } from "electron";

const desktop = {
  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke("quant:select-directory"),
  getDesktopPrefs: (): Promise<{ closeToTray: boolean }> =>
    ipcRenderer.invoke("quant:get-desktop-prefs"),
  setCloseToTray: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("quant:set-close-to-tray", enabled),
  restartService: (): Promise<void> =>
    ipcRenderer.invoke("quant:restart-service"),
};

declare global {
  interface Window {
    quantDesktop?: typeof desktop;
  }
}

contextBridge.exposeInMainWorld("quantDesktop", desktop);
