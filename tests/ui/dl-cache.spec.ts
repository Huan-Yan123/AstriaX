/*
 * ★ 下载页 SWR 缓存（主人 0.1.3 的头号痛点）
 *
 * 主人原话：
 *   「每次点进去都需要重新加载…哪些镜像源可用、py 装没装、
 *     文件包安装了哪些 —— 每次都要等全部加载完才能继续点」
 *
 * 这里钉四条契约：
 *   1. 第一次进 → 正常拉取
 *   2. 第二次进（同一次会话）→ **同步**就能看到上次的数据（不必等 IPC）
 *   3. 60s 内重进 → **不再重复探测全部镜像源**（那是"每次都要等"的另一半）
 *   4. 删除版本这种写操作 → 主动失效，重进必须拿到新数据（不许"删了又回来"）
 *
 * 注意：缓存是**模块级**（跨挂载存活是刻意设计），所以每个用例前要自己清
 *（与 download.spec.ts 的 beforeEach 同一套卫生）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DownloadPage from '../../src/renderer/src/DownloadPage.vue'
import { dlInvalidate } from '../../src/renderer/src/dl-cache'

interface Calls {
  mirrorTest: number
  runtimesList: number
  pyStatus: number
  remove: Array<{ type: string; tag: string }>
}

function inject(
  opts: { runtimes?: Array<{ type: 'a' | 'n'; tag: string; sizeMB?: number }> } = {}
): Calls {
  const calls: Calls = { mirrorTest: 0, runtimesList: 0, pyStatus: 0, remove: [] }
  const w = globalThis as unknown as { window: Record<string, unknown> }
  /*
   * ★ 已装列表要**跟着删除变**（第一版这里不真实，测试于是误报）
   *
   * 第一版让 runtimes.list 永远返回同一个列表 —— 于是删除之后
   * 主进程（mock）还是说"这个版本装着"，缓存里自然还有它，
   * 我的断言就红了。那不是产品的错，是 mock 没模拟真实世界。
   * 现在：删过的 tag 从返回里剔除（就像主进程真的删了）。
   */
  let installed: Array<{ type: 'a' | 'n'; tag: string; sizeMB?: number }> =
    /*
     * ★ 用 `a`（AstrBot）作为默认已装版本 —— 主人 2026-10-08 改成
     *   "点左侧资源切换、右侧只显示当前那一类"之后，页面**默认停在 AstrBot**。
     *   原来这里给的是 NapCat（`n`），于是第一次挂载看不到它 ——
     *   不是产品坏了，是 mock 的数据落在另一个标签页里。
     */
    opts.runtimes ?? [{ type: 'a' as const, tag: 'v4.18.19', sizeMB: 28.1 }]
  w.window.launcher = {
    mirrors: {
      state: async () => ({
        mirrors: [
          { label: 'GitHub 直连', base: '', mode: 'proxy', builtin: true },
          { label: 'AstriaX官方源', base: 'http://x/mxbot/files/', mode: 'files', builtin: true, hideBase: true }
        ],
        pref: { a: '', n: '' }
      }),
      test: async () => {
        calls.mirrorTest++
        return [
          { base: '', label: 'GitHub 直连', status: 'ok', ms: 120 },
          { base: 'http://x/mxbot/files/', label: 'AstriaX官方源', status: 'ok', ms: 40 }
        ]
      },
      pref: async (p: unknown) => ({ mirrors: [], pref: p }),
      add: async () => ({ mirrors: [], pref: { a: '', n: '' } }),
      remove: async () => ({ mirrors: [], pref: { a: '', n: '' } })
    },
    runtimes: {
      list: async () => {
        calls.runtimesList++
        return installed
      },
      remove: async (p: { type: string; tag: string }) => {
        calls.remove.push(p)
        // 真的把它从"已装"里去掉（见上面那个注释：mock 必须像真实世界）
        installed = installed.filter((x) => !(x.type === p.type && x.tag === p.tag))
        return { unknownBinding: [] }
      }
    },
    python: {
      status: async () => {
        calls.pyStatus++
        return { ready: true, version: '3.12.10' }
      }
    },
    versions: { list: async () => [] },
    app: { qqStatus: async () => ({ ok: true, installed: true, version: '9.9.35', minBuild: '9.9.0' }) },
    onDownloadProgress: () => () => undefined
  }
  return calls
}

