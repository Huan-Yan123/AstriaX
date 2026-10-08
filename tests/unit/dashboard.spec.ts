/*
 * AstrBot Dashboard 预装的单测。
 *
 * 背景（公测反馈里的致命 bug）：实例日志原文
 *     [out] Dashboard is not installed
 *     [out] Install dashboard? [Y/n]:
 *     [err] click.exceptions.Abort
 * AstrBot 本体跑起来了，却卡在这句**等用户输入**的提问上 ——
 * 我们是非交互 spawn，没人回答 → Abort → 实例永远起不来。
 *
 * 这里钉四条契约：
 *   1. 已经有 dist（且非空）→ 一次网络都不发（幂等）
 *   2. 没有 → 按源顺序下载 + 解压到 <实例>\data\dist
 *   3. **共享缓存**：第二个实例复用同一份 zip，不重复下 9.7MB
 *   4. 解压失败 → 不留"半个 dist"（那会被判成装好了，前端却白屏）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ensureDashboard, dashboardReady, dashboardUrls } from '../../src/main/runtime/dashboard'
import { testStage } from '../helpers/stage'

let root: string
let inst: string
beforeEach(() => {
  root = testStage('dashboard-')
  inst = join(root, 'instances', 'AstrBot', 'a_test')
  mkdirSync(inst, { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * 假的解压：造出**真实 zip 的结构** —— 必须含 `dist/assets/version`。
 *
 * ★ 第一版只造 `dist/index.html`，与真实 zip 和 AstrBot 的判据都不符
 *   （被审查抓出来）：AstrBot 靠 `dist/assets/version` 判断"装没装"
 *   （astrbot/core/utils/io.py:330 的 `_read_dashboard_dist_version`），
 *   没有它照样会 `click.confirm` → Abort。
 *   测试造的结构不对，就永远测不到真问题。
 */
const fakeUnzip =
  (files: Record<string, string> = {}) =>
  async (zip: string, dest: string): Promise<void> => {
    const dist = join(dest, 'dist')
    mkdirSync(join(dist, 'assets'), { recursive: true })
    // 真实 zip 里 assets/version 的内容形如 "v4.25.4"
    writeFileSync(join(dist, 'assets', 'version'), 'v4.25.4', 'utf8')
    writeFileSync(join(dist, 'index.html'), '<html>', 'utf8')
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dist, name), content, 'utf8')
    }
  }

