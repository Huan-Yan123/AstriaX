/**
 * 窗口管理模块
 * 负责主窗口的创建、配置和生命周期
 */
import { BrowserWindow, nativeImage } from 'electron'
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

  // 开发模式加载 vite 开发服务器
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 窗口准备好后显示
  win.once('ready-to-show', () => {
    win.show()
  })

  // 禁止导航到外部 URL（安全加固）
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://') && !url.startsWith('http://localhost')) {
      event.preventDefault()
    }
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
