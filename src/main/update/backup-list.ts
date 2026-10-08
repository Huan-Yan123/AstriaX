import { readdirSync, existsSync, unlinkSync, statSync } from 'fs'
import { join } from 'path'

export interface BackupItem {
  instanceId: string
  instanceName: string
  stamp: string
  version: string
  file: string
  sizeMB: number
  /** 这份备份所在的文件夹（每实例一个：<实例目录>\backups） */
  folder: string
}

/**
 * 备份的存放位置。
 *
 * 每实例一个 backups 子目录 —— 不是集中放一个池子里。
 * 这样做的好处：删实例时备份跟着走、回滚时不用猜是哪个实例的；
 * 代价是路径长，所以界面上要给用户一个「在这台机器上的哪儿」的明确答复
 * （用户提问的原话就是「备份文件夹在哪」，要的是**文件夹**不是每个文件）。
 */
export function backupsFolderFor(deps: { dataRoot: string }): string {
  return join(deps.dataRoot, 'instances')
}

/** 扫全部实例的 backups\*.tar.gz（按文件名时间戳倒序），供备份页展示 */
export function listBackups(deps: { dataRoot: string }): BackupItem[] {
  const out: BackupItem[] = []
  const base = join(deps.dataRoot, 'instances')
  if (!existsSync(base)) return []
  for (const kindDir of readdirSync(base, { withFileTypes: true })) {
    if (!kindDir.isDirectory()) continue
    for (const instDir of readdirSync(join(base, kindDir.name), { withFileTypes: true })) {
      if (!instDir.isDirectory()) continue
      const instPath = join(base, kindDir.name, instDir.name)
      const backups = join(instPath, 'backups')
      if (!existsSync(backups)) continue
      for (const f of readdirSync(backups)) {
        if (!f.endsWith('.tar.gz')) continue
        // 文件名：<本地时间戳>-v<模板版本>.tar.gz
        // 早期版本可能多一个点（20260912141734.-v1.tar.gz），解析时一并兼容
        const stamp = f.replace(/-v\d+\.tar\.gz$/, '').replace(/\.$/, '')
        const version = /-v(\d+)\.tar\.gz$/.exec(f)?.[1] ?? '?'
        out.push({
          instanceId: instDir.name,
          instanceName: instDir.name,
          stamp,
          version,
          file: join(backups, f),
          sizeMB: sizeMBOf(join(backups, f)),
          folder: backups
        })
      }
    }
  }
  return out.sort((a, b) => (a.stamp < b.stamp ? 1 : -1))
}

/**
 * 备份文件大小（MB，一位小数）。
 * 原来用 readFileSync 把整个 tar.gz 读进内存只为拿 length——大备份直接吃满内存。
 * statSync 只取元数据，快且不占内存。
 */
function sizeMBOf(p: string): number {
  try {
    return Math.round((statSync(p).size / (1024 * 1024)) * 10) / 10
  } catch {
    return 0
  }
}

/** 删除 tar.gz（连带 manifest）——不删正在使用的 runtime，纯清理 */
export function deleteBackup(deps: { file: string }): void {
  unlinkSync(deps.file)
  const mf = deps.file.replace(/\.tar\.gz$/, '.json')
  if (existsSync(mf)) unlinkSync(mf)
}

/** 备份回滚到实例（runtime 换血前再次自估：当前 runtime 先做一份保底快照） */
export { restoreBackup } from './backup'
