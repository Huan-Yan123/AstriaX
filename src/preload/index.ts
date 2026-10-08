import { contextBridge, ipcRenderer } from 'electron'
import { api } from './api-map'

// 暴露启动器 API
contextBridge.exposeInMainWorld('launcher', api)

// 暴露窗口控制 API
contextBridge.exposeInMainWorld('electron', {
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximizeChange: (callback: (maximized: boolean) => void) => {
      const listener = (_: unknown, maximized: boolean) => callback(maximized)
      ipcRenderer.on('window:maximize-change', listener)
      return () => ipcRenderer.removeListener('window:maximize-change', listener)
    }
  }
})
