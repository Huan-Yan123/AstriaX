/**
 * 备份文件名时间戳 → 可读时间。
 *
 * 文件名形如 `20260912141734-v1.tar.gz`（本地时间 YYYYMMDDHHmmss）。
 *
 * 历史坑：早期生成端用 `toISOString()`（UTC）+ `slice(0,15)`，
 * 既差 8 小时，又多留 1 个字符，产出 `20260912141734.-v1.tar.gz`。
 * 而展示端按「第 8 位是分隔符」硬切下标，于是显示成 `2026-09-12 42:14`
 * —— 42 分、85 秒这种根本不存在的时刻。所以这里先把非数字全剔掉再切。
 */
export function stampPretty(s: string): string {
  const d = s.replace(/\D/g, '')
  if (d.length < 14) return s
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}`
}
