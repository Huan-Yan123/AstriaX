// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DownloadPage from '../../src/renderer/src/DownloadPage.vue'
import { dlInvalidate } from '../../src/renderer/src/dl-cache'

/**
 * ★ 下载按钮必须**跟着源的可用性自动上锁/解锁**（主人 2026-10-08）
 *
 * 主人原话：「修复下载按钮不会根据源是否可用而自动上锁和解锁」
 *          「确保程序检测到该源可用的时候会解锁，不可用会上锁」
 *
 * ## 实际缺陷（读源码确认）
 *
 * 源列表里两类源的按钮**判据不一致**：
 *   · AstrBot（Python 源）行：
 *       :disabled="pyHealth.get(s.indexUrl)?.status === 'unreachable'"
 *   · NapCat（GitHub 源）行：
 *       只有 @click，**完全没有 disabled**   ← 这是主缺陷
 *
 * 于是 NapCat 那些"不可用"的源，按钮照样能点、点进去是个空列表 ——
 * 用户白跑一趟，而且看不出是源的问题还是软件的问题。
 *
 * ## 判据该是什么
 *
 * 项目里 `deadMirrors`（决定"哪些源可以清理"）已经定义了正确口径：
 *     status !== 'ok'  →  不可用
 * 所以本守卫要求：**两类源的按钮用同一个口径**。
 *
 * ## ⚠️ 一处曾经错误的说法（独立复核指出，已更正）
 *
 * 本文件早先写着"AstrBot 那条判据漏了 empty"——**那句话夸大了**。
 * 事实是：当时 `python-source-test.ts` 的 `PySourceStatus` 只有
 * `ok | unreachable` 两个值，"200 但空页面"被归进了 `unreachable`，
 * 所以那条判据在效果上**恰好**没漏。
 *
 * 真正的缺陷只有两条：
 *   ① NapCat 行完全没有 disabled（功能性缺陷）
 *   ② 两个探测器的状态枚举不一致（Python 两值 / GitHub 三值）——
 *      那是"迟早会漏"的结构性隐患，本次一并把 Python 侧补成三值
 *（见 python-source-test.ts 的 `empty` 说明），于是下面那条 empty 用例
 * 才成为**真实可达**的验证，而不是喂一个后端不可能返回的值。
 */
function inject(opts: {
  mirrors?: Array<{ label: string; base: string; mode: 'proxy' | 'files'; builtin?: boolean }>
  mirrorTest?: Array<{ base: string; label: string; ms: number | null; status: string }>
  pySources?: Array<{ label: string; indexUrl: string; builtin?: boolean }>
  pyTest?: Array<{ indexUrl: string; label: string; ms: number | null; status: string }>
} = {}): void {
  const w = globalThis as unknown as { window: Record<string, unknown> }
  const mirrors = opts.mirrors ?? [
    { label: 'gh-proxy.com', base: 'https://gh-proxy.com/', mode: 'proxy' as const, builtin: true },
    { label: '坏源', base: 'https://dead.example/', mode: 'proxy' as const }
  ]
  w.window.launcher = {
    mirrors: {
      state: async () => ({ mirrors, pref: { a: '', n: '' } }),
      add: async () => undefined,
      remove: async () => undefined,
      test: async () => opts.mirrorTest ?? [],
      pref: async () => undefined
    },
    pysrc: {
      state: async () => ({
        sources: opts.pySources ?? [
          { label: 'Python源', indexUrl: 'https://pypi.org/simple/', builtin: true },
          { label: '坏Python源', indexUrl: 'https://dead.py/simple/' }
        ],
        pref: ''
      }),
      test: async () => opts.pyTest ?? []
    },
    versions: { list: async () => [] },
    runtime: { install: async () => ({ tag: 'v', from: 'x' }) },
    runtimes: { list: async () => [], remove: async () => undefined },
    python: { status: async () => ({ ready: true, version: '3.12.10' }), install: async () => ({ ready: true, version: '3.12.10' }) },
    stats: { overview: async () => ({ system: { totalMemMB: 16000, freeMemMB: 8000, totalDiskMB: 0, freeDiskMB: 0 } }) },
    onDownloadProgress: () => () => undefined,
    downloadSessions: async () => []
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  dlInvalidate()
})

/** 取某个源名所在那一行的「下载」按钮 */
function downloadBtnOf(w: ReturnType<typeof mount>, label: string) {
  const row = w.findAll('.source-row').find((r) => r.text().includes(label))
  expect(row, `找不到源「${label}」那一行`).toBeTruthy()
  return row!.findAll('button').find((b) => b.text() === '下载')!
}

