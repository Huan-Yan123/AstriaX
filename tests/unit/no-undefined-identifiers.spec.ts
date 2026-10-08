/*
 * ★★ 守卫：「用了但没导入」这一类错误（第二版排查报告的 3 个 Critical）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 为什么这类 bug 特别危险
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 报告抓到 3 处「调用了某个函数、但那个文件没 import 它」：
 *
 *   ① `ipc.ts` 调 `clearPythonSourceFailures` / `markPythonSourceFailed`
 *      —— 而这两个是我自己新加的"坏源自动跳过"机制。
 *      **生产日志实锤**：
 *          导入的 AstrBot v4.28.0 依赖安装失败：clearPythonSourceFailures is not defined
 *      它们被 `installAstrbotDeps` 的 catch 吃掉，降级成一句 WARN ——
 *      用户看不到，主流程不崩，**于是"根治了清华源 403"这个说法从未成立**。
 *
 *   ② `instance-version.ts` 调 `readJsonFile` 但没导入
 *      —— 三层兜底的**第二层永远抛错**，被静默 catch 吃掉，
 *      实际生效的只剩最不可靠的"目录名兜底"。
 *
 *   ③ `ipc.ts:3686` 在 `registerIpcHandlersReal` 里调 `state()`
 *      —— 那是 `buildHandlers` 的局部函数，**这个作用域根本没有它**。
 *      被 catch 吞掉 → 诊断包的 Python 状态永远"未检测"。
 *
 * ## 共同点（为什么测试没抓到）
 *
 * 三处都**被 try/catch 包着**，所以：
 *   · 单测跑不到（那些路径要么没覆盖、要么 catch 让它们静默通过）
 *   · 运行时也不崩（只是功能静默失效）
 *   · 编译也不报（esbuild 只转译不检查类型）
 *
 * **只有类型检查能抓住它们**，而项目原先没有 typecheck 门禁。
 *
 * ## 这条测试做什么
 *
 * 不要求全项目 0 类型错误（存量太多），而是**只钉 TS2304**
 *（Cannot find name）—— 那正是"未定义标识符"这一类，
 * 数量少、语义明确、修起来没有歧义。
 *
 * 这是"在存量债务里加一道**窄而有效**的门禁"：
 * 比"完全不管"强得多，又不像"全量零错误"那样一步到位不现实。
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

describe('★★守卫：不许有「用了但没导入」的标识符（TS2304）', () => {
  it('全项目没有 TS2304（Cannot find name）', () => {
    /*
     * 跑真实的 `vue-tsc --noEmit`。
     *
     * 它慢（十几秒），所以**只在有 vue-tsc 时才跑**；
     * 没有就跳过（不让环境缺失变成测试失败）。
     */
    const bin = join(process.cwd(), 'node_modules', '.bin', 'vue-tsc.cmd')
    const binSh = join(process.cwd(), 'node_modules', '.bin', 'vue-tsc')
    const exe = existsSync(bin) ? bin : existsSync(binSh) ? binSh : undefined
    if (!exe) {
      console.log('  （没有 vue-tsc，跳过）')
      return
    }

    let out = ''
    try {
      out = execFileSync(exe, ['--noEmit'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 300000,
        shell: process.platform === 'win32'
      })
    } catch (e) {
      /* tsc 有错时以非 0 退出 —— 输出在 stdout 里 */
      out = String((e as { stdout?: string }).stdout ?? '') + String((e as { stderr?: string }).stderr ?? '')
    }

    /*
     * ★★ 必须**同时**扫 TS2304 和 TS2552（我漏了后者，真崩了一次）
     *
     * 第一版只查 `TS2304`（Cannot find name）。而 tsc 对
     * "有个名字相似的变量存在"的情况报的是 **`TS2552`**：
     *
     *     src/main/index.ts(869,34): error TS2552: Cannot find name
     *     'readAppConfig'. Did you mean 'appConfig'?
     *
     * 那个文件里正好有 `appConfig`，于是走了 2552 —— **从守卫眼皮底下溜过**。
     * 结果主人点 ✕ 时抛 `ReferenceError`：
     * **窗口关不掉，但软件还活着**（他截图里「按了没反应，反而还能用」）。
     *
     * 教训：这类"用了没导入"的错，**两个错误码是一个整体** ——
     * 只扫其中一个，等于守卫有一半是空的。
     */
    const missing = out
      .split('\n')
      .filter((l) => /TS2304|TS2552/.test(l))
      .map((l) => l.trim())

    expect(
      missing,
      '★有「用了但没导入」的标识符 —— 这类错误会被 try/catch 静默吞掉，\n' +
        '或让功能半死（比如关窗流程中断 → 窗口关不掉但软件还在跑）。\n' +
        '修法就是补 import（或改掉那个不可达的调用）：\n  ' +
        missing.slice(0, 10).join('\n  ')
    ).toEqual([])
  }, 320000)
})