describe('★dashboard 预装（修 "Install dashboard? [Y/n]" 卡死）', () => {
  it('已经有 dist → 不发任何网络请求（幂等）', async () => {
    mkdirSync(join(inst, 'data', 'dist', 'assets'), { recursive: true })
    writeFileSync(join(inst, 'data', 'dist', 'index.html'), 'x')
    // 必须带 assets/version —— 那才是 AstrBot 认的判据（见 fakeUnzip 注释）
    writeFileSync(join(inst, 'data', 'dist', 'assets', 'version'), 'v4.25.4')
    let calls = 0
    const ok = await ensureDashboard({
      instanceDir: inst,
      version: 'v4.25.2',
      fetchFile: async () => {
        calls++
      },
      unzip: fakeUnzip()
    })
    expect(ok).toBe(true)
    expect(calls, '已经装好了还去下载 = 每次启动都白下 9.7MB').toBe(0)
  })

  it('没有 dist → 下载并解压到 <实例>\\data\\dist', async () => {
    const fetched: string[] = []
    const ok = await ensureDashboard({
      instanceDir: inst,
      version: 'v4.25.2',
      fetchFile: async (url, dest) => {
        fetched.push(url)
        writeFileSync(dest, 'zip-bytes')
      },
      unzip: fakeUnzip()
    })
    expect(ok).toBe(true)
    expect(fetched[0], '应当先试 AstrBot 自己的 registry 源').toContain(
      '/astrbot-dashboard/v4.25.2/dist.zip'
    )
    expect(existsSync(join(inst, 'data', 'dist', 'index.html'))).toBe(true)
    expect(dashboardReady(inst)).toBe(true)
  })

  it('★第一个源失败 → 自动换下一个源（三个源都试过才算失败）', async () => {
    const tried: string[] = []
    const ok = await ensureDashboard({
      instanceDir: inst,
      version: 'v4.25.2',
      fetchFile: async (url, dest) => {
        tried.push(url)
        if (tried.length < 2) throw new Error('源1不通')
        writeFileSync(dest, 'zip')
      },
      unzip: fakeUnzip()
    })
    expect(ok).toBe(true)
    expect(tried.length, '应当试了不止一个源').toBeGreaterThan(1)
  })

  it('★共享缓存：第二个实例复用同一份 zip（不再下 9.7MB）', async () => {
    const cacheDir = join(root, 'cache', 'dashboard')
    let downloads = 0
    const inst2 = join(root, 'instances', 'AstrBot', 'a_second')
    mkdirSync(inst2, { recursive: true })
    const deps = (dir: string) => ({
      instanceDir: dir,
      version: 'v4.25.2',
      cacheDir,
      fetchFile: async (_url: string, dest: string) => {
        downloads++
        writeFileSync(dest, 'zip')
      },
      unzip: fakeUnzip()
    })
    await ensureDashboard(deps(inst))
    await ensureDashboard(deps(inst2))
    expect(downloads, '多开场景下每个实例都下一遍是纯浪费').toBe(1)
    expect(dashboardReady(inst2)).toBe(true)
  })

  it('★解压失败 → 不留"半个 dist"（否则会被判成装好了，前端白屏）', async () => {
    const ok = await ensureDashboard({
      instanceDir: inst,
      version: 'v4.25.2',
      fetchFile: async (_url, dest) => {
        writeFileSync(dest, 'zip')
      },
      unzip: async (_zip, dest) => {
        // 解压到一半失败：已经建了目录但没内容
        mkdirSync(join(dest, 'dist'), { recursive: true })
        throw new Error('解压中断')
      }
    })
    expect(ok, '解压失败要如实返回 false').toBe(false)
    expect(
      dashboardReady(inst),
      '残留空 dist 会被 dashboardReady 判成"装好了" —— 必须清干净'
    ).toBe(false)
  })

  it('三个源全不通 → 返回 false（调用方照旧启动，但日志里有记录）', async () => {
    const logs: string[] = []
    const ok = await ensureDashboard({
      instanceDir: inst,
      version: 'v4.25.2',
      log: (m) => logs.push(m),
      fetchFile: async () => {
        throw new Error('网络不通')
      },
      unzip: fakeUnzip()
    })
    expect(ok).toBe(false)
    expect(logs.join('\n'), '要留下"没装成"的证据，别静默').toContain('都没下成功')
  })

  it('候选 URL 覆盖 AstrBot 自己的两个源 + GitHub 兜底', () => {
    const urls = dashboardUrls('4.25.2')
    expect(urls).toHaveLength(3)
    expect(urls[0]).toContain('/v4.25.2/dist.zip')
    expect(urls[1]).toContain('/latest/dist.zip')
    expect(urls[2]).toContain('github.com/AstrBotDevs/AstrBot/releases')
  })

  it('★判据与 AstrBot 一致：缺 assets/version 一律算"未就绪"', () => {
    /*
     * ★ 这条是审查专门要求补的边界（也正好守住那个真实事故）。
     *
     * 第一版判据是"dist 目录非空即算装好"，于是：
     *   解压不完整（有文件但缺 assets/version）→ 我们判"已装好"→
     *   **再也不尝试修复**，而 AstrBot 那边照样 `click.confirm` → Abort。
     *   失败形态与原 bug 一模一样，且因为 ready=true，
     *   连"没预装成功"的 WARN 都不会打 —— 比现在更难排查。
     *
     * 现在按 AstrBot 的真实判据（io.py:330 读 `dist/assets/version`）：
     *   目录非空但没这个文件 → **必须** false。
     */
    // 空目录
    mkdirSync(join(inst, 'data', 'dist'), { recursive: true })
    expect(dashboardReady(inst), '空目录').toBe(false)

    // 有文件、但缺 assets/version（解压不完整的典型形态）
    writeFileSync(join(inst, 'data', 'dist', 'a.js'), 'x')
    expect(
      dashboardReady(inst),
      '有文件但缺 assets/version —— AstrBot 认不出，必须判未就绪（否则永远不重试）'
    ).toBe(false)

    // version 文件存在但内容为空 → 同样不算
    mkdirSync(join(inst, 'data', 'dist', 'assets'), { recursive: true })
    writeFileSync(join(inst, 'data', 'dist', 'assets', 'version'), '   ')
    expect(dashboardReady(inst), 'version 内容为空').toBe(false)

    // 真正就位
    writeFileSync(join(inst, 'data', 'dist', 'assets', 'version'), 'v4.25.4')
    expect(dashboardReady(inst), '有 assets/version 才算真就位').toBe(true)
  })
})
