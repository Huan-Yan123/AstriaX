/*
 * ★ 手动安装 pip 库（主人 2026-10-08）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个功能
 * ══════════════════════════════════════════════════════════════════════════
 *
 * AstrBot 的插件常要额外 Python 库。而我们的 AstrBot 是
 * `pip install --target` 装出来的 **CLI 形态** —— 从它自己的 WebUI 里
 * 点「安装插件依赖」是装不进去的：
 *
 *   · 它拿不到我们那套环境变量（PYTHONHOME / MXBOT_SITE）
 *   · 它的 sys.path 里也没有运行时目录（embed 版靠 sitecustomize 插的，
 *     而那个只在**我们启动**的解释器里生效）
 *
 * 用户只能自己开命令行敲 pip —— 但他不知道要用哪个 python.exe、
 * 参数该带什么。这个功能就是把那件事做成一个输入框。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 装到哪（主人明确要求：不改架构，按现有实现来加）
 * ══════════════════════════════════════════════════════════════════════════
 *
 *     runtimes\a\<tag>\      ← 与 AstrBot 自己的依赖同一层
 *
 * 好处是不需要新增任何路径注入：sitecustomize / MXBOT_SITE / PYTHONPATH
 * 那套机制原样生效，该版本的**所有实例**立刻都能 import 到。
 *
 * （我一度想做"实例专属包目录"，那要动启动链路 —— 属于架构改动，
 *   主人明确否决了。）
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const IPC = readFileSync(join(process.cwd(), 'src', 'main', 'ipc.ts'), 'utf8')
const PRELOAD = readFileSync(join(process.cwd(), 'src', 'preload', 'api-map.ts'), 'utf8')
const PAGE = readFileSync(
  join(process.cwd(), 'src', 'renderer', 'src', 'DownloadPage.vue'),
  'utf8'
)

/** 取出 installPipPackage 函数体（按锚点切，到下一个顶层函数为止） */
function pipInstallerBody(): string {
  const start = IPC.indexOf('async function installPipPackage')
  expect(start, '找不到 installPipPackage').toBeGreaterThan(-1)
  return IPC.slice(start, start + 5000)
}

