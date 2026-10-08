/**
 * 启动流程模块
 * 负责应用启动、单实例锁、提权检测
 */
import { app, dialog } from 'electron'
import { spawnSync } from 'child_process'
import {
  alreadyRelaunched,
  argsForRelaunch,
  buildStartProcessCommand,
  decideElevate,
  isElevatedFromWhoami
} from '../elevate'
import {
  beginBoot,
  markWindowReady,
  markBootOk,
  noteBootFailure,
  shouldAlertBootFailure,
  buildBootFailureMessage,
  markBootAlerted
} from '../logs/boot-watch'
import { FEEDBACK_LINES } from '../feedback'

/**
 * 启动健康检查
 * 连续启动失败时弹窗告知用户
 */
export async function checkBootHealth(): Promise<void> {
  if (shouldAlertBootFailure()) {
    const msg = buildBootFailureMessage()
    await dialog.showMessageBox({
      type: 'warning',
      title: 'AstriaX 启动异常',
      message: msg,
      detail: FEEDBACK_LINES.join('\n'),
      buttons: ['知道了']
    })
    markBootAlerted()
  }
}

/**
 * 单实例锁
 * 确保只有一个实例在运行
 */
export function acquireSingleInstanceLock(): boolean {
  return app.requestSingleInstanceLock()
}

/**
 * 提权检查与重启
 * 返回 true 表示需要重启，false 表示继续运行
 */
export async function checkElevationAndRelaunch(): Promise<boolean> {
  // 已经重启过了，不再重试
  if (alreadyRelaunched()) {
    return false
  }

  const elevated = isElevatedFromWhoami()
  const needElevate = decideElevate()

  // 需要提权但当前未提权
  if (needElevate && !elevated) {
    const args = argsForRelaunch()
    const cmdline = buildStartProcessCommand(process.execPath, args)

    try {
      const result = spawnSync('powershell', [
        '-NoProfile',
        '-Command',
        `Start-Process -FilePath "${cmdline.exe}" -ArgumentList ${cmdline.args} -Verb RunAs -WindowStyle Hidden`
      ])

      if (result.status === 0) {
        // 提权成功，退出当前实例
        app.exit(0)
        return true
      }
    } catch (e) {
      console.error('提权失败:', e)
    }
  }

  return false
}

/**
 * 标记启动阶段完成
 */
export function markStartupComplete(): void {
  markBootOk()
}

/**
 * 标记窗口就绪
 */
export function markWindowReadyState(): void {
  markWindowReady()
}

/**
 * 启动阶段开始
 */
export function beginBootSequence(): void {
  beginBoot()
}

/**
 * 记录启动失败
 */
export function recordBootFailure(error: Error): void {
  noteBootFailure(error.message)
}
