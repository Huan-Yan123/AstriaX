/*
 * 源码级守卫：ipc.ts 里用了的 fs 函数必须真的被导入，且"promise 风格"的用法
 * 必须来自正确的模块（'fs/promises'，不是回调式的 'fs'）。
 * ========================================================================
 *
 * ## 这个 bug 是怎么被发现的
 *
 * 写 detached-process-kill 用例（走"实例在运行中直接被删"那条路径）时，
 * `instance:remove` 抛了：
 *
 *     ReferenceError: unlink is not defined
 *
 * 查下去发现那行代码有两个错叠在一起：
 *
 *     void unlink(logFile).catch(() => undefined)
 *
 *   1. `unlink` **压根没被导入**
 *   2. 就算导入了，`fs.unlink` 是**回调式**的，没有 `.catch()` ——
 *      补上导入之后立刻变成
 *      `The "cb" argument must be of type function. Received undefined`
 *
 * ## 为什么值得为它写一条源码守卫
 *
 * 因为它极其隐蔽：
 *
 *   - 长得像一句平平无奇的清理语句，眼睛扫过去完全正常
 *   - TypeScript **不报错**（`unlink` 在 `@types/node` 里是全局声明的同名符号？不是 ——
 *     实际上是因为项目 tsconfig 的严格度不足，`noEmit` 检查本来就有历史错误，
 *     没人会因为它多了几条而察觉）
 *   - 位置很关键：`instance:remove` 走到这行时**记录已经从 instances.json 摘掉了**，
 *     所以用户看到"实例消失了 + 一个看不懂的报错"，而日志里连痕迹都没有
 *     （后面的 logger.log 不执行）
 *
 * 也就是说：功能"看起来成功了"，但每次都留一个删不掉的日志文件 + 弹一个
 * 莫名其妙的错误。这种"半成功"最难被用户准确描述，最容易长期潜伏。
 *
 * ## 守卫怎么查
 *
 * 1. 扫 ipc.ts 里所有 `\bunlink\(`、`\bcopyFile\(`、`\bwriteFile\(` … 这类
 *    **来自 fs 的具名调用**
 * 2. 对每个用到的名字，确认它在文件的 import 里出现过
 * 3. 额外查"promise 风格"误用：对**回调式**的 fs API 用了 `.then(`/`.catch(`
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/** 去掉注释，避免注释里的示例被当成真代码 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n')
}

const IPC = join(process.cwd(), 'src', 'main', 'ipc.ts')

/** 回调式（非 promise）的 fs API —— 它们不支持 .then/.catch */
const CALLBACK_STYLE = [
  'unlink',
  'readFile',
  'writeFile',
  'appendFile',
  'mkdir',
  'rmdir',
  'stat',
  'readdir',
  'copyFile',
  'rename',
  'access',
  'chmod',
  'utimes'
]

describe('ipc.ts 的 fs 用法守卫（unlink 那类错误不该再出现）', () => {
  it('★用到的每个 fs 具名函数都必须真的被导入', () => {
    const raw = readFileSync(IPC, 'utf8')
    const code = stripComments(raw)

    // 收集所有 import 里出现过的标识符（含 fs / fs/promises / node:fs 等）
    const imported = new Set<string>()
    const importRe = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"][^'"]+['"]/g
    let im: RegExpExecArray | null
    while ((im = importRe.exec(code))) {
      for (const part of im[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0]?.trim()
        if (name) imported.add(name)
      }
    }

    /*
     * 逐个检查那些**容易忘记导入**的名字。
     * 只看调用形态 `name(`，并且排除 import 行本身。
     */
    const offenders: string[] = []
    const lines = code.split('\n')
    for (const fn of CALLBACK_STYLE) {
      const useRe = new RegExp(`(?<![\\w.])${fn}\\s*\\(`)
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]
        if (/^\s*import\b/.test(l)) continue
        if (!useRe.test(l)) continue
        if (!imported.has(fn)) {
          offenders.push(`行 ${i + 1}: 用了 ${fn}(...) 但没导入 —— ${l.trim()}`)
        }
      }
    }

    expect(
      offenders,
      '这些 fs 函数被使用但没导入，运行到那行会抛 ReferenceError：\n' +
        offenders.join('\n') +
        '\n（unlink 那一处实机踩过：instance:remove 每次都炸，' +
        '但实例记录已经摘掉了，所以表现为"删掉了但弹个看不懂的错"）'
    ).toEqual([])
  })

  it('★回调式的 fs API 不能当 promise 用（.then/.catch 会抛参数类型错）', () => {
    const raw = readFileSync(IPC, 'utf8')
    const code = stripComments(raw)

    /*
     * 先把从 'fs' 导入的回调式名字挑出来。
     * 从 'fs/promises' 导入的同名函数是**合法**的 promise 版本，
     * 所以必须先分清来源，否则会误报。
     */
    const callbackImported = new Set<string>()
    const promiseImported = new Set<string>()
    const importRe = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g
    let im: RegExpExecArray | null
    while ((im = importRe.exec(code))) {
      const isPromise = /fs\/promises|node:fs\/promises/.test(im[2])
      for (const part of im[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0]?.trim()
        if (!name) continue
        if (isPromise) promiseImported.add(name)
        else if (/^node:fs$|^fs$/.test(im[2])) callbackImported.add(name)
      }
    }

    const offenders: string[] = []
    const lines = code.split('\n')
    for (const fn of callbackImported) {
      if (promiseImported.has(fn)) continue // 同名但 promise 版可用？
      const badRe = new RegExp(`(?<![\\w.])${fn}\\s*\\([^)]*\\)\\s*\\.\\s*(then|catch|finally)\\b`)
      for (let i = 0; i < lines.length; i++) {
        if (badRe.test(lines[i]) && !/^\s*import\b/.test(lines[i])) {
          offenders.push(`行 ${i + 1}: ${fn}(...) 是回调式的，不能 .then/.catch —— ${lines[i].trim()}`)
        }
      }
    }

    expect(
      offenders,
      '这些地方把回调式 fs API 当 promise 用了，运行时报\n' +
        '`The "cb" argument must be of type function`：\n' +
        offenders.join('\n') +
        "\n改法：从 'fs/promises' 导入 promise 版本。"
    ).toEqual([])
  })
})
