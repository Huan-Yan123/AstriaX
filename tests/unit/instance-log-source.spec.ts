import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * NapCat / AstrBot 的运行日志必须能被收集到 —— 而且不能只靠 stdout。
 *
 * 踩过的坑（有实机日志为证）：
 * 我们收到的实例日志只有寥寥几行就断了：
 *   [02:05:01.836][out] Administrator mode detected.
 *   [02:06:19.657][err] ^C
 * 之后再没有任何 NapCat 输出 —— 版本、WebUI Token、二维码、登录结果全都没有。
 *
 * 根因：**NapCat 是注入进 QQ 进程跑的**。
 * 我们的管道只连着 NapCatWinBootMain.exe，而它注入完就没什么输出了；
 * 真正的 NapCat 运行时（napcat.mjs）活在 QQ 进程里，它的 stdout 属于 QQ，
 * 根本不经过我们的管道。所以"读子进程 stdout"这条路对它天然收不全。
 *
 * 正确做法：NapCat 自带 WebUI 日志接口（从 napcat.mjs 的路由表里确认存在）：
 *   GET  /GetLogList        列出日志文件
 *   GET  /GetLog            读某个日志文件
 *   GET  /GetLogRealTime    实时日志（可轮询增量）
 *   POST /CheckLoginStatus  登录状态
 * 用 WebUI Token 鉴权（我们固定注入 114514），端口是实例自己的端口。
 *
 * AstrBot 不同：它是普通 Python 进程，stdout 完整经过我们的管道，
 * 所以它的日志直接收就够（本文件同时确认这条路径没被破坏）。
 */
describe('实例运行日志的收集路径', () => {
  const root = process.cwd()

  it('NapCat 走 WebUI 日志接口，而不是只等 stdout', () => {
    const src = readFileSync(join(root, 'src/main/proc/napcat-log.ts'), 'utf8')
    // 三个接口都要用到
    expect(src).toContain('GetLogList')
    expect(src).toContain('GetLogRealTime')
    // 鉴权要带上 token
    expect(src).toMatch(/token/)
  })

  it('NapCat 日志收集要能处理 GBK——它不是 UTF-8', () => {
    // 实机日志里出现过真实乱码：「锟斤拷止锟斤拷锟斤拷…(Y/N)?」
    // 那是 NapCatWinBootMain.exe 在中文 Windows 上输出 GBK 被当 UTF-8 解的结果。
    // 中文 Windows 的系统代码页是 936，这类输出必须按 GBK 解。
    const src = readFileSync(join(root, 'src/main/proc/napcat-log.ts'), 'utf8')
    expect(src).toMatch(/gbk|936|GBK/i)
  })

  it('AstrBot 是普通子进程，stdout 直接收（这条路径不能被我改坏）', () => {
    const src = readFileSync(join(root, 'src/main/proc/process-manager.ts'), 'utf8')
    // stdout/stderr 都要落盘
    expect(src).toMatch(/child\.stdout\?\.on/)
    expect(src).toMatch(/child\.stderr\?\.on/)
    expect(src).toMatch(/appendFileSync\(spec\.logFile/)
  })

  it('实例日志按 id 分文件，路径固定在 <dataRoot>\\logs\\instances', () => {
    const src = readFileSync(join(root, 'src/main/ipc.ts'), 'utf8')
    expect(src).toContain("'logs'")
    expect(src).toContain("'instances'")
  })
})
