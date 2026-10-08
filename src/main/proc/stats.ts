export interface PidEntry {
  id: string
  pid: number
}

export interface InstanceStat {
  id: string
  /** 内存占用（MB，向下取整） */
  memMB: number
  /** CPU 百分比（单核=100%） */
  cpuPct: number
}

export interface PidUsageSample {
  memory: number // bytes
  cpu: number // percent
}

export type PidUsageFn = (pid: number) => Promise<PidUsageSample>

export interface StatsModule {
  forPids: (entries: PidEntry[]) => Promise<InstanceStat[]>
}

export function createStats(deps: { pidusage: PidUsageFn }): StatsModule {
  return {
    async forPids(entries) {
      if (entries.length === 0) return []
      const results = await Promise.all(
        entries.map(async (entry) => {
          try {
            const sample = await deps.pidusage(entry.pid)
            return {
              id: entry.id,
              memMB: Math.floor(sample.memory / (1024 * 1024)),
              cpuPct: sample.cpu
            }
          } catch {
            return null // 进程刚退出等情况：静默丢弃
          }
        })
      )
      return results.filter((x): x is InstanceStat => x !== null)
    }
  }
}
