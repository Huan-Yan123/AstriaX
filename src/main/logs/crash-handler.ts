import type { Logger } from './logger'
import { join } from 'path'
import { FEEDBACK_LINES } from '../feedback'

export interface CrashDialogApi {
  /** Electron dialog.showErrorBox 同步原生弹窗；注入以便单测 */
  showErrorBox: (title: string, content: string) => void
}

export interface CrashHandler {
  (err: unknown, scope?: string): void
}

/**
 * PCL2 风格崩溃弹窗：
 * 1. 日志先行落盘（logger.crash 同步写）
 * 2. 尽力同步打包日志 zip
 * 3. 独立原生弹窗：标题 + 疑似问题 + 日志 zip 路径 + 上报 QQ
 */
export function createCrashHandler(deps: { logger: Logger; dialog: CrashDialogApi; appName?: string; dataRoot: string }): CrashHandler {
  const appName = deps.appName ?? 'AstriaX'
  return (err, scope = 'uncaughtException') => {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? (err.stack ?? '') : ''
    try {
      deps.logger.crash(scope, stack || message)
    } catch {
      /* 日志都写不进就只能弹窗了 */
    }

    let zip: string | undefined
    try {
      zip = deps.logger.exportZipSync()
    } catch {
      zip = undefined // zip 失败继续弹窗（至少弹（别静默崩））
    }

    const lines = [
      `${appName} 崩溃了。已自动生成日志报告，包含疑似问题。`,
      '',
      `疑似问题：${guessHumanCause(message)}`,
      '',
      zip
        ? `日志报告在这里（发给帮你的那个人，别只发截图）：${zip}`
        : `日志报告生成失败，原始日志位置：${join(deps.dataRoot, 'logs')}`,
      '',
      '把整个日志压缩包发出去比仅描述现场更快解决问题。',
      /*
       * ★ 联系方式（主人 2026-09-27 指出的遗漏）
       *
       * 我第一版把联系方式加在了**自研弹窗**里，漏了这些**原生错误框** ——
       * 而"软件崩了"恰恰是最需要联系方式的时刻：
       * 用户完全不知道找谁，只能盯着一个报错框干着急。
       */
      FEEDBACK_LINES
    ]
    try {
      deps.dialog.showErrorBox('AstriaX 崩溃了', lines.join('\n'))
    } catch {
      /* 甚至弹窗都弹不出的极端环境：只能静默 */
    }
  }
}

/** 把常见的抽象报错翻成主人能看懂的中文（保留原始信息另附） */
function guessHumanCause(message: string): string {
  const head = message.split('\n')[0]
  const hints: Array<[RegExp, string]> = [
    [/is not defined|is not a function/i, '有代码用到了不存在的按钮/名字（功能之间的接线断了）'],
    [/cannot read propert|undefined/i, '读到没准备的数据，多半是前后步骤没对齐'],
    [/ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i, '连不上网（服务器地址不通或本机断网）'],
    [/EACCES|EPERM/i, '权限被挡了：确认程序目录没被别处更新/沙盒挡住']
  ]
  for (const [re, why] of hints) {
    if (re.test(head)) return `${why}\n原始报错：${head}`
  }
  return `原始报错：${head}`
}
