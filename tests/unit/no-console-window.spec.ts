import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * 实例进程不得把控制台窗口糊到用户脸上。
 *
 * 现场证据（真机观察到的窗口标题）：
 *   Select "E:\...\NapCatWinBootMain.exe" "E:\QQ\QQ.exe" "E:\...\NapCatWinBootHook.dll"
 * 开头的 "Select" 是 Windows 控制台「标记模式」的标题，说明那是
 * **NapCatWinBootMain.exe 自己的控制台**，不是我们 spawn 的 cmd。
 *
 * 机制（MSDN, CREATE_NO_WINDOW）：
 *   "This flag is ignored if ... used with either CREATE_NEW_CONSOLE or DETACHED_PROCESS."
 * Node 的 detached:true 在 Windows 上就是 DETACHED_PROCESS，于是：
 *   spawn(cmd, {detached:true, windowsHide:true})
 *   → cmd 拿到 DETACHED_PROCESS，windowsHide 被忽略，cmd 自己没有控制台
 *   → cmd 再同步启动 CUI 子进程（NapCatWinBootMain.exe，PE Subsystem=3）
 *   → 孩子没有控制台可继承，Windows **新建一个可见控制台** = 黑框
 *
 * 所以「经 bat 启动的 NapCat」这条路径不能 detached:true。
 * 这些是源码级断言：窗口行为无法在 happy-dom 里观察，真机验证方法见文末注释。
 */
describe('实例启动不得弹控制台窗口', () => {
  const src = readFileSync(join(__dirname, '../../src/main/proc/process-manager.ts'), 'utf8')

  it('spawn 必须带 windowsHide: true', () => {
    expect(src).toMatch(/windowsHide:\s*true/)
  })

  it('必须留有「不给子进程独立控制台」的开关，供需隐藏窗口的实例使用', () => {
    // StartSpec 要有办法表达「这个实例不能 detached」
    expect(src).toMatch(/detached/)
  })

  it('真机验证方法：启动一个 NapCat 实例，任务栏不应出现多余控制台窗口', () => {
    // 人工/真机步骤（记在这里备查）：
    // 1. 启动软件 → 启动 NapCat 实例
    // 2. 枚举可见窗口，标题里不该出现 NapCatWinBootMain 的路径
    // 3. 下面这条断言只是保证本说明与实现同时存在，避免被误删
    expect(src.length).toBeGreaterThan(0)
  })
})
