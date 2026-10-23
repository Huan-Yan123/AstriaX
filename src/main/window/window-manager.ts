/**
 * 窗口管理模块
 * 负责主窗口的创建、配置和生命周期
 */
import { BrowserWindow, nativeImage, app, shell } from 'electron'
import { pathToFileURL } from 'url'
import { configureLauncherSecurity } from '../security/renderer'
import { join, dirname } from 'path'
import { existsSync } from 'fs'

/**
 * 窗口/任务栏图标
 * dev=工程 build\icon.png；打包=exe 同级的 resources\icon.png
 */
export function loadWindowIcon(): Electron.NativeImage | undefined {
  const exeDir = dirname(process.execPath)
  const resourcesPath = (process as any).resourcesPath
  
  const candidates = [
    // 打包态（首选）：electron-builder.yml 的 extraResources 放成 resources\icon.png
    ...(resourcesPath ? [join(resourcesPath, 'icon.png')] : []),
    join(process.cwd(), 'build', 'icon.png'),
    join(exeDir, 'resources', 'icon.png'),
    join(exeDir, 'icon.png')
  ]
  
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const img = nativeImage.createFromPath(p)
        if (!img.isEmpty()) return img
      }
    } catch {
      /* 继续试下一个 */
    }
  }
  
  return undefined
}

/**
 * 创建主窗口
 */
export function createMainWindow(preloadPath: string): BrowserWindow {
  const icon = loadWindowIcon()
  
  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#f2f6fd',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  const rendererUrl = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
    ? process.env.ELECTRON_RENDERER_URL
    : pathToFileURL(join(__dirname, '../renderer/index.html')).href
  configureLauncherSecurity(win.webContents, rendererUrl, (url) => shell.openExternal(url))
  void win.loadURL(rendererUrl)

  // 窗口准备好后显示
  win.once('ready-to-show', () => {
    win.show()
  })


  return win
}

/**
 * 恢复或聚焦窗口（用于 second-instance）
 */
export function restoreAndFocusWindow(win: BrowserWindow): void {
  try {
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
  } catch {
    /* 窗口正在销毁等边缘情况：忽略即可，不该因为聚焦失败而崩 */
  }
}
