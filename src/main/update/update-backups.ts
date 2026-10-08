import { readdirSync, statSync, rmSync, existsSync } from 'fs'
import { readdir, stat, rm } from 'fs/promises'
import { join } from 'path'

/**
 * 覆盖更新自动备份的**读取与清理**。
 * ========================================================================
 *
 * 安装器（build/installer.nsh 的 MXBOT_UPDATE_BACKUP 宏）在每次覆盖更新前
 * 会把用户数据打成一个 tar.gz，放在：
 *
 *     <数据目录>\backups\update\<时间戳>\mxbot-data.tar.gz
 *
 * 安装器**只负责打、不负责删** —— NSIS 里做"排序删旧包"既脆又容易编不过，
 * 而且"哪些该删"是业务判断，本来就该在程序里做。所以清理放在这里，
 * 由应用启动时调用一次。
 *
 * 不清理的后果是**无上限增长**：用户每次更新攒一份，一年下来几百个目录。
 * 本项目在 cache\tmp 上已经踩过一模一样的坑（攒到 916 个条目、GB 级）。
 */

/** 备份包文件名。必须和 build/installer.nsh 里拼出的名字逐字一致。 */
export const UPDATE_BACKUP_FILE = 'mxbot-data.tar.gz'

/** 备份文件所在目录：<dataRoot>\backups\update */
export function updateBackupsRoot(dataRoot: string): string {
  return join(dataRoot, 'backups', 'update')
}

export interface UpdateBackupItem {
  /** 时间戳目录名，形如 20260914-151447 */
  stamp: string
  /** 备份包完整路径 */
  file: string
  /** 备份包字节数（读不到时为 0） */
  sizeBytes: number
  /** 备份包修改时间（读不到时为 0） */
  mtimeMs: number
  /**
   * 目录里是否真的有 `mxbot-data.tar.gz`。
   *
   * 这个字段不只是给界面看的，**清理逻辑依赖它**：
   * 只有 hasPackage=true 的条目才占用"保留 N 份"的名额。
   * 详见 pruneUpdateBackups 的注释（那里记了一个真被删掉救命备份的 bug）。
   */
  hasPackage: boolean
}

/**
 * 时间戳目录名的形状：`YYYYMMDD-HHMMSS`。
 *
 * 为什么要严判形状：清理会 `rmSync` 整个目录，属于破坏性操作。
 * 只删**明确认识**的东西 —— 万一用户自己在 `backups\update\` 下
 * 放了别的目录，绝不能被我们顺手删掉。
 */
const STAMP_RE = /^\d{8}-\d{6}$/

/**
 * 列出现有的更新前备份，**按时间倒序**（最新的在前）。
 *
 * 只认满足两个条件的目录：
 *   1. 目录名是时间戳形状
 *   2. 里面确实有 mxbot-data.tar.gz
 *
 * 第 2 条同样是为了安全：只有形状对了、内容也对了，才认为是"我们打的包"。
 * 单纯形状对但内容不是的，可能是用户手工放的东西，只列不删（见 prune）。
 *
 * 永不抛异常：这个函数在启动路径上跑，读不了目录就当没有。
 */
export function listUpdateBackups(dataRoot: string): UpdateBackupItem[] {
  const base = updateBackupsRoot(dataRoot)
  if (!existsSync(base)) return []

  const out: UpdateBackupItem[] = []
  let names: string[]
  try {
    names = readdirSync(base)
  } catch {
    return []
  }

  for (const name of names) {
    if (!STAMP_RE.test(name)) continue
    const dir = join(base, name)
    const file = join(dir, UPDATE_BACKUP_FILE)

    let sizeBytes = 0
    let mtimeMs = 0
    let hasPackage = false
    if (existsSync(file)) {
      hasPackage = true
      try {
        const st = statSync(file)
        sizeBytes = st.size
        mtimeMs = st.mtimeMs
      } catch {
        /* 读不到就按 0 —— 不影响列出与清理 */
      }
    } else {
      // 目录里没有我们的包文件：仍然列出来（让界面能看到），但标 0 字节、
      // hasPackage=false。清理时它**不占保留名额**（见 pruneUpdateBackups）。
      try {
        mtimeMs = statSync(dir).mtimeMs
      } catch {
        /* ignore */
      }
    }

    out.push({ stamp: name, file, sizeBytes, mtimeMs, hasPackage })
  }

  // 时间戳形如 YYYYMMDD-HHMMSS，字典序 = 时间序，直接倒排即可
  out.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0))
  return out
}