beforeEach(() => {
  vi.restoreAllMocks()
  dlInvalidate() // 清模块级缓存（见文件头说明）
})

describe('★下载页 SWR：进页面立即有内容，后台再刷新', () => {
  it('第二次进入：缓存数据**不用等 IPC** 就能看到', async () => {
    inject()
    // 第一次：正常拉取并写缓存
    const w1 = mount(DownloadPage)
    await flushPromises()
    expect(w1.text()).toContain('v4.18.19')
    w1.unmount()

    /*
     * 第二次：**不 flushPromises**，立刻查 DOM ——
     * 这就是主人要的"点进去立即显示上次内容"。
     * 若没有 SWR，此处是空白（数据还在 IPC 路上）。
     */
    const w2 = mount(DownloadPage)
    expect(
      w2.text(),
      '第二次进入必须立刻显示缓存内容（mount 后同步可见，不能等 IPC）'
    ).toContain('v4.18.19')
    await flushPromises()
  })

  it('★60 秒内重进不重复探测全部镜像源（这是"每次都要等"的另一半）', async () => {
    const calls = inject()
    const w1 = mount(DownloadPage)
    await flushPromises()
    expect(calls.mirrorTest, '首次进入应当探测一次').toBe(1)
    w1.unmount()

    // 紧接着再进：节流生效，不该再打一遍所有源
    const w2 = mount(DownloadPage)
    await flushPromises()
    expect(
      calls.mirrorTest,
      '短时间内重进又打了一遍全部源 —— 这正是用户抱怨的"每次点进去都要等"'
    ).toBe(1)
    w2.unmount()
  })

  it('★删除版本后缓存失效：重进必须拿到新数据（不许"删了又回来"）', async () => {
    const calls = inject()
    const w1 = mount(DownloadPage)
    await flushPromises()
    expect(w1.text()).toContain('v4.18.19')

    // 走真实的删除流程（页面上点「删除」→ 确认）
    const delBtn = w1.findAll('button').find((b) => b.text() === '删除')
    expect(delBtn, '页面上应当有删除按钮').toBeTruthy()
    await delBtn!.trigger('click')
    await flushPromises()
    // 确认框里的按钮（危险色那个）
    const confirm = w1.findAll('button').filter((b) => /删/.test(b.text())).pop()
    await confirm!.trigger('click')
    await flushPromises()
    expect(calls.remove.length, '删除应当真的调用到主进程').toBe(1)

    // 删除后重进：必须重新拉（缓存已失效），而不是先画那个已删掉的版本
    const before = calls.runtimesList
    const w2 = mount(DownloadPage)
    expect(
      w2.text(),
      '删除后重进还画着已被删掉的版本 —— 缓存没失效（用户会看到"删了又回来"）'
    ).not.toContain('v4.18.19')
    await flushPromises()
    expect(calls.runtimesList, '失效后应当重新拉取').toBeGreaterThan(before)
    w2.unmount()
  })

  it('pip（python）状态也进了缓存：重进时先画缓存值，后台再刷新', async () => {
    const calls = inject()
    const w1 = mount(DownloadPage)
    await flushPromises()
    expect(calls.pyStatus).toBe(1)
    w1.unmount()

    /*
     * ## 这条断言我第一版写错了（值得记下来）
     *
     * 原来断言"缓存命中时不该重复问 python 状态"（期望仍是 1 次）。
     * 但那是**与 SWR 的定义相矛盾**的：stale-while-revalidate 的本意就是
     * "先画旧数据，**同时**去拉新数据" —— 后台当然要再问一次，
     * 否则数据永远不更新。测试不能把"不刷新"当成正确。
     *
     * 正确的契约是两层：
     *   ① 立刻能看到（从缓存画，同步可见）
     *   ② 后台确实去刷新了（pyStatus 会增加）
     */
    const w2 = mount(DownloadPage)
    expect(w2.text(), '缓存里的 python 状态应当立刻可见').toContain('Python')
    await flushPromises()
    expect(
      calls.pyStatus,
      '后台必须去刷新（SWR 的另一半：不刷新就永远看不到新数据）'
    ).toBeGreaterThan(1)
    w2.unmount()
  })
})
