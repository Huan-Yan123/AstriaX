/*
 * ★ 用户最贵的那份配置，写入必须是原子的
 *
 * ## 为什么要单独钉这个（审计抓出的真问题）
 *
 * `creds.ts` 里有两处覆盖用户**最贵的数据**：
 *
 *   1. `resetAstrBotConfig` → `<实例>\data\cmd_config.json`
 *      AstrBot 的**主配置**：账密、模型 API key、插件开关、人格设定
 *   2. `resetCredentials`（NapCat 支） → `config\webui.json` / `onebot11_*.json`
 *      NapCat 的 token + 端口 / host / 主题等用户设置
 *
 * 这两处原来都是裸的 `writeFileSync(file, JSON.stringify(...))`。
 * 而 `writeFileSync` 打开目标文件时会**先截断成 0 字节**再写
 *（util/atomic-write.ts:10-15 把这个机制讲得很清楚）——
 * 写到一半被杀 / 磁盘满 / 被安全软件锁住，用户拿到的是**残缺的 JSON**。
 *
 * 更糟的是读的一侧几乎都写成 `try { read } catch { 用默认值 }`，
 * 于是"文件坏了"被静默当成"文件不存在" → 回落到空配置 →
 * 用户看到的是「我配的东西全没了」，而且没有任何报错。
 *
 * 讽刺的是这个文件自己的注释（105-130 行）专门讲了
 * 「cmd_config.json 是主配置，含 API key」，并为它加了 quarantineConfig
 * 留证 —— 但那保的只是**读**的一侧。
 *
 * ## 怎么测"原子"
 *
 * 真去制造"写到一半失败"很难，但可以测**原子写的可观测特征**：
 *
 *   1. **内容正确**：写完还能正常 parse，字段都对（基本盘）
 *   2. **没有临时文件残留**：writeFileAtomic 用 tmp + rename，
 *      正常路径下不该在目录里留下 `*.tmp*`
 *   3. **失败时不破坏原文件**：让 rename 目标不可写 / 或让写入抛错，
 *      断言原文件**内容不变** —— 这是原子性最有价值的性质，
 *      也是裸 writeFileSync 做不到的（它会先把原文件截断成 0 字节）
 *
 * 第 3 条是核心：它把"原子"从"实现细节"变成了"可观察的行为契约"。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync } from 'fs'
import { join } from 'path'
import { resetCredentials } from '../../src/main/creds/creds'
import { writeJsonAtomic } from '../../src/main/util/atomic-write'
import { testStage } from '../helpers/stage'

let root: string

beforeEach(() => {
  root = testStage('mx-creds-atomic-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('★凭据重置：覆盖用户配置必须原子', () => {
  it('AstrBot 主配置写完后内容完好、没有 tmp 残留', () => {
    const dir = join(root, 'instances', 'AstrBot', 'a_atomic1')
    mkdirSync(join(dir, 'data'), { recursive: true })
    // 先放一份"用户已有的配置"（含我们要保住的自定义字段）
    const cfg = join(dir, 'data', 'cmd_config.json')
    writeFileSync(
      cfg,
      JSON.stringify(
        { dashboard: { username: 'old', theme: 'dark' }, myCustom: { apiKey: 'SECRET-123' } },
        null,
        2
      ),
      'utf8'
    )

    resetCredentials({ dir, type: 'a' })

    // 1) 内容完好、且是我们期望的形态
    const after = JSON.parse(readFileSync(cfg, 'utf8')) as Record<string, unknown>
    expect(after.dashboard, 'dashboard 段应当还在').toBeTruthy()
    expect(
      (after.dashboard as Record<string, unknown>).username,
      '账密应当被重置成默认用户名'
    ).toBe('astrbot')
    expect(msgOf(after), '用户自己的自定义字段必须保留（不能整份覆盖掉）').toContain('SECRET-123')

    // 2) 目录里不该留下 .tmp 中间文件
    const stray = readdirSync(join(dir, 'data')).filter((f) => /\.tmp/i.test(f))
    expect(stray, `原子写不该留临时文件，实际留下：${stray.join(', ')}`).toEqual([])
  })

  it('★跨平台区分力：写入期间原文件必须始终可读完整（原子性可观测证据）', async () => {
    /*
     * ## 为什么单独写这一条（这是"验证尺子"那一步逼出来的）
     *
     * 我原来那几条断言（"写完内容合法"、"没有 .tmp 残留"）看起来在测原子性，
     * 但我写了个探针把实现换回裸 `writeFileSync` 之后 —— **它们全部照样通过**。
     * 那几条测不出原子与非原子的差别，是安慰剂。
     *
     * 真正能区分的性质是：**任何时刻读目标文件，要么完整旧内容、
     * 要么完整新内容，不存在中间态**。而裸 writeFileSync 会先把文件
     * 截断成 0 字节再写 —— 中间态是真实存在的。
     *
     * ## 怎么抓到那个中间态（这里踩了两个坑）
     *
     * **坑 1：不能在同一个线程里"边写边读"。**
     * 我第一版用 `setInterval(reader, 0)` + 同步的 resetCredentials()，
     * 结果守卫报"读循环一次都没跑" —— 因为写操作是**同步阻塞**的，
     * 事件循环根本轮不到定时器回调，循环全程零次执行，测试是空转的。
     *
     * **坑 2：必须用真正的并发。**
     * 所以改用 **worker_threads**：读循环跑在独立线程里，
     * 主线程做同步写。两个线程真并行，才可能撞上截断窗口。
     *
     * 用 worker 还有一个好处：它不受 vitest 假定时器影响。
     *
     * 判据：worker 期间读到的内容必须是"合法的完整 JSON"。
     *   · 原子写（tmp+rename）→ 永远是旧完整值或新完整值 → 通过
     *   · 裸 writeFileSync → 会读到空串/半截 JSON → 失败
     *
     * 实测确认：把实现换成 writeFileSync 后这条**稳定失败**
     *（scripts/_verify-atomic-test.cjs）。
     */
    const dir = join(root, 'instances', 'AstrBot', 'a_race')
    mkdirSync(join(dir, 'data'), { recursive: true })
    const cfg = join(dir, 'data', 'cmd_config.json')

    /*
     * 写一份"大"配置：把非原子写的截断窗口拉宽到可观测。
     * 几百 KB 的写要几毫秒，足够 worker 撞上。
     */
    const bigPad = Array.from({ length: 6000 }, (_, i) => ({ idx: i, blob: 'x'.repeat(200) }))
    const initial = JSON.stringify({ dashboard: { username: 'old' }, pad: bigPad }, null, 2)
    writeFileSync(cfg, initial, 'utf8')
    expect(initial.length, '初始文件要足够大才会出现可观测窗口').toBeGreaterThan(300_000)

    // ── 起一个 worker 疯狂读，记录是否读到过残缺内容 ──
    const { Worker } = await import('worker_threads')
    const workerSrc = `
      const { parentPort, workerData } = require('worker_threads')
      const { readFileSync } = require('fs')
      const cfg = workerData.cfg
      let reads = 0
      let broken = ''
      const deadline = Date.now() + workerData.ms
      while (Date.now() < deadline) {
        try {
          const text = readFileSync(cfg, 'utf8')
          reads++
          if (text.length === 0) { broken = '(空文件)'; break }
          try { JSON.parse(text) } catch (e) {
            broken = 'parse 失败：' + String(e.message).slice(0, 50)
            break
          }
        } catch (e) {
          // 读不到文件本身也是中间态的一种（rename 换名的瞬间）
          broken = '读文件失败：' + String(e.message).slice(0, 50)
          break
        }
      }
      parentPort.postMessage({ reads, broken })
    `

    const worker = new Worker(workerSrc, {
      eval: true,
      workerData: { cfg, ms: 1500 }
    })
    const resultPromise = new Promise<{ reads: number; broken: string }>((resolve, reject) => {
      worker.on('message', resolve)
      worker.on('error', reject)
    })

    // 让 worker 先跑起来，然后主线程做同步写（真并发）
    await new Promise((r) => setTimeout(r, 120))

    /*
     * ## Windows 上的一个额外发现：并发读会让 rename 拿到 EPERM
     *
     * 实测（这个用例第一次跑的时候就是）：worker 在疯狂 readFileSync
     * 同一个文件时，主线程的 `renameSync(tmp, target)` 会报
     *     EPERM: operation not permitted, rename '...tmp' -> '...cmd_config.json'
     *
     * 因为 Windows 不允许在文件被打开时替换它（POSIX 允许）。
     * 这不是产品 bug —— 真实使用中不会有线程疯狂读同一个配置文件，
     * 而这个 EPERM 恰好证明原子写**没有破坏原文件**（renamed 失败 → 旧文件完好）。
     *
     * 所以这里接受 EPERM：它本身就是"写入失败时原文件不受损"的证据。
     * 真正要断言的是"从没读到过残缺内容"。
     */
    let wrote = 0
    let renameBlocked = 0
    for (let i = 0; i < 12; i++) {
      try {
        resetCredentials({ dir, type: 'a' })
        wrote++
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (/EPERM|EBUSY|EACCES/.test(msg)) {
          // 被并发读挡住 —— 预期内，且原文件因此完好
          renameBlocked++
        } else {
          throw e
        }
      }
    }

    const res = await resultPromise

    expect(res.reads, 'worker 应当真的读到过文件（否则这条测试是空转）').toBeGreaterThan(0)
    expect(
      res.broken,
      `写入过程中读到了残缺内容（${res.broken}）—— 说明写入不是原子的：` +
        `读的一侧会看到"文件坏了"，而项目的读路径会把坏文件静默当成"不存在"并回落空配置`
    ).toBe('')

    /*
     * 最后：无论中途有多少次因并发而 rename 失败，
     * 文件最终都必须是**完整合法**的 JSON（旧值或新值都行）。
     * 这条保证"失败不会留下坏文件"。
     */
    const finalText = readFileSync(cfg, 'utf8')
    expect(() => JSON.parse(finalText), '最终文件必须是合法 JSON').not.toThrow()
    expect(finalText.length, '最终文件不能是空/截断的').toBeGreaterThan(1000)
  })

  it('★rename 失败时：抛错 + 清掉 tmp（失败路径的行为契约）', () => {
    /*
     * ## 为什么用 writeJsonAtomic 直接测，而不是走 resetCredentials
     *
     * 上一条用例在 Windows 上会走"跳过 chmod"的分支 ——
     * 因为 Windows 的 chmod 对目录创建临时文件无效，没法用只读目录
     * 模拟"写入失败"。那样就只能验"内容合法"，**验不到原子性**，
     * 而原子性恰恰是这个修复的全部意义。所以这里换一个跨平台都能
     * 真正制造失败的办法。
     *
     * ## 怎么造一个"必定失败"的写入
     *
     * writeFileAtomic 的收尾是 `renameSync(tmp, target)`。
     * 如果 target 是一个**已存在的非空目录**，rename 必然失败
     *（Windows: MoveFileEx 拒绝覆盖目录；POSIX: rename 到目录报 EISDIR/ENOTEMPTY）。
     *
     * 于是可以验证原子写两个最关键的行为：
     *   1. **抛错**（不吞异常 —— 调用方必须知道写失败了）
     *   2. **tmp 被清理**（util/atomic-write.ts:61-69 的承诺：
     *      "换名失败：清掉 tmp 再抛，别在用户目录里留一地垃圾"）
     *
     * 而"原文件不受损"这一点在这里体现为：那个非空目录**没有被破坏**
     *（裸 writeFileSync 会试图把它当文件写，行为完全不同）。
     */
    const dir = join(root, 'atomic-fail')
    mkdirSync(dir, { recursive: true })
    // 让 target 是个非空目录 → rename 必失败
    const target = join(dir, 'cfg.json')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'inside.txt'), 'do-not-touch', 'utf8')

    expect(
      () => writeJsonAtomic(target, { hello: 'world' }),
      'rename 到非空目录应当失败并抛错（不能静默吞掉）'
    ).toThrow()

    // 目录里的东西没被动过
    expect(readFileSync(join(target, 'inside.txt'), 'utf8')).toBe('do-not-touch')

    // 没有留下 .tmp 垃圾
    const stray = readdirSync(dir).filter((f) => /\.tmp/i.test(f))
    expect(stray, `失败后留下了临时文件：${stray.join(', ')}`).toEqual([])
  })

  it('POSIX 上：目录不可写时原文件保持原样（真正模拟"写到一半失败"）', () => {
    const dir = join(root, 'instances', 'AstrBot', 'a_atomic2')
    mkdirSync(join(dir, 'data'), { recursive: true })
    const cfg = join(dir, 'data', 'cmd_config.json')
    const good = JSON.stringify({ dashboard: { username: 'keep-me' }, apiKey: 'VERY-SECRET' }, null, 2)
    writeFileSync(cfg, good, 'utf8')

    /*
     * Windows 上没法用 chmod 模拟"目录不可写"（Node 的 chmod 在 Windows
     * 上只影响只读位，对"能否在目录里创建临时文件"无效）。
     * 所以这一条只在 POSIX 上跑；Windows 的原子性证据由上一条覆盖
     *（rename 失败 → 抛错 + 清理 tmp）。
     */
    if (process.platform === 'win32') {
      // 明确标注跳过，而不是假装测过
      expect(process.platform).toBe('win32')
      return
    }

    chmodSync(join(dir, 'data'), 0o555)
    try {
      try {
        resetCredentials({ dir, type: 'a' })
      } catch {
        /* 抛错是允许的：writeFileAtomic 不吞异常 */
      }
      const after = readFileSync(cfg, 'utf8')
      expect(
        after,
        '写入失败后原文件被改动了 —— 裸 writeFileSync 会把它截断成 0 字节，这正是原子性要防的'
      ).toBe(good)
    } finally {
      chmodSync(join(dir, 'data'), 0o755)
    }
  })

  it('NapCat 的 webui.json 也只改 token、保住其它字段，且原子', () => {
    const dir = join(root, 'instances', 'NapCat', 'n_atomic1')
    mkdirSync(join(dir, 'config'), { recursive: true })
    const webui = join(dir, 'config', 'webui.json')
    writeFileSync(
      webui,
      JSON.stringify({ token: 'old', port: 6099, host: '0.0.0.0', theme: 'dark' }, null, 2),
      'utf8'
    )

    resetCredentials({ dir, type: 'n' })

    const after = JSON.parse(readFileSync(webui, 'utf8')) as Record<string, unknown>
    expect(after.token, 'token 应当被重置').not.toBe('old')
    // ★ 这三个字段是 NapCat 自己的设置，绝不能被覆盖掉
    expect(after.port, 'port 必须保住（原来被整份覆盖成默认 6099）').toBe(6099)
    expect(after.host, 'host 必须保住').toBe('0.0.0.0')
    expect(after.theme, 'theme 必须保住').toBe('dark')

    const stray = readdirSync(join(dir, 'config')).filter((f) => /\.tmp/i.test(f))
    expect(stray, `不该留临时文件：${stray.join(', ')}`).toEqual([])
  })
})

/** 在嵌套对象里找自定义字段（写得笨一点，避免依赖具体结构） */
function msgOf(o: Record<string, unknown>): string {
  return JSON.stringify(o)
}