/** 异步版本供启动和 IPC 使用，避免大量备份目录阻塞 Electron 主进程。 */
export async function listUpdateBackupsAsync(dataRoot: string): Promise<UpdateBackupItem[]> {
  const base = updateBackupsRoot(dataRoot)
  let names: string[]
  try { names = await readdir(base) } catch { return [] }
  const out: UpdateBackupItem[] = []
  for (const name of names) {
    if (!STAMP_RE.test(name)) continue
    const dir = join(base, name)
    const file = join(dir, UPDATE_BACKUP_FILE)
    let sizeBytes = 0
    let mtimeMs = 0
    let hasPackage = false
    try {
      const st = await stat(file)
      if (st.isFile()) { hasPackage = true; sizeBytes = st.size; mtimeMs = st.mtimeMs }
    } catch {
      try { mtimeMs = (await stat(dir)).mtimeMs } catch { /* 路径可能已被并发移除 */ }
    }
    out.push({ stamp: name, file, sizeBytes, mtimeMs, hasPackage })
  }
  out.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0))
  return out
}

/** 保留份数的默认值（配置缺失或非法时用它） */
export const DEFAULT_UPDATE_BACKUP_KEEP = 5

/**
 * 只保留最近 `keep` 份更新前备份，删掉更旧的。
 *
 * @returns 被删掉的时间戳列表（供日志记录）
 *
 * ## 保底规则：至少留 1 份
 *
 * `keep` 传 0 或负数时**不**按字面执行，而是回落到默认值。
 * 理由：这是"更新前最后一道保险"。用户把保留数调成 0 通常是想省空间，
 * 但因此把唯一的救命备份也删了，真出事时他什么都没有 —— 宁可保守。
 *
 * ## 安全规则：只删"确认是我们打的包"
 *
 * 目录名必须是时间戳形状**且**里面真的有 mxbot-data.tar.gz 才删。
 * 少任一条件都不碰 —— 用户的目录比省这点空间重要得多。
 *
 * ## 名额只算"真的有包"的那些（这条修过一个真能丢数据的 bug）
 *
 * 第一版把**所有**时间戳形状的目录都算进"保留 N 份"的名额里。
 * 于是这样的序列会把唯一真备份删掉：
 *
 *   排序（新→旧）: 13:00(空) 12:00(空) 11:00(真备份)   keep=1
 *   错逻辑: slice(1) = [12:00, 11:00] → 12:00 没包跳过，
 *           11:00 是真备份 → **被删** → 用户只剩一堆空目录
 *
 * 是 tests/unit/update-backup-prune.spec.ts 里那条 ★ 用例抓出来的。
 * （第一版用例把空目录放在**最旧**位置，怎么改都是绿的 —— 假绿；
 *   把空目录挪到真备份**前面**才暴露出来。）
 *
 * 现在名额只由 hasPackage=true 的条目占用，上面那个序列里 11:00 会被保住。
 *
 * 永不抛异常：逐项 try/catch，清理失败不能影响启动。
 */
export function pruneUpdateBackups(dataRoot: string, keep: number): string[] {
  const n = Number.isFinite(keep) && Math.floor(keep) >= 1 ? Math.floor(keep) : DEFAULT_UPDATE_BACKUP_KEEP

  /*
   * 先按时间倒序，再**只留真的有包文件的**参与名额计算。
   * keep 是"保留 N 份真备份"，不是"保留 N 个目录"。
   */
  const all = listUpdateBackups(dataRoot)
  const real = all.filter((x) => x.hasPackage)
  if (real.length <= n) return []

  const removed: string[] = []
  for (const item of real.slice(n)) {
    // hasPackage 已经是 true，但仍再确认一次存在性：
    // 从 list 到 rm 之间文件可能被别的进程删掉，rmSync force 不会报错，
    // 但我们不想把"没删到任何东西"记成一次成功删除。
    if (!existsSync(item.file)) continue
    try {
      rmSync(join(updateBackupsRoot(dataRoot), item.stamp), { recursive: true, force: true })
      removed.push(item.stamp)
    } catch {
      /* 删不掉就算了（可能被占用）—— 下次启动还会再试，绝不影响启动 */
    }
  }
  return removed
}

/** 异步清理版本；仍只删除时间戳目录中确认存在的备份包。 */
export async function pruneUpdateBackupsAsync(dataRoot: string, keep: number): Promise<string[]> {
  const n = Number.isFinite(keep) && Math.floor(keep) >= 1 ? Math.floor(keep) : DEFAULT_UPDATE_BACKUP_KEEP
  const real = (await listUpdateBackupsAsync(dataRoot)).filter((item) => item.hasPackage)
  if (real.length <= n) return []
  const removed: string[] = []
  for (const item of real.slice(n)) {
    try {
      await stat(item.file)
      await rm(join(updateBackupsRoot(dataRoot), item.stamp), { recursive: true, force: true })
      removed.push(item.stamp)
    } catch { /* 尽力清理；失败不影响启动 */ }
  }
  return removed
}
