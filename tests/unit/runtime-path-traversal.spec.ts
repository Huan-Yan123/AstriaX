import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { createRuntimeStore } from '../../src/main/update/runtime-store'
import { testStage } from '../helpers/stage'

/*
 * 运行时路径段（tag / type）必须收敛在仓库根目录里。
 *
 * ## 为什么这值得单独一组测试
 *
 * `dirFor(type, tag)` 的实现是 `join(rootDir, SUB[type], tag)`，
 * 而 tag 一路来自**渲染层**（IPC 参数 `runtimes:remove { tag }`、
 * `runtimes:importFile { version }`），中途没有任何校验。于是：
 *
 *     tag = "..\\..\\..\\Windows\\System32"
 *
 * `join` 会老老实实拼出仓库之外的路径。后续动作是
 * **`renameSync`（改名）+ 异步 `rmSync`（递归删除）** ——
 * 也就是说，一个构造过的 tag 能让主进程删掉任意目录。
 *
 * 而这个进程是**管理员权限**的（NapCat 注入 QQ 需要提权，
 * 见 src/main/ipc.ts 里 restartElevated 的说明），
 * 所以后果比普通进程严重一档。
 *
 * ## 和 assertInsideInstances 的关系
 *
 * ipc.ts 里已经有一个 `assertInsideInstances()` 专门给
 * 「渲染层传路径」的备份相关操作把关（三道检查：目录边界、
 * 后缀白名单、必须是文件）。但运行时这两个入口传的是**版本号**
 * 而不是路径，当时没走那道闸，是遗漏而不是有意设计。
 *
 * 这里要求的是同一类保护，只是按「路径段」而非「路径」来做：
 * tag 是**单个目录名**，不该含分隔符、盘符、`..`。
 */

let root: string

beforeEach(() => {
  root = testStage('mx-rt-traversal-')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造一个仓库外的"受害者"目录，用来验证没被删 */
function makeVictim(): string {
  const v = join(root, '..', `victim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`)
  mkdirSync(join(v, 'inner'), { recursive: true })
  writeFileSync(join(v, 'inner', 'precious.txt'), 'MUST-NOT-BE-DELETED', 'utf8')
  return v
}

describe('运行时仓库：路径段必须收敛在仓库内', () => {
  it('remove：tag 带 .. 时抛错，且绝不删仓库外的目录', () => {
    const st = createRuntimeStore({ dataRoot: root })
    const victim = makeVictim()
    try {
      // 目标：让 join(root, 'a', tag) 解析到 victim
      const rel = join('..', '..', victim.split(/[\\/]/).pop() as string)
      expect(() => st.remove('a', rel)).toThrow()
      // 关键断言：受害者目录还在
      expect(existsSync(join(victim, 'inner', 'precious.txt'))).toBe(true)
    } finally {
      rmSync(victim, { recursive: true, force: true })
    }
  })

  it('remove：tag 是绝对路径时抛错', () => {
    const st = createRuntimeStore({ dataRoot: root })
    expect(() => st.remove('a', 'C:\\Windows')).toThrow()
    expect(() => st.remove('a', resolve(root, '..', 'nothing-here'))).toThrow()
  })

  it('remove：tag 含分隔符时抛错', () => {
    const st = createRuntimeStore({ dataRoot: root })
    expect(() => st.remove('a', 'v1/../v2')).toThrow()
    expect(() => st.remove('a', 'v1\\v2')).toThrow()
  })

  it('remove：空 tag / 纯点号抛错', () => {
    const st = createRuntimeStore({ dataRoot: root })
    expect(() => st.remove('a', '')).toThrow()
    expect(() => st.remove('a', '.')).toThrow()
    expect(() => st.remove('a', '..')).toThrow()
    expect(() => st.remove('a', '   ')).toThrow()
  })

  it('register：tag 带 .. 时抛错，且不在仓库外建目录', () => {
    const st = createRuntimeStore({ dataRoot: root })
    const outsideName = `escaped-${Date.now().toString(36)}`
    const rel = join('..', '..', outsideName)
    expect(() => st.register({ type: 'a', tag: rel })).toThrow()
    // 确认没有在外面建出目录
    expect(existsSync(join(root, '..', '..', outsideName))).toBe(false)
    rmSync(join(root, '..', '..', outsideName), { recursive: true, force: true })
  })

  it('register：绝对路径 tag 抛错', () => {
    const st = createRuntimeStore({ dataRoot: root })
    expect(() => st.register({ type: 'a', tag: resolve(root, '..', 'abs-escape') })).toThrow()
    rmSync(join(root, '..', 'abs-escape'), { recursive: true, force: true })
  })

  it('dirFor：正常 tag 仍然正常工作（不能把功能一起挡掉）', () => {
    const st = createRuntimeStore({ dataRoot: root })
    const d = st.dirFor('n', 'v4.18.19')
    expect(resolve(d)).toBe(resolve(join(root, 'runtimes', 'n', 'v4.18.19')))
  })

  it('dirFor：非法 tag 抛错（这是所有入口的共同收口点）', () => {
    const st = createRuntimeStore({ dataRoot: root })
    expect(() => st.dirFor('a', '..\\..\\x')).toThrow()
  })

  it('isInstalled：非法 tag 不抛错但返回 false（查询类不该炸）', () => {
    const st = createRuntimeStore({ dataRoot: root })
    // 查询接口给渲染层轮询用，抛错会让整个界面白屏；
    // 安全的做法是"不认识的 tag 就是没装"
    expect(st.isInstalled('a', '..\\..\\x')).toBe(false)
  })

  it('允许的 tag 形式：带字母数字点横线下划线加号都通得过', () => {
    const st = createRuntimeStore({ dataRoot: root })
    for (const tag of ['v4.28.0', 'v4.18.19', 'v1.0.0-beta.1', 'v4.27.0_rc1', 'v1.0.0+build5']) {
      expect(() => st.dirFor('a', tag)).not.toThrow()
    }
  })

  it('type 非法时也挡（不能只防 tag 不防 type）', () => {
    const st = createRuntimeStore({ dataRoot: root })
    // @ts-expect-error 故意传非法 type
    expect(() => st.dirFor('..', 'v1.0.0')).toThrow()
    // @ts-expect-error 故意传非法 type
    expect(() => st.remove('..', 'v1.0.0')).toThrow()
  })

  it('合法版本照常可删（确保保护没有误伤正常流程）', () => {
    const st = createRuntimeStore({ dataRoot: root })
    st.register({ type: 'a', tag: 'v9.9.9' })
    expect(existsSync(st.dirFor('a', 'v9.9.9'))).toBe(true)
    st.remove('a', 'v9.9.9')
    // 改名成功，列表里应该没有它了
    expect(st.list('a').find((v) => v.tag === 'v9.9.9')).toBeUndefined()
  })

  it('仓库根目录下的 a / n 不被误伤', () => {
    const st = createRuntimeStore({ dataRoot: root })
    mkdirSync(join(root, 'a'), { recursive: true })
    mkdirSync(join(root, 'n'), { recursive: true })
    expect(() => st.remove('a', 'nonexistent-version')).toThrow(/没有安装/)
    // 上面抛的是"没有这个版本"而不是"路径非法"，说明空目录没被碰
    expect(existsSync(join(root, 'a'))).toBe(true)
    expect(existsSync(join(root, 'n'))).toBe(true)
  })
})
