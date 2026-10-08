/*
 * `ipc.ts` 里每次用 `app` 都必须**先懒取**。
 *
 * ## 为什么要这么一条源码级守卫
 *
 * 实机报错（用户截图）：
 *   Error invoking remote method 'app:checkUpdate':
 *   ReferenceError: app is not defined
 *
 * 根因：这个文件**顶层不 import electron**（单测跑纯 node，顶层 import 会直接炸），
 * 所以文件里所有用到 `app` 的地方都得在函数内部
 *   `const { app } = await import('electron')`
 * 懒取。装配处原来写的是对象字面量里的箭头函数：
 *
 *     appVersion: () => app.getVersion(),
 *     downloadsDir: () => app.getPath('downloads'),
 *
 * `app` 在这个模块作用域里**根本不存在**，闭包解析不到就抛 ReferenceError。
 * 而且 `app:version` 走同一个箭头函数 → 设置里显示「MXBot 未知」。
 * 用户报告的「未知」和「ReferenceError」是同一个根因。
 *
 * ## 为什么不用「调用它看看抛不抛」的测试
 *
 * 试过了，**抓不住**。`buildHandlers()` 收的是**测试注入的** opts，
 * 生产装配那段对象字面量根本不经过它 —— 把生产代码改回错误写法，
 * 单测照样全绿（已经实测确认过一次假绿）。
 *
 * 所以这里直接扫源码：每一个 `app.xxx(` 用法，往上找最近的几行，
 * 必须能看到 `const { app } = ...import('electron')`。
 * 这是唯一能真正按住这类 bug 的办法。
 *
 * 注意：**必须先去注释**。这个文件里好几处注释都在讲 `app.getVersion()`，
 * 不去掉的话会把说明文字当代码，报出一堆假阳性。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/** 去掉 // 行注释与 /* *\/ 块注释，避免注释里的示例被当成真代码 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n')
}

describe('ipc.ts 的 app 用法守卫', () => {
  it('★每个 app.xxx 用法必须来自：懒取声明，或已判空的安全取值', () => {
    const p = join(process.cwd(), 'src', 'main', 'ipc.ts')
    const src = stripComments(readFileSync(p, 'utf8'))
    const lines = src.split(/\r?\n/)

    const offenders: string[] = []
    const re = /\bapp\.(getVersion|getPath|isPackaged|getAppPath|getName|quit|exit|whenReady)\b/

    /*
     * 两种**合法**来源：
     *
     *   A. 函数内直接懒取
     *        const { app } = await import('electron')
     *      这是最初的形态。它有个隐患：纯 node（单测）下动态 import
     *      **不会抛错**，而是成功拿到 electron 包的入口 js（一个只有
     *      `module.exports = <路径字符串>` 的模块），于是解构出来的
     *      `app` 是 **undefined**，下一行 `app.isPackaged` 就抛
     *      `Cannot read properties of undefined (reading 'isPackaged')`。
     *      tests/unit/ipc-handlers.spec.ts 的 config:moveDataRoot 用例
     *      实测抓到了这个（handler 整个打挂）。
     *
     *   B. 走 electronApp() 安全取值 + 判空
     *        const app = await electronApp()
     *        ... app?.isPackaged / app?.getPath ...
     *      electronApp() 返回 `app | undefined`，调用点用 `?.` 或先判空。
     *
     * 注意 B 里 `app?.isPackaged` 也被下面的正则匹配到（`app.` 后面跟
     * `isPackaged`）—— **这是有意的**：`?.` 只是语法糖，仍要确认它来自
     * electronApp()。判空写漏了（写成 `app.isPackaged`）同样会炸。
     */
    /*
     * 找变量来源时，**不按固定行数**，而是往上找到所在函数的开头。
     *
     * 为什么不用固定窗口：第一版写的是「往上 12 行」，我加了 14 行的
     * 判空说明注释之后就失效了 —— 声明被推到窗口外，守卫开始误报
     * `if (app?.getAppPath) return join(app.getAppPath(), 'data')`。
     * 靠"行数"来判断作用域，本来就是在赌注释长度；
     * 而这些注释恰恰是为了讲清安全约束而写的，越写越容易踩。
     *
     * 改成按作用域找：一直往上扫，直到遇见一个看起来是函数起点的行
     * （`function xxx(` / `xxx: async (` / `xxx: (` / `=> {`）。
     * 在到达那个边界**之前**看到合法声明就算通过。
     *
     * 这还是启发式（真正的做法要用 AST），但比固定行数稳得多：
     * 加注释、加日志都不会让它失效，只有真的跨函数引用才会报。
     */
    const isFunctionStart = (l: string): boolean =>
      /^\s*(export\s+)?(async\s+)?function\s+\w+/.test(l) ||
      /^\s*\w+\s*:\s*(async\s*)?\([^)]*\)\s*=>/.test(l) ||
      /^\s*\w+\s*:\s*(async\s*)?function/.test(l) ||
      /^\s*(async\s*)?\([^)]*\)\s*=>\s*\{/.test(l) ||
      /^\s*(export\s+)?const\s+\w+\s*=\s*(async\s*)?\(/.test(l)

    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue

      let ok = false
      for (let j = i; j >= 0; j--) {
        // A：直接懒取
        if (/const\s*\{\s*app\s*\}\s*=\s*await\s+import\(\s*['"]electron['"]\s*\)/.test(lines[j])) {
          ok = true
          break
        }
        // B：通过 electronApp() 安全取值
        if (/const\s+app\s*=\s*await\s+electronApp\(\)/.test(lines[j])) {
          ok = true
          break
        }
        /*
         * 另一种同样安全的写法：把 electronApp() 的结果直接内联判空，
         * 例如 `(await electronApp())?.getPath(...)`。
         */
        if (/await\s+electronApp\(\)\)?\s*\?\./.test(lines[j])) {
          ok = true
          break
        }
        // 到函数边界还没找到 → 说明不是本函数里的合法声明，停止
        if (j < i && isFunctionStart(lines[j])) break
      }
      if (!ok) offenders.push(`行 ${i + 1}: ${lines[i].trim()}`)
    }

    expect(
      offenders,
      '这些地方直接用了 app，但它不在作用域里（顶层不 import electron）——\n' +
        '调用时会抛 ReferenceError: app is not defined；\n' +
        '即使 import 成功，纯 node 下 app 也是 undefined，会抛\n' +
        "Cannot read properties of undefined (reading 'isPackaged')。\n" +
        "改法：用 `const app = await electronApp()` 并配 `app?.xxx`，\n" +
        "或函数内 `const { app } = await import('electron')` 后自行判空。\n" +
        offenders.join('\n')
    ).toEqual([])
  })

  it('electronApp() 自身必须 try/catch 并可能返回 undefined（否则判空无意义）', () => {
    const p = join(process.cwd(), 'src', 'main', 'ipc.ts')
    const src = readFileSync(p, 'utf8')
    const i = src.indexOf('async function electronApp()')
    expect(i, '找不到 electronApp()').toBeGreaterThan(0)
    const body = src.slice(i, i + 900)
    expect(body, 'electronApp 必须容错（纯 node 下 import electron 不抛错但拿不到 app）').toMatch(
      /try\s*\{[\s\S]*catch/
    )
    expect(body, '必须可能返回 undefined，调用点才有判空的必要').toMatch(/return\s+undefined/)
  })
})