describe('★ 安装 pip 库', () => {
  it('主进程有 installPipPackage，且用 --target 装进运行时目录', () => {
    const body = pipInstallerBody()
    expect(body.includes("'--target'"), '必须用 --target 装进指定目录（而不是装到内置 Python 里）').toBe(true)
    expect(
      body.includes('deps.runtimeDir'),
      '目标是调用方给的运行时目录 —— 这决定了"装到哪个版本"'
    ).toBe(true)
    /*
     * `--upgrade` 让重复安装能覆盖已有版本。
     * 没有它的话 pip 会说"已满足要求"直接跳过 ——
     * 用户想升版本时会以为按钮坏了。
     */
    expect(body.includes("'--upgrade'"), '要有 --upgrade，否则重复装不生效').toBe(true)
  })

  it('★ 包名要做校验（不能把用户输入直接当参数）', () => {
    const body = pipInstallerBody()
    /*
     * spawn 不走 shell，所以没有命令注入面；但**参数注入**是有的：
     * 用户输入 `--target C:\Windows` 会被 pip 当成选项。
     */
    expect(
      /if \(\/\^-?\/\.test\(spec\)\)|不能以「-」开头/.test(body),
      '必须拒绝以「-」开头的输入（那是 pip 的选项，不是包名）'
    ).toBe(true)
    expect(
      /A-Za-z0-9.*\._-\]/.test(body) || body.includes('包名格式不对'),
      '必须校验包名格式（只允许 PEP 508 的合法形态）'
    ).toBe(true)
  })

  it('★★ 装库任务要登记，否则「取消」是死的', () => {
    const start = IPC.indexOf("'runtime:installPip': async")
    expect(start, '找不到 runtime:installPip handler').toBeGreaterThan(-1)
    const body = IPC.slice(start, start + 4000)

    /*
     * 这条是"全部安装都不能取消"那个老 bug 的同类 ——
     * 不 beginTask 的话，界面的取消按钮走 runtimes:cancel 查注册表，
     * 查不到 → 返回 ok:false → 什么都不做。
     */
    expect(body.includes('beginTask('), 'installPip 必须登记任务').toBe(true)
    expect(body.includes('endTask('), '必须释放任务（漏了会永久占位）').toBe(true)
    /*
     * ★ 断言 endTask 在 finally 里 —— 不能只看"两行都在"。
     *
     * 我第一版写的是个跨 80 字符的正则，太紧，撞到了假红。
     * 直接按"finally 块内部"判断更准：取出 finally 之后的内容，
     * 看 endTask 是否在其中。
     */
    const fin = body.indexOf('} finally {')
    expect(fin, '必须有 finally 块 —— 失败/取消也要释放任务').toBeGreaterThan(-1)
    expect(
      body.slice(fin).includes('endTask('),
      'endTask 必须在 finally 里 —— 否则失败或取消时任务不释放，\n' +
        '那个键会永远占着，用户再也装不了同一个版本（只能重启软件）'
    ).toBe(true)
  })

  it('★ 失败/取消要发 error 进度事件（否则进度条永远亮着）', () => {
    const start = IPC.indexOf("'runtime:installPip': async")
    const body = IPC.slice(start, start + 4000)
    expect(
      body.includes("phase: 'error'"),
      '渲染层的进度条只认 done/error 才收尾；不发 error 的话那条会永远显示「正在装」'
    ).toBe(true)
  })

  it('★ 只允许装到 AstrBot 版本（NapCat 没有 pip 概念）', () => {
    const start = IPC.indexOf("'runtime:installPip': async")
    const body = IPC.slice(start, start + 4000)
    expect(
      body.includes("dirFor('a'") || body.includes('dirFor("a"'),
      '目标必须写死 AstrBot（a）—— NapCat 是 Node 写的，装 pip 库没有意义'
    ).toBe(true)
    /* 版本不存在时要明确报错，而不是在空目录上装 */
    expect(body.includes('还没装到本机'), '版本没装时要给出清楚的报错').toBe(true)
  })

  it('★ 内置 Python 没装时也要拦（pip 的执行者就是它）', () => {
    const start = IPC.indexOf("'runtime:installPip': async")
    const body = IPC.slice(start, start + 4000)
    expect(
      body.includes('还没内置 Python'),
      '没装 Python 就没法执行 pip，要提前拦住并告诉用户去哪装'
    ).toBe(true)
  })

  it('★ preload 暴露了 installPip（否则渲染层调不到）', () => {
    expect(
      PRELOAD.includes("ipcRenderer.invoke('runtime:installPip'"),
      'api-map 里要把 installPip 桥到 runtime:installPip'
    ).toBe(true)
  })

  it('★ 渲染层：能选版本 + 填库名 + 安装', () => {
    /* 三个必要的状态与动作 */
    expect(PAGE.includes('pipTargets'), '要有"已装 AstrBot 版本"的列表（让用户选装到哪个）').toBe(true)
    expect(PAGE.includes('pipSpec'), '要有库名输入').toBe(true)
    expect(PAGE.includes('installPip'), '要有安装动作').toBe(true)
    expect(PAGE.includes('runtimes?.installPip'), '要真的调用主进程那个接口').toBe(true)

    /*
     * 模板里必须有表单元素 —— 只有 script 里的变量、没人渲染，
     * 就是"死代码"（这个项目有 no-dead-renderer-code 守卫抓过同类问题）。
     */
    expect(/v-model="pipTag"/.test(PAGE), '版本下拉要绑 pipTag').toBe(true)
    expect(/v-model="pipSpec"/.test(PAGE), '库名输入要绑 pipSpec').toBe(true)
    expect(/@click="installPip"/.test(PAGE), '安装按钮要绑 installPip').toBe(true)
  })

  it('★ 版本被删掉时选择要跟着校正（不能停在一个不存在的版本上）', () => {
    const start = PAGE.indexOf('watch(pipTargets')
    expect(start, '找不到对 pipTargets 的 watch').toBeGreaterThan(-1)
    const body = PAGE.slice(start, start + 400)
    expect(
      /pipTag\.value\s*=\s*list\[0\]/.test(body),
      '当前选的版本不在列表里时，要回落到第一个 —— 否则装库会打到不存在的目录'
    ).toBe(true)
  })

  it('★ 一个 AstrBot 都没装时不显示这块（避免点不动的空表单）', () => {
    expect(
      /v-if="pipTargets\.length"/.test(PAGE),
      'pip 区块要有 v-if 守卫 —— 没装 AstrBot 时用户根本没法用，显示出来只会困惑'
    ).toBe(true)
  })
})
