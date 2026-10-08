/**
 * 应用关闭流程模块
 * 负责退出前的清理工作
 */
import { app } from 'electron'
import { endRun, writeLastRunReport } from '../util/crash-logs'
import { closeAllWebUI } from '../webui/webui-manager'
import type { Logger } from '../logs/logger'

interface CleanupDeps {
  dataRoot: string
  log: Logger
}

let cleanupDeps: CleanupDeps | undefined

/**
 * 设置清理依赖
 */
export function setCleanupDeps(deps: CleanupDeps): void {
  cleanupDeps = deps
}

/**
 * 执行退出前的清理
 */
export async function performCleanup(): Promise<void> {
  if (!cleanupDeps) return

  const { dataRoot, log } = cleanupDeps

  try {
    // 关闭所有 WebUI
    await closeAllWebUI()

    // 清理运行锁
    endRun(dataRoot)

    // 写入最后运行报告
    writeLastRunReport(dataRoot, log)

    log('INFO', 'shutdown', '清理完成')
  } catch (e) {
    log('ERROR', 'shutdown', '清理失败', e instanceof Error ? e.message : String(e))
  }
}

/**
 * 注册退出钩子
 */
export function registerExitHooks(): void {
  app.on('will-quit', async (e) => {
    e.preventDefault()
    await performCleanup()
    app.exit(0)
  })

  app.on('window-all-closed', () => {
    // 只有 closePolicy=quit 或托盘「退出」会真正走到这里
    app.quit()
  })
}

/**
 * 立即退出（用于致命错误）
 */
export function exitImmediately(code: number): void {
  app.exit(code)
}