describe('★ 下载按钮跟随源可用性上锁/解锁', () => {
  it('AstrBot：连不上的源 → 下载按钮必须禁用', async () => {
    inject({
      pyTest: [
        { indexUrl: 'https://pypi.org/simple/', label: 'Python源', ms: 120, status: 'ok' },
        { indexUrl: 'https://dead.py/simple/', label: '坏Python源', ms: null, status: 'unreachable' }
      ]
    })
    const w = mount(DownloadPage)
    await flushPromises()
    await flushPromises()

    expect(downloadBtnOf(w, 'Python源').attributes('disabled'), '可用源不该禁用').toBeUndefined()
    expect(
      downloadBtnOf(w, '坏Python源').attributes('disabled'),
      '连不上的 Python 源，下载按钮必须是禁用的（否则点进去是空列表）'
    ).toBeDefined()
  })

  it('★ AstrBot：连得上但没货（empty）也要禁用', async () => {
    /*
     * 这条在本次修复**之后**才是真实可达的：
     * 早先 `PySourceStatus` 只有 ok|unreachable，"空页面"被归进
     * unreachable（见文件顶部那段更正说明）。现在补了 empty 档，
     * 这里喂的值就是后端真会返回的。
     */
    inject({
      pyTest: [
        { indexUrl: 'https://pypi.org/simple/', label: 'Python源', ms: 120, status: 'ok' },
        { indexUrl: 'https://dead.py/simple/', label: '坏Python源', ms: null, status: 'empty' }
      ]
    })
    const w = mount(DownloadPage)
    await flushPromises()
    await flushPromises()

    expect(
      downloadBtnOf(w, '坏Python源').attributes('disabled'),
      '「连得上但源上没货」也算不可用 —— 下不到东西的源不该给用户点'
    ).toBeDefined()
  })

  it('★ NapCat：连不上的源 → 下载按钮必须禁用（原来完全没有 disabled）', async () => {
    inject({
      mirrorTest: [
        { base: 'https://gh-proxy.com/', label: 'gh-proxy.com', ms: 40, status: 'ok' },
        { base: 'https://dead.example/', label: '坏源', ms: null, status: 'unreachable' }
      ]
    })
    const w = mount(DownloadPage)
    await flushPromises()
    await flushPromises()

    expect(downloadBtnOf(w, 'gh-proxy.com').attributes('disabled'), '可用源不该禁用').toBeUndefined()
    expect(
      downloadBtnOf(w, '坏源').attributes('disabled'),
      '连不上的 GitHub 源，下载按钮必须禁用 —— 这里原来**根本没有 disabled**'
    ).toBeDefined()
  })

  it('★ NapCat：empty 也要禁用（与 AstrBot 同口径）', async () => {
    inject({
      mirrorTest: [
        { base: 'https://gh-proxy.com/', label: 'gh-proxy.com', ms: 40, status: 'ok' },
        { base: 'https://dead.example/', label: '坏源', ms: 90, status: 'empty' }
      ]
    })
    const w = mount(DownloadPage)
    await flushPromises()
    await flushPromises()

    expect(downloadBtnOf(w, '坏源').attributes('disabled')).toBeDefined()
  })

  it('★ 探测结果变化时按钮状态要跟着变（不能只在挂载时算一次）', async () => {
    /*
     * 「自动上锁和解锁」的关键是**响应式**：
     *   ① 首次进页面探测 → 坏源被锁
     *   ② 用户点「检测所有来源」→ 源恢复了 → 必须**自动解锁**
     *
     * 只写一个一次性 computed 是不够的，得真的跟着 health 变。
     */
    inject({
      mirrorTest: [{ base: 'https://dead.example/', label: '坏源', ms: null, status: 'unreachable' }]
    })
    const w = mount(DownloadPage)
    await flushPromises()
    await flushPromises()
    expect(downloadBtnOf(w, '坏源').attributes('disabled'), '探测后应锁定').toBeDefined()

    /* 模拟"源恢复了"：换掉 test 的返回值，再点检测 */
    const win = (globalThis as unknown as { window: Record<string, unknown> }).window
    const m = (win.launcher as Record<string, unknown>).mirrors as Record<string, unknown>
    m.test = async () => [{ base: 'https://dead.example/', label: '坏源', ms: 55, status: 'ok' }]

    const probeBtn = w.findAll('button').find((b) => b.text().includes('检测所有来源'))!
    await probeBtn.trigger('click')
    await flushPromises()
    await flushPromises()

    expect(
      downloadBtnOf(w, '坏源').attributes('disabled'),
      '源恢复可用后，按钮必须**自动解锁** —— 否则用户以为它永远坏了'
    ).toBeUndefined()
  })

  it('还没探测过的源不该被锁死（否则进页面瞬间全是灰的）', async () => {
    /*
     * 探测是异步的、要几百毫秒到几秒。如果"没探测"就当作不可用，
     * 用户进页面第一眼看到的是一排灰按钮 —— 那比"能点但可能失败"更糟。
     *
     * 所以口径是：**只有明确探测到不可用才锁**（undefined = 还没测 → 放行）。
     */
    inject({ mirrorTest: [] }) // 探测返回空 → 两条源都"没测过"
    const w = mount(DownloadPage)
    await flushPromises()
    await flushPromises()

    expect(
      downloadBtnOf(w, 'gh-proxy.com').attributes('disabled'),
      '未探测的源应当可点（下载时会按顺序回落试探）'
    ).toBeUndefined()
  })

  it('★ 锁上时要说清**为什么**（把探测给的原因展示出来）', async () => {
    /*
     * 独立复核抓出的缺口：只上锁不给原因，用户反而更迷茫 ——
     * 改之前点一下至少能看到"这源是空的"，改之后只有一个灰按钮，
     * 只能反复点「检测所有来源」，而源确实空、重试无解。
     *
     * 主进程的探测**已经生成了人话原因**，这条断言它真的被渲染出来了。
     */
    inject({
      mirrorTest: [
        {
          base: 'https://dead.example/',
          label: '坏源',
          ms: null,
          status: 'empty',
          reason: '源上没有文件'
        }
      ]
    })
    const w = mount(DownloadPage)
    await flushPromises()
    await flushPromises()

    const row = w.findAll('.source-row').find((r) => r.text().includes('坏源'))!
    const btn = row.findAll('button').find((b) => b.text() === '下载')!
    expect(
      btn.attributes('title') ?? '',
      '锁上的按钮必须带上"为什么不可用"（来自探测的 reason）'
    ).toContain('源上没有文件')

    /* 徽章上也挂一份，用户不点按钮、只看那行也能知道原因 */
    const badge = row.find('.health')
    expect(badge.attributes('title') ?? '', '状态徽章也要带上原因').toContain('源上没有文件')
  })
})
