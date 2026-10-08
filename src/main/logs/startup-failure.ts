import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface StartupFailureReport {
  zipPath?: string
  message: string
}

export function captureStartupFailure(deps: {
  dataRoot: string
  error: unknown
  version: string
  log: (level: 'CRASH', scope: string, message: string, detail?: string) => void
  exportZipSync: () => string
}): StartupFailureReport {
  const detail = deps.error instanceof Error
    ? `${deps.error.message}\n\n${deps.error.stack ?? ''}`
    : String(deps.error)
  try {
    deps.log('CRASH', 'app', '启动失败（窗口创建之前就抛错了）', detail.slice(0, 4000))
  } catch {
    // Preserve startup failure evidence below even if log append fails.
  }

  const errorPath = join(deps.dataRoot, 'startup-error.txt')
  try {
    mkdirSync(deps.dataRoot, { recursive: true })
    writeFileSync(errorPath, `版本：${deps.version}\n\n${detail}\n`, 'utf8')
  } catch {
    // Continue to package whatever logs already exist.
  }

  let zipPath: string | undefined
  try {
    zipPath = deps.exportZipSync()
  } catch {
    // The dialog will give the raw log paths as a fallback.
  }

  const location = zipPath
    ? `自动生成的日志包：\n${zipPath}`
    : `日志包生成失败。原始日志：\n${join(deps.dataRoot, 'logs')}\n启动错误：\n${errorPath}`
  return { zipPath, message: location }
}
