export interface ProgressState {
  type: 'a' | 'n'
  tag: string
  got: number
  total?: number
  percent: number | null
  bytesPerSec: number
  gotText: string
  speedText: string
  done: boolean
}

export interface ProgressTracker {
  update: (type: 'a' | 'n', tag: string, got: number, total?: number) => ProgressState
}

export function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1073741824).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

export function humanSpeed(bytesPerSec: number): string {
  return `${humanSize(bytesPerSec)}/s`
}

/**
 * 下载进度跟踪：算百分比 + 平滑速度。
 * 速度做指数平滑（smooth 系数），避免网速抖动导致数字乱跳——UI 上看着才稳。
 */
export function createProgressTracker(deps: { now?: () => number; smooth?: number } = {}): ProgressTracker {
  const now = deps.now ?? (() => Date.now())
  const alpha = deps.smooth ?? 0.3
  const last = new Map<string, { got: number; at: number; speed: number }>()

  return {
    update(type, tag, got, total) {
      const key = `${type}|${tag}`
      const at = now()
      const prev = last.get(key)
      let speed = prev?.speed ?? 0
      if (prev && at > prev.at) {
        const inst = ((got - prev.got) * 1000) / (at - prev.at)
        speed = prev.speed > 0 ? prev.speed * (1 - alpha) + inst * alpha : inst
      }
      last.set(key, { got, at, speed })
      const percent = total && total > 0 ? Math.min(100, Math.round((got / total) * 100)) : null
      return {
        type,
        tag,
        got,
        total,
        percent,
        bytesPerSec: Math.max(0, Math.round(speed)),
        gotText: humanSize(got),
        speedText: humanSpeed(Math.max(0, Math.round(speed))),
        done: Boolean(total && got >= total)
      }
    }
  }
}
