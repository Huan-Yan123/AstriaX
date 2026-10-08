/**
 * 错误处理模块
 * 统一的错误捕获和崩溃处理
 */
import { dialog, app } from 'electron'
import { noteCrash, shouldAlertCrash, markCrashAlerted } from '../logs/boot-watch'
import { FEEDBACK_LINES } from '../feedback'
import type { Logger } from '../logs/logger'

interface ErrorHandlerDeps {
  log: Logger
  dataRoot: string
}

let errorDeps: ErrorHandlerDeps | undefined

/**
 * 设置错误处理依赖
 */
export function setErrorHandlerDeps(deps: ErrorHandlerDeps): void {
  errorDeps = deps
}

/**
 * 全局错误处理函数
 */
export function createGlobalErrorHandler(): (error: unknown, scope?: string) => void {
  return (error: unknown, scope = 'unknown') => {
    if (!errorDeps) {
      console.error(`[${scope}]`, error)
      return
    }

    const { log } = errorDeps
    const msg = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? error.stack : undefined

    log('ERROR', scope, msg, stack)
    noteCrash()

    // 连续崩溃时弹窗
    if (shouldAlertCrash()) {
      dialog
        .showMessageBox({
          type: 'error',
          title: 'AstriaX 遇到错误',
          message: `发生错误：${msg}`,
          detail: `${FEEDBACK_LINES.join('\n')}\n\n技术细节：\n${stack ?? '无堆栈信息'}`,
          buttons: ['退出', '继续运行']
        })
        .then((result) => {
          markCrashAlerted()
          if (result.response === 0) {
            app.exit(1)
          }
        })
    }
  }
}

/**
 * 致命错误处理（直接退出）
 */
export async function handleFatalError(error: Error, title: string): Promise<void> {
  await dialog.showMessageBox({
    type: 'error',
    title,
    message: error.message,
    detail: `${FEEDBACK_LINES.join('\n')}\n\n堆栈：\n${error.stack ?? '无'}`,
    buttons: ['退出']
  })
  app.exit(1)
}

/**
 * 注册全局错误捕获
 */
export function registerGlobalErrorHandlers(crash: (e: unknown, scope?: string) => void): void {
  process.on('uncaughtException', (e) => {
    crash(e, 'uncaughtException')
  })

  process.on('unhandledRejection', (reason) => {
    crash(reason, 'unhandledRejection')
  })
}
