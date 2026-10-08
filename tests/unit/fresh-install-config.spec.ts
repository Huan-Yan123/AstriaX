/*
 * 首屏配置读取：全新安装（还没写过 config.json）必须能正常进首启向导。
 *
 * 用户报告（三条，实际是**同一个根因的三种表现**）：
 *   1. 「读取配置失败：Cannot read properties of undefined (reading 'dataRoot')」
 *   2. 「镜像源怎么全消失了」
 *   3. 设置里「数据目录（未设置）」
 *
 * 根因链：
 *   全新安装 → data\config.json 不存在 → 主进程 config 一直是 undefined
 *   → config:get 返回 undefined
 *   → 渲染层 `cfg.dataRoot` 抛 TypeError（表现 1）
 *   → mirrors:state 里读 cfg.dataRoot 抛错、列表变空（表现 2）
 *   → 设置页没有 dataRoot 可显示（表现 3）
 *
 * 还有一个**我自己写出来的**二级 bug 让表现 1 必然发生：
 * 并行化首屏时写成了
 *     window.launcher?.config?.get() ?? Promise.resolve({})
 * `??` 作用在 **Promise** 上，而 Promise 永远非 null/undefined，
 * 所以兜底永远不会执行 —— 等于把原来的 `(await ...) ?? {}` 兜底删掉了。
 * 兜底必须作用在 await 之后的值上。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { buildHandlers } from '../../src/main/ipc'
import { createProcessManager } from '../../src/main/proc/process-manager'

const ROOT = join(__dirname, '..', '..')
const APP = readFileSync(join(ROOT, 'src/renderer/src/App.vue'), 'utf8')

const stubProbe = () => Promise.resolve(true)

describe('全新安装（config.json 不存在）不能炸', () => {
  it('config:get 返回对象而不是 undefined（undefined 是所有调用方的地雷）', async () => {
    /*
     * 注意这里**不先调 config:set** —— 复刻全新安装的真实状态：
     * 主进程里 config 还是 undefined。
     */
    const h = buildHandlers({ probe: stubProbe, processManager: createProcessManager() })
    const cfg = await h['config:get']()
    expect(cfg, 'config:get 绝不能返回 undefined').toBeDefined()
    expect(typeof cfg, '应该给一个对象，让调用方安全地读字段').toBe('object')
    expect(cfg).not.toBeNull()
    // 关键：读一个不存在的字段不该抛错（这正是用户遇到的那句报错）
    expect(() => (cfg as { dataRoot?: string }).dataRoot).not.toThrow()
  })

  it('渲染层读 cfg.dataRoot 不会抛（复刻用户的报错行）', async () => {
    const h = buildHandlers({ probe: stubProbe, processManager: createProcessManager() })
    const cfg = (await h['config:get']()) as { dataRoot?: string }
    // 这一行就是原来抛 TypeError 的地方
    let threw: unknown = null
    try {
      void cfg.dataRoot
    } catch (e) {
      threw = e
    }
    expect(threw, 'cfg.dataRoot 不该抛 TypeError').toBeNull()
    // 没配过时是 undefined，界面据此显示首启向导
    expect(cfg.dataRoot).toBeUndefined()
  })

  it('★App.vue 里的 ?? 兜底必须作用在 await 之后的值上', () => {
    /*
     * 先剥掉注释再检查。
     *
     * 必须这样做的原因很实在：修这个 bug 时我在注释里**写了那段错误代码当反例**
     * （「第一版写成 … ?? Promise.resolve({})」），不剥注释的话正则会把注释
     * 当成真实代码，测试就永远红 —— 这正是我第一版测试踩的坑。
     * 反过来，注释里保留反例是有价值的文档，不该因为测试而删掉。
     */
    const code = APP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

    expect(
      /config\?\.get\(\)\s*\?\?\s*Promise\.resolve/.test(code),
      '?? 不能直接作用在 config.get() 这个 Promise 上，兜底不会生效'
    ).toBe(false)

    // 正面：必须有「解包之后再兜底」的动作
    expect(code, '要有一个在 await 之后对结果做兜底的地方').toMatch(/rawCfg\s*\?\?\s*\{\}/)
    // 而且这个兜底要真的被用在 dataRoot 判断之前
    expect(code, '兜底结果要赋值给 cfg 再读 dataRoot').toMatch(
      /const cfg = \(rawCfg \?\? \{\}\)[\s\S]{0,200}cfg\.dataRoot/
    )
  })
})
