/*
 * 日志保留策略 —— 别让日志把用户的盘吃干净。
 *
 * ============================================================================
 * 问题
 * ============================================================================
 *
 * 全项目**没有任何轮转**（grep `rotate|maxSize|MAX_LOG|truncate` 一个都没有）。
 * 而日志有三处会持续增长：
 *
 *   1. `<dataRoot>\logs\app-<日期>.log`  —— 每天一个新文件，**旧的永不删**
 *   2. `<dataRoot>\logs\instances\<id>.log` —— 追加写、永不截断（单个能到几百 MB）
 *   3. `<dataRoot>\logs\audit-<日期>.log`  —— 同样按天累积、永不删
 *
 * 对一个"多开挂机"的工具来说，跑一个月的机器上攒出几个 GB 日志是很现实的。
 * 而且 1 和 3 是**按天分文件**的，用户自己都不容易发现该删哪些。
 *
 * ============================================================================
 * 策略
 * ============================================================================
 *
 * 不做「单文件超 N MB 就截断当前文件」那种轮转 ——
 * 那种做法要处理"正在写的文件"，容易在 Windows 上和写入方抢句柄。
 * 改成**按时间清理**，简单、可预期、不碰正在写的那个文件：
 *
 *   - `app-<日期>.log` / `audit-<日期>.log`：保留最近 N 天（缺省 30）
 *   - `instances\*.log`：按**最后写入时间**清理，超 N 天的删掉
 *
 * 为什么实例日志按 mtime 而不是按名字：它的名字是实例 id，没有日期信息。
 * 而 mtime 正好表达我们要的语义 ——「这个实例很久没动过了」。
 * 正在运行的实例会持续写日志，mtime 一直是新的，**不会被误删**。
 *
 * 保守取值（30 天）的理由：日志是这个软件**唯一的排查依据**，
 * 用户报问题时我们往往要问"上周那次是什么情况"。留 30 天足够覆盖
 * 绝大多数反馈周期，而磁盘成本可忽略（活跃的也就几十 MB）。
 *
 * 每个"几天没动"的实例日志单独看可能有几 MB，不能只按天数判断就删 ——
 * 所以这里只在**启动时**跑一次（跟着 sweepTrash 一起），不增加运行期开销。
 */
import { existsSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'

/** 保留多少天（app / audit / 实例日志统一用这个） */
export const LOG_KEEP_DAYS = 30

export interface PruneResult {
  /** 删掉的文件路径 */
  removed: string[]
  /** 因为被占用等原因删不掉的（用户可能要手工清） */
  failed: Array<{ file: string; reason: string }>
}

/**
 * 清理过期日志。**绝不抛异常** —— 这是打扫卫生，不该影响启动。
 *
 * 删失败不当作错误（Windows 上被占用的日志文件删不掉很正常），
 * 但要如实记进 `failed` 让调用方决定是否提示 ——
 * 静默失败正是当初 `.deleting-*` 垃圾越积越多却没人知道的原因。
 */
export function pruneOldLogs(
  dataRoot: string,
  opts: { keepDays?: number; now?: number } = {}
): PruneResult {
  const keepDays = opts.keepDays ?? LOG_KEEP_DAYS
  const now = opts.now ?? Date.now()
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000
  const removed: string[] = []
  const failed: Array<{ file: string; reason: string }> = []

  const logsDir = join(dataRoot, 'logs')
  const tryRemove = (file: string) => {
    try {
      unlinkSync(file)
      removed.push(file)
    } catch (e) {
      failed.push({ file, reason: e instanceof Error ? e.message : String(e) })
    }
  }

  /** 按 mtime 判断是否过期（对没带日期的文件名适用） */
  const staleByMtime = (file: string): boolean => {
    try {
      return statSync(file).mtimeMs < cutoff
    } catch {
      return false // 读不到状态就别删，保守
    }
  }

  // ---- 1. app-*.log 与 audit-*.log：按文件名里的日期判断 ----
  for (const kind of ['app', 'audit'] as const) {
    let names: string[]
    try {
      names = readdirSync(logsDir).filter((n) => n.startsWith(`${kind}-`) && n.endsWith('.log'))
    } catch {
      continue
    }
    for (const n of names) {
      // 文件名形如 app-2026-09-14.log，中间那段就是日期
      const m = /^[a-z]+-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(n)
      if (!m) {
        /*
         * 认不出日期的（比如用户手工改过名）：退回 mtime 判断。
         * 不直接跳过 —— 一个改过名的老日志同样是垃圾，
         * 而 mtime 足够可靠地表达"很久没动过"。
         */
        const f = join(logsDir, n)
        if (staleByMtime(f)) tryRemove(f)
        continue
      }
      const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`)
      // 解析不出来（比如 2026-13-45 这种）就跳过，别误删
      if (Number.isNaN(t)) continue
      if (t < cutoff) tryRemove(join(logsDir, n))
    }
  }

  // ---- 2. instances\*.log：名字是实例 id，只能按 mtime ----
  const instLogs = join(logsDir, 'instances')
  if (existsSync(instLogs)) {
    let names: string[]
    try {
      names = readdirSync(instLogs).filter((n) => n.endsWith('.log'))
    } catch {
      names = []
    }
    for (const n of names) {
      const f = join(instLogs, n)
      /*
       * 正在运行的实例会持续写日志，mtime 一直是新的 → 不会被删。
       * 所以这里不需要额外问「这个实例在跑吗」——
       * 「很久没写过的日志」和「很久没动过的实例」是同一件事。
       */
      if (staleByMtime(f)) tryRemove(f)
    }
  }

  return { removed, failed }
}
