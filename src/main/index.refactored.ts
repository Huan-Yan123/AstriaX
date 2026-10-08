/**
 * 重构后的主进程入口
 * 职责分离：启动/窗口/错误/清理/托盘各自独立
 */
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import {
  beginBootSequence,
  checkBootHealth,
  acquireSingleInstanceLock,
  checkElevationAndRelaunch,
  markStartupComplete,
  markWindowReadyState,
  recordBootFailure
} from './startup/boot-manager'
import { createMainWindow, restoreAndFocusWindow } from './window/window-manager'
import {
  createGlobalErrorHandler,
  setErrorHandlerDeps,
  registerGlobalErrorHandlers,
  handleFatalError
} from './error/error-handler'
import {
  setCleanupDeps,
  registerExitHooks,
  performCleanup
} from './shutdown/cleanup-manager'
import { initTrayAndCloseFlow } from './tray/tray'
import {
  registerIpcHandlersReal,
  defaultDataRoot,
  createCrashHandler
} from './ipc'
import { sweepStaleTmp } from './util/workdir'
import { startBlockWatchdog } from './util/block-watchdog'
import {
  beginRun,
  checkPreviousRun,
  startCrashReporter,
  installWerLocalDumps
} from './util/crash-logs'
import { pruneUpdateBackupsAsync } from './update/update-backups'

// 全局状态
let mainWindow: BrowserWindow | null = null
let crashHandler: ((e: unknown, scope?: string) => void) | undefined

/**
 * 主启动流程
 */
async function bootstrap(): Promise<void> {
  try {
    // 阶段 1: 启动检查
    beginBootSequence()
    await checkBootHealth()

    // 单实例锁
    if (!acquireSingleInstanceLock()) {
      app.quit()
      return
    }

    // 提权检查（需要时重启）
    const needRelaunch = await checkElevationAndRelaunch()
    if (needRelaunch) {
      return
    }

    // 阶段 2: 初始化数据根
    const dataRoot = defaultDataRoot()

    // 检查上次运行是否崩溃
    const lastCrash = checkPreviousRun(dataRoot)
    if (lastCrash.crashed) {
      console.warn('检测到上次异常退出')
    }

    // 开始本次运行标记
    beginRun(dataRoot)

    // 阶段 3: 启动日志与崩溃报告
    const { log } = await createCrashHandler(dataRoot)

    // 设置错误处理依赖
    crashHandler = createGlobalErrorHandler()
    setErrorHandlerDeps({ log, dataRoot })
    registerGlobalErrorHandlers(crashHandler)

    // 启动崩溃报告器
    startCrashReporter(dataRoot, log)
    installWerLocalDumps(dataRoot, log)

    // 设置清理依赖
    setCleanupDeps({ dataRoot, log })

    // 阶段 4: 启动看门狗
    startBlockWatchdog(log)

    // 清理临时文件（异步，不阻塞启动）
    sweepStaleTmp(dataRoot, log).catch((e) => {
      log('WARN', 'startup', '清理临时文件失败', String(e))
    })

    // 清理旧备份（异步）
    pruneUpdateBackupsAsync(dataRoot, log).catch((e) => {
      log('WARN', 'startup', '清理旧备份失败', String(e))
    })

    // 阶段 5: 创建主窗口
    const preloadPath = join(__dirname, '../preload/index.js')
    mainWindow = createMainWindow(preloadPath)

    markWindowReadyState()

    // 阶段 6: 注册 IPC 处理器
    await registerIpcHandlersReal(mainWindow, dataRoot, log, lastCrash)

    // 阶段 7: 初始化托盘与关闭策略
    await initTrayAndCloseFlow(mainWindow, dataRoot, log)

    // 阶段 8: 注册退出钩子
    registerExitHooks()

    // 标记启动完成
    markStartupComplete()

    log('INFO', 'startup', '启动完成')
  } catch (error) {
    recordBootFailure(error as Error)
    await handleFatalError(
      error as Error,
      'AstriaX 启动失败'
    )
  }
}

// 应用就绪后启动
app.whenReady().then(bootstrap).catch((error) => {
  console.error('Bootstrap failed:', error)
  app.exit(1)
})

// 二次启动：显示已有窗口
app.on('second-instance', () => {
  if (mainWindow) {
    restoreAndFocusWindow(mainWindow)
  }
})

// 窗口全部关闭
app.on('window-all-closed', () => {
  // 托盘模式下由 tray.ts 控制是否真正退出
  // 这里只是兜底
})

// 意外错误退出前的清理
process.on('beforeExit', async (code) => {
  if (code !== 0) {
    await performCleanup()
  }
})
