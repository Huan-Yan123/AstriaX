import { existsSync, readFileSync } from 'fs'
import { basename, join } from 'path'
/*
 * ★ `readJsonFile` 是**必须的导入**（第二版排查报告抓出的真 bug）
 *
 * 这个文件原来只 import 了 fs / path / builtin-version，而下面用了
 * `readJsonFile` —— 于是三层兜底的**第二层永远抛 ReferenceError**：
 *
 *     ① 运行时包内标识（readBuiltinVersion）  → 可用
 *     ② instance.json 的 runtimeTag           → **永远抛错**
 *     ③ 目录名正则（v4.18.19 → 4.18.19）      → 兜底生效
 *
 * 而异常被那个 `catch` 静默吞掉，所以：
 *   · 表面上"有兜底、能工作"
 *   · 实际生效的只有**最不可靠的第 ③ 层**（目录名）
 *   · 而文件头注释明写"目录名和 instance.json 都会骗人"
 *
 * 这与 C-1（mirror-store 那两个函数没导入）是**同一类错误**：
 * 用了但没导入，而运行时错误被 catch 吃掉 → 功能"看起来在"其实从未生效。
 *
 * 教训：**静默 catch 会掩盖 ReferenceError**。
 * 这类错一行 `tsc --noEmit` 就能全数拦下（见报告的 H-6：项目没有 typecheck 门禁）。
 */
import { readJsonFile } from '../util/json-file'
import { readBuiltinVersion } from './builtin-version'

/**
 * 实例当前版本：界面上每张卡片要显示的那个值。
 *
 * 这是**三层兜底**，顺序不能换：
 *   1. 运行时包自己带的版本 —— 最权威。用户手动换过包、从别处拷过一份时，
 *      只有包内标识能反映真相（目录名和 instance.json 都会骗人）。
 *   2. instance.json 的 runtimeTag —— 我们自己下载时记的，正常情况都对。
 *   3. 运行时目录名 vX.Y.Z —— 最后的兜底。
 *
 * 三层都拿不到就返回 undefined。界面显示「未知」——
 * 宁可说不知道，也不能写一个假的版本号上去（那会让用户以为跑的是别的版本）。
 */
export function detectInstanceVersion(deps: {
  type: 'a' | 'n'
  /** 实例目录（里面有 instance.json） */
  instanceDir: string
  /** 这个实例绑定的运行时目录 */
  runtimeDir: string
}): string | undefined {
  // 1. 包内权威标识
  const builtin = readBuiltinVersion({ dir: deps.runtimeDir, type: deps.type })
  if (builtin) return builtin

  // 2. instance.json 的 runtimeTag（去掉前缀 v，统一成裸版本号）
  try {
    const f = join(deps.instanceDir, 'instance.json')
    if (existsSync(f)) {
      const j = readJsonFile<{ runtimeTag?: string }>(f)
      const tag = j.runtimeTag?.trim()
      if (tag) return tag.replace(/^v/i, '')
    }
  } catch {
    /* 文件坏了往下退 */
  }

  // 3. 目录名兜底：v4.18.19 → 4.18.19
  const name = basename(deps.runtimeDir)
  const m = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(name)
  return m?.[1]
}

/**
 * 'v4.28.0' → 4280 —— 给实例的 templateVersion 这类**数字字段**用。
 *
 * 为什么单独抽出来放这儿：这个换算原来是**两份重复实现** ——
 * ipc.ts 里有一个私有的 versionNumOf，template-dl.ts 里又抄了一遍。
 * 两份实现会漂移（比如一边改了大小写处理、另一边没改），
 * 而它们算出来的值要能互相对上（同一个版本号必须得到同一个数字，
 * 否则「实例绑的是哪个运行时」的判断就错了）。
 * 统一到一处，两边引用同一个函数。
 *
 * **踩过的坑（预发布版本）**：原来的写法是把前三段拼起来直接 Number()，
 * 遇到 `v4.28.0-beta.1` 会拼成 `'42800beta'` → `NaN` → 落到 `|| 1` 兜底，
 * 于是**所有预发布版本都变成 1**。而版本清单里明确支持预发布
 * （version-catalog.ts 有 includePrerelease，AstrBot 确实发过 -beta 的 tag），
 * 后果是两个不同的 beta 版本指纹相同，「实例绑的是哪个运行时」判断失灵。
 * 修法：先用正则只取数字部分，丢掉预发布后缀再拼。
 *
 * 注意：这是个**有损**换算，只适合当「同一版本的指纹」用，
 * 不能拿来比较版本大小（4.2.10 和 4.21.0 都会变成 4210 这种歧义）。
 * 比大小要用原字符串。
 */
export function versionNumOf(tag: string): number {
  /*
   * 只取版本号的数字主体：v4.28.0-beta.1 → 4.28.0
   * 用正则而不是简单 split，是因为后缀里可能带点号（-beta.1），
   * split('.') 会把 'beta' 和 '1' 也当成段，拼出 NaN。
   */
  const m = /^v?(\d+(?:\.\d+)*)/i.exec(String(tag).trim())
  if (!m) return 1
  return Number(m[1].split('.').slice(0, 3).join('').padEnd(3, '0')) || 1
}
