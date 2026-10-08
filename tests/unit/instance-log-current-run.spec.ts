/*
 * ★★ 实例日志的两条修复（主人 2026-09-27 实测提出）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## ① 日志时间必须与本机时间一致
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 主人原话：「实例日志的时间怎么和本机时间不一致」
 *
 * 根因：`process-manager.ts` 里写的是
 *     const stamp = new Date().toISOString().slice(11, 23)
 * `toISOString()` 返回 **UTC** —— 东八区用户看到的就是**早 8 小时**。
 *（他贴的日志里，AstrBot 自己打的 `[13:54:24]` 与我们的 `[05:54:17]`
 *  正好差 8 小时，一眼可见。）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## ② 「翻翻日志」只显示本次运行
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 主人原话：
 *   「翻翻日志功能改成只显示实例这次运行的日志」
 *   「为啥不是通过实例启动来判定」   ← 这句点醒了我
 *
 * 我先试了两条弯路（都在真机日志上翻车）：
 *   ① 自己写分隔线 → 主人否掉（"不需要分割线"）
 *   ② 找 AstrBot 的启动横幅 → 仍在猜文本
 *
 * 现在按主人指的路：**启动是我们发起的**，那一刻文件有多长我们完全知道。
 * 启动成功时把长度记进 `rec.lastLogOffset`，读日志时从那之后开始。
 */
import { describe, it, expect } from 'vitest'
import { writeFileSync, appendFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { testStage } from '../helpers/stage'
import { readLogTail, readFromOffset } from '../../src/main/logs/read-snippet'

describe('★★日志时间：必须是本机时间（不是 UTC）', () => {
  it('★源码守卫：不许再用 toISOString 取时间戳前缀', () => {
    /*
     * 这是**接线层**的守卫 —— 时间戳在 process-manager 里拼，
     * 而"用没用 UTC"只有看代码才知道（跑起来在 UTC 时区的 CI 上测不出差别）。
     *
     * 判据：那段拼 stamp 的代码里不许出现 toISOString，
     * 而应当用 getHours/getMinutes/... （本机时区）。
     */
    const src = require('fs').readFileSync(
      join(process.cwd(), 'src', 'main', 'proc', 'process-manager.ts'),
      'utf8'
    ) as string

    /*
     * ★ 必须先去掉注释再判断（这条守卫自己踩过一次）
     *
     * 第一版直接全文匹配 `const stamp = new Date().toISOString()` ——
     * 而**注释里**正好引用着那句旧写法（我写下来解释"原来的错在哪"），
     * 于是守卫永远红。
     *
     * 这与项目里其它源码守卫的教训一样：**扫源码前先剥注释**，
     * 否则"解释错的注释"会被当成错本身。
     */
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .split('\n')
      .map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
      .join('\n')

    const bad = /new Date\(\)\.toISOString\(\)\.slice\(/
    expect(
      bad.test(code),
      '★又用 toISOString() 拼日志时间戳了 —— 那是 **UTC**，\n' +
        '东八区用户看到的日志会比本机时间早 8 小时（主人实测报过这个）。\n' +
        '应当用 getHours()/getMinutes()/getSeconds()/getMilliseconds() 拼本机时间。'
    ).toBe(false)
    expect(
      /getHours\(\)/.test(code),
      '时间戳应当取本机时区的小时（getHours）'
    ).toBe(true)
  })
})

describe('★★「只看本次运行」：按启动时记的字节偏移', () => {
  /** 造一个"跑过两次"的日志：前半段是上次，后半段是本次 */
  function makeTwoRuns(): { dir: string; file: string; offset: number } {
    const dir = testStage('logrun-')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'a_test.log')
    const run1 = '[13:00:00.000][out] 上次运行：旧版本启动\n[13:00:01.000][err] 上次的报错\n'
    writeFileSync(file, run1, 'utf8')
    /* 记录"那一刻文件多长"—— 真实代码在 instance:start 里取 */
    const offset = Buffer.byteLength(run1, 'utf8')
    appendFileSync(file, '[14:00:00.000][out] 本次运行：新版本启动\n', 'utf8')
    return { dir, file, offset }
  }

  it('★给了偏移 → 只返回本次运行的部分（历史不混进来）', () => {
    const { dir, file, offset } = makeTwoRuns()
    try {
      const r = readLogTail(file, 500, { fromOffset: offset })
      expect(r.text, '★不该出现上次运行的日志').not.toContain('上次运行')
      expect(r.text, '不该出现上次的报错').not.toContain('上次的报错')
      expect(r.text, '本次运行的内容要在').toContain('本次运行')
      expect(r.bootMarked, '标记"这是从偏移开始的"').toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★没给偏移 → 退回显示全部（老实例还没记过偏移）', () => {
    const { dir, file } = makeTwoRuns()
    try {
      const r = readLogTail(file, 500)
      expect(r.text, '没偏移时给全部 —— 宁可多给也不能给空').toContain('上次运行')
      expect(r.text).toContain('本次运行')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★★偏移超过文件大小（日志被清空过）→ 也退回全部，不能给空', () => {
    /*
     * 真实场景：用户手动清空/删过日志文件，而记录里的偏移还是旧的。
     * 这时如果照偏移读，会得到**空字符串** —— 那是**更糟**的结果：
     * 用户点「翻翻日志」看到一片空白，以为功能坏了。
     */
    const { dir, file } = makeTwoRuns()
    try {
      const r = readLogTail(file, 500, { fromOffset: 999_999_999 })
      expect(r.text.length, '★偏移无效时必须退回全部，绝不能给空').toBeGreaterThan(0)
      expect(r.text).toContain('本次运行')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('偏移为 0 / undefined → 全部（那是"还没启动过"的正常情况）', () => {
    const { dir, file } = makeTwoRuns()
    try {
      expect(readLogTail(file, 500, { fromOffset: 0 }).text).toContain('上次运行')
      expect(readLogTail(file, 500, { fromOffset: undefined }).text).toContain('上次运行')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readFromOffset 对不存在的文件返回空串（不抛）', () => {
    expect(readFromOffset(join(testStage('nope-'), 'x.log'), 10)).toBe('')
  })
})
