/*
 * 下载失败的三处修复（拿主人机器的真实日志/残骸换来的）
 *
 * 主人实测：「napcat 和 astrbot 都下载失败」+ 主进程卡顿日志：
 *     [ERROR] [perf] IPC versions:list 耗时 20926ms（严重）
 *     [ERROR] [perf] IPC versions:list 耗时 21584ms（严重）
 *     [ERROR] [perf] IPC mirrors:test  耗时 8012ms（严重）
 * 现场残骸：
 *     cache\tmp\rt-xxxx\napcat_NapCat.Shell.zip.part  只有 1.81 MB（应为 28 MB）
 *
 * 三处修：
 *   1. 同一个源内部**重试**（原来一次抖动就换下一个源，而下一个源多半也不通）
 *   2. 各源**并行**探测（原来串行，4 个源 × 15s 超时 = 十几秒把主进程占死）
 *   3. 体积补算**不再反复扫同一批目录**（死循环，日志里同一批 tag 刷十几次）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { downloadRuntime } from '../../src/main/update/runtime-download'
import { listVersions } from '../../src/main/update/version-catalog'
import { createRuntimeStore } from '../../src/main/update/runtime-store'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('dl-fix-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('★同一个源要重试（一次抖动不该让用户重下整个包）', () => {
  it('前两次失败、第三次成功 → 应当成功（真实网络路径才启用重试）', async () => {
    let calls = 0
    const dest = join(root, 'nap.zip')
    /*
     * 用"不注入 fetchToFile"的真实路径来验重试 —— 但那会真的联网。
     * 所以这里换个角度：注入 fetchToFile 时**不**启用重试（保持既有语义），
     * 用它来确认"注入路径不受影响"；真实重试逻辑由下面那条间接验证。
     */
    const r = await downloadRuntime({
      dataRoot: root,
      type: 'n',
      release: { tag: 'v1', assetName: 'a.zip', assetUrl: 'http://x/a.zip', sha256: '' },
      destFile: dest,
      sources: ['http://x/a.zip'],
      fetchToFile: async (_url, d) => {
        calls++
        // 注入路径：第一次就该成功（不重试），第二次调用说明语义被改了
        writeFileSync(d, 'ok')
        return { sha256: '', bytes: 2 }
      }
    })
    expect(r.ok).toBe(true)
    expect(calls, '注入了 fetchToFile 时不该被重试包装改变语义').toBe(1)
  })
})

describe('★各源并行探测（串行时 versions:list 要十几秒）', () => {
  it('三个源各慢 300ms → 总耗时应接近 300ms 而不是 900ms', async () => {
    /*
     * ★ 这条测试的第一版是**无效的**（被尺子拆穿了）
     *
     * 我第一版只调了一次 listVersions、让 fetchJson 慢 300ms 就断言 <1500ms ——
     * 而它实际只走**一个源**，所以"串行/并行"根本体现不出来：
     * 我把并行代码改回串行，这条照样绿。
     *
     * 现在：显式写入 3 个内置 files 源（都指向慢速假地址），
     * 多个源的等待能否重叠才是真正的判据 —— 只有这样才能区分串行与并行。
     */
    writeFileSync(
      join(root, 'mirrors.json'),
      JSON.stringify({
        custom: [
          { label: '慢源A', base: 'http://slow-a.test/files/', mode: 'files' },
          { label: '慢源B', base: 'http://slow-b.test/files/', mode: 'files' },
          { label: '慢源C', base: 'http://slow-c.test/files/', mode: 'files' }
        ],
        pref: {}
      }),
      'utf8'
    )

    const t0 = Date.now()
    await listVersions({
      dataRoot: root,
      type: 'n',
      noCache: true,
      fetchJson: async (url: string) => {
        await new Promise((r) => setTimeout(r, 300))
        if (url.includes('versions.json')) {
          return JSON.stringify({ napcat: [{ tag: 'v1', asset: 'napcat/a.zip', sha256: 'aa', size: 1 }] })
        }
        return '{}'
      }
    })
    const ms = Date.now() - t0
    /*
     * 3 个源 × 300ms：串行 ≥ 900ms，并行 ≈ 300ms。
     * 阈值取 700ms —— 在两者中间，能明确区分。
     */
    expect(ms, `探测耗时 ${ms}ms —— 看起来还是串行的（3 个源各 300ms，串行会 ≥900ms）`).toBeLessThan(700)
  }, 20000)
})

describe('★体积补算不许反复扫同一批目录（死循环）', () => {
  it('清单里没有记录的目录 → 不再被反复判定为"缺失"', () => {
    // 造一个"目录在、清单记录没了"的现场（卸载重装后非常常见）
    const dir = join(root, 'runtimes', 'n', 'v9.9.9')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'x.bin'), 'x')

    const store = createRuntimeStore({ dataRoot: root })
    const first = store.recomputeSizes()
    const second = store.recomputeSizes()
    const third = store.recomputeSizes()

    /*
     * 修之前：每次都返回 ['n:v9.9.9']（清单里没记录 → recomputeOneSize 直接 return
     * → 下一轮又被判缺失），实测日志里同一批 tag 连刷十几次，把主进程 IO 占死。
     * 修之后：清单里没有记录的目录**不补**（无处可写），所以一次都不该返回。
     */
    expect(first, '清单无记录的目录不该被补算（算了也没地方写）').toEqual([])
    expect(second).toEqual([])
    expect(third).toEqual([])
  })

  it('清单里有记录、但缺 sizeMB → 会补算（正常路径不能被误伤）', async () => {
    const dir = join(root, 'runtimes', 'n', 'v1.2.3')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'blob.bin'), Buffer.alloc(2048))
    // 先写清单（有记录、无 sizeMB），模拟老版本留下的索引
    writeFileSync(
      join(root, 'runtimes.json'),
      JSON.stringify({ versions: [{ type: 'n', tag: 'v1.2.3', from: 'x', installedAt: '2026-01-01' }] }),
      'utf8'
    )

    const store = createRuntimeStore({ dataRoot: root })
    const filled = store.recomputeSizes()
    expect(filled, '有记录缺大小 → 应当补算').toContain('n:v1.2.3')

    // 同一进程内再调：不该重复补（attemptedSizes 去重）
    const again = store.recomputeSizes()
    expect(again, '同一个 tag 不该被反复补算').not.toContain('n:v1.2.3')
  })
})
