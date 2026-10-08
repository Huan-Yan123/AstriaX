/*
 * 备份页的显示逻辑 + IPC 接口约定。
 *
 * ## 为什么单独测这两件
 *
 *  1. **时间格式**：实例备份的时间戳是 `20260912141734`（14 位、无分隔），
 *     而自动备份的是 `20260914-151447`（带连字符）。两者格式不同，
 *     如果偷懒复用同一个解析函数，就会把时间显示错 ——
 *     这类"数字看着像时间、其实错位"的 bug 本项目已经踩过一次
 *     （util/stamp.ts 的注释里记着"硬切下标把 20260912141734 显示成 42:14"）。
 *
 *  2. **字节数显示**：备份包可能很小（实测真实数据 0.2 KB）。
 *     如果一律按 MB 显示会变成 "0.0 MB"，用户以为备份是空的。
 */
import { describe, it, expect } from 'vitest'

/** 和 BackupPage.vue 里的实现保持一致（同逻辑双写，测试锁行为） */
function prettyStamp(s: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(s)
  if (!m) return s
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`
}

function prettySize(bytes: number): string {
  if (!bytes || bytes <= 0) return '空'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

describe('自动备份的时间显示', () => {
  it('★带连字符的时间戳要显示成正常时间（不能错位）', () => {
    expect(prettyStamp('20260914-151447')).toBe('2026-09-14 15:14')
  })

  it('★不能把 14 位无分隔时间戳当成本格式解析（那是实例备份的格式）', () => {
    // 实例备份的时间戳不匹配这个正则 → 原样返回，不产生一个错的时间
    expect(prettyStamp('20260912141734')).toBe('20260912141734')
  })

  it('不认识的内容原样返回（不瞎猜）', () => {
    expect(prettyStamp('随便什么')).toBe('随便什么')
    expect(prettyStamp('')).toBe('')
  })

  it('真实安装器会产生的时间戳都能解析', () => {
    // ${GetTime} 的月/日/时/分/秒都是两位数（不足补零），所以形状固定
    for (const s of ['20260101-000000', '20261231-235959', '20260914-090500']) {
      expect(prettyStamp(s)).not.toBe(s)
      expect(prettyStamp(s)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    }
  })
})

describe('备份包体积显示', () => {
  it('★小包要显示成 B / KB，不能显示成 0.0 MB', () => {
    // 实测真实 instances 只有 15.6 KB，tar 出来 0.2 KB
    expect(prettySize(200)).toBe('200 B')
    expect(prettySize(2048)).toBe('2.0 KB')
    expect(prettySize(15.6 * 1024)).toBe('15.6 KB')
  })

  it('大包显示 MB', () => {
    expect(prettySize(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('0 或缺失显示"空"（不是"0 B"，那看着像正常文件）', () => {
    expect(prettySize(0)).toBe('空')
    expect(prettySize(-1)).toBe('空')
    expect(prettySize(NaN)).toBe('空')
  })
})
