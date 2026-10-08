import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { findTask, beginTask, endTask, taskKey, cancelTask } from '../../src/main/update/running-tasks'

const ROOT = join(__dirname, '..', '..')
const ipcSource = readFileSync(join(ROOT, 'src', 'main', 'ipc.ts'), 'utf8')

/**
 * 主人 2026-10-08：
 *   「不只是 python 安装点击取消没反应，是全部东西的安装都不能取消」
 *
 * ## 真正的根因
 *
 * 界面上的「取消」走 `runtimes:cancel`，它按 `<type>:<tag>` 去
 * `running-tasks` 注册表里找任务、触发它的 AbortController。
 *
 * 而**只有两个入口**登记过任务：
 *   · runtime:install
 *   · runtimes:importFile
 *
 * 但发进度事件的路径远不止这两处（Python 安装、模板下载都发）。
 * 没登记 = 注册表里查不到 = cancelTask 返回 ok:false = **界面点了没反应**。
 *
 * ## 为什么这些测试查源码而不是跑行为
 *
 * "某个 handler 有没有登记任务"是**接线**问题：它在运行时表现得像
 * "功能不存在"（按钮是死的），而不是抛一个能被捕获的错。
 * 本项目已有同类守卫（见 tests/unit/no-dead-renderer-code.spec.ts 的说明），
 * 这里沿用同一手法 —— 直接检查每个发进度的安装入口都配了登记。
 */
describe('★ 所有安装任务都必须可取消（登记到 running-tasks）', () => {
  it('Python 安装必须登记任务（否则取消按钮是死的）', () => {
    /*
     * 定位 python:install 这个 handler 的函数体，检查里面出现 beginTask。
     * 用 handler 名做锚点而不是行号 —— 行号会随每次改动漂移。
     */
    const start = ipcSource.indexOf("'python:install'")
    expect(start, '找不到 python:install handler').toBeGreaterThan(0)
    const body = ipcSource.slice(start, start + 6000)
    expect(
      body.includes('beginTask('),
      'python:install 没有登记任务 —— 界面上的取消按钮点了不会有任何反应'
    ).toBe(true)
  })

  it('登记过的任务能被 cancelTask 按 type:tag 找到（取消链路成立）', () => {
    const key = taskKey('a', 'Python 3.12.10')
    const ctrl = new AbortController()
    const t = beginTask({ key, kind: 'install', controller: ctrl, label: 'Python 3.12.10' })
    expect(t).not.toBeNull()
    expect(findTask(key), '登记后必须查得到').toBeDefined()
    expect(cancelTask(key).ok, '查得到就必须能取消').toBe(true)
    expect(ctrl.signal.aborted, '取消要真的 abort 掉信号').toBe(true)
    endTask(key, ctrl)
    expect(findTask(key), '释放后查不到').toBeUndefined()
  })

  it('僵尸进度清理不能误删"仍在跑但没登记"之外的任务', () => {
    /*
     * 上一轮我加的 currentDownloads 过滤用 findTask 判断存活 ——
     * 那个方向是对的（清掉进程已消失的僵尸），但它暴露了
     * "Python 等任务从未登记"这个更早的问题。
     *
     * 这条守卫确保：登记过的任务不会被误清（即过滤条件是 findTask，
     * 而不是别的更激进的条件）。
     */
    const start = ipcSource.indexOf('export function currentDownloads')
    const body = ipcSource.slice(start, start + 600)
    expect(body.includes('findTask('), '快照存活判据必须是 findTask').toBe(true)
  })
})
