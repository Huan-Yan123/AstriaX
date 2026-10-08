/*
 * Bug G：instance.json 必须**原子写**，否则会误删别的运行时
 * ========================================================================
 *
 * ## 坏在哪
 *
 * `writeInstanceMeta()` 原来是直接 `writeFileSync(dir/instance.json, ...)`：
 *
 *     writeFileSync(join(dir, 'instance.json'), JSON.stringify({...}), 'utf8')
 *
 * 非原子。写到一半掉电/崩溃/被杀 → 文件**截断**，只剩半个 JSON。
 *
 * 而读的那一头（`readInstanceTag`）对损坏是**静默降级**的：
 *
 *     try { return readJsonFile(f).runtimeTag } catch { return undefined }
 *
 * 于是"读不到 runtimeTag" 和 "从没写过 runtimeTag" 变得无法区分。
 *
 * ## 致命在哪 —— 连锁到"删错运行时"
 *
 * `runtimes:remove` 判断"哪些实例在用这个版本"时是这样写的：
 *
 *     (readInstanceTag(inst.dir) ?? store.latest(inst.type)?.tag) === p.tag
 *
 * 读不到就**退回 `latest`**（该类型最新的那个版本）。
 * 于是：
 *
 *   1. 实例 A 绑的是 v4.27.0，它的 instance.json 被写坏
 *   2. 用户去删 v4.28.0（latest）
 *   3. 守卫算出来 `undefined ?? 'v4.28.0'` = 'v4.28.0' → 认为 A 在用 v4.28.0
 *   4. **A 明明没在跑**（所以不会被拦），于是 v4.28.0 被删掉
 *
 * 反过来更糟：用户想删 v4.27.0（A 真正在用的），守卫算出 A 用的是 v4.28.0
 * → 认为"没有实例在用 v4.27.0" → 如果 A 正在跑，**正在执行的代码被抽走**。
 *
 * 退到 `latest` 这个兜底本意是"保守一点，宁可多留"，实际效果却是
 * 把引用**算到另一个版本头上** —— 既可能误留，也可能误删。
 *
 * ## 修法
 *
 * 原子写：先写临时文件，再 `renameSync` 覆盖。
 * rename 在同一卷上是原子的（Windows 的 MoveFileEx 语义），
 * 所以读到的永远是"完整的旧文件"或"完整的新文件"，不存在半个。
 *
 * 这和 instance-repo.ts 的 writeAll 是同一个套路（那边早就这么干了）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildHandlers } from '../../src/main/ipc'
import { testStage } from '../helpers/stage'
import { freePortIn } from '../helpers/port'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'

let root: string

beforeEach(() => {
  root = testStage('acb-atomic-meta-')
  mkdirSync(join(root, 'logs'), { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function mk() {
  const h = buildHandlers({ probe: () => true, audit: undefined })
  h['config:set']({ dataRoot: root })
  /*
   * AstrBot 实例要求内置 Python 就绪（isPythonReady 只看
   * <dataRoot>\runtime\python\python.exe 在不在）。
   * 注意是 **runtime\python**（单数），不是 runtimes\ —— 这两个目录名
   * 长得像但完全不同：runtimes\ 放"版本化的运行时包"，runtime\ 放内置 Python。
   */
  mkdirSync(join(root, 'runtime', 'python'), { recursive: true })
  writeFileSync(join(root, 'runtime', 'python', 'python.exe'), '', 'utf8')
  // 预置运行时，否则 instance:create 拒绝建空壳
  for (const tag of ['v4.27.0', 'v4.28.0']) {
    mkdirSync(join(root, 'runtimes', 'a', tag), { recursive: true })
    writeFileSync(join(root, 'runtimes', 'a', tag, 'mxbot-runtime.json'), '{"kind":"pypi"}', 'utf8')
    // astrbot 包本体：放进"已安装"的实质，不会被当空壳过滤掉
    mkdirSync(join(root, 'runtimes', 'a', tag, 'astrbot'), { recursive: true })
    writeFileSync(join(root, 'runtimes', 'a', tag, 'astrbot', '__init__.py'), '', 'utf8')
  }
  writeFileSync(
    join(root, 'runtimes.json'),
    JSON.stringify({
      versions: [
        { type: 'a', tag: 'v4.27.0', installedAt: new Date().toISOString() },
        { type: 'a', tag: 'v4.28.0', installedAt: new Date().toISOString() }
      ]
    }),
    'utf8'
  )
  return h
}

describe('Bug G：instance.json 原子写', () => {
  /*
   * ## 一条自我批评：这三条测试第一版全是"假绿"
   *
   * 我最初写的三条断言是：
   *   - instance.json 能 JSON.parse
   *   - 没有 .tmp 残留
   *   - runtimes:remove 返回数组
   *
   * 问题：**它们在修复之前就已经全绿**。因为非原子写在"没被打断"的
   * 情况下当然也写出完整的 JSON，也不会有 tmp 残留（根本没建 tmp）。
   *
   * 这等于什么也没测 —— 一条"改前改后都通过"的测试不是回归测试，
   * 它只是装饰。本项目已经反复踩过这个坑（"同一个测试在改前改后都绿
   * 就是假绿"），所以这里必须重写成**改前会红**的形状。
   *
   * ## 真正能区分原子/非原子的判据
   *
   * 行为层面很难直接观测"写了一半"（要靠掉电或注入失败）。
   * 所以用**结构判据**：断言这个函数**必须**走"临时文件 + rename"这条路。
   *
   * 这不是"测实现细节" —— 在这个场景里，**"用 tmp+rename"就是
   * 原子性的定义本身**。`writeFileSync(目标)` 这种写法无论怎么调参数
   * 都不可能原子，所以判据只能是"有没有换名"。
   * （instance-repo.ts 的 writeAll 早就是这个套路，两边保持一致。）
   */
  it('★writeInstanceMeta 必须走「临时文件 + rename」（原子性的定义）', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'main', 'ipc.ts'), 'utf8')
    const i = src.indexOf('function writeInstanceMeta(')
    expect(i, '找不到 writeInstanceMeta').toBeGreaterThan(0)
    // 取函数体（到下一个顶层 function 为止）
    const rest = src.slice(i)
    const nextFn = rest.indexOf('\nfunction ', 10)
    const body = nextFn > 0 ? rest.slice(0, nextFn) : rest.slice(0, 1500)

    expect(
      /renameSync\s*\(/.test(body),
      'writeInstanceMeta 没有用 renameSync —— 那就是**非原子写**：\n' +
        '写到一半掉电/被杀会留下截断的 instance.json，\n' +
        '而 readInstanceTag 读不了就返回 undefined，\n' +
        '删除守卫的 `?? store.latest(type)?.tag` 会把这个实例的引用\n' +
        '算到**别的版本**头上 → 可能删掉它正在用的运行时。'
    ).toBe(true)

    // 必须真的写到一个**不同的**临时路径再换名
    expect(
      /\.tmp|tmpPath|\.\$\{|randomBytes/.test(body),
      'writeInstanceMeta 用了 renameSync，但看不出写了临时文件 —— 请确认是「先写 tmp，再 rename」'
    ).toBe(true)

    // 不允许出现"直接往目标文件写"的形态
    expect(
      /writeFileSync\s*\(\s*join\(dir,\s*'instance\.json'\)/.test(body),
      'writeInstanceMeta 仍然直接 writeFileSync 到 instance.json —— 非原子，会留下截断文件'
    ).toBe(false)
  })

  it('写出的 instance.json 内容完整、无 .tmp 残留', async () => {
    const h = mk()
    const rec = (await h['instance:create']({ type: 'a', name: '原子户', port: await freePortIn(6100, 6199) })) as {
      id: string
      dir: string
    }
    const f = join(rec.dir, 'instance.json')
    expect(() => JSON.parse(readFileSync(f, 'utf8'))).not.toThrow()
    const leftovers = readdirSync(rec.dir).filter((n) => n.includes('.tmp'))
    expect(leftovers, `留下了临时文件：${leftovers.join('、')}`).toEqual([])
  })

  it('换版本后 instance.json 反映新版本，且始终可解析', async () => {
    const h = mk()
    const rec = (await h['instance:create']({ type: 'a', name: '原子户2', port: await freePortIn(6100, 6199) })) as {
      id: string
      dir: string
    }
    const f = join(rec.dir, 'instance.json')
    const before = readFileSync(f, 'utf8')

    await h['instance:setRuntime']({ id: rec.id, tag: 'v4.27.0', type: 'a' })
    const after = readFileSync(f, 'utf8')

    expect(() => JSON.parse(before)).not.toThrow()
    expect(() => JSON.parse(after)).not.toThrow()
    expect((JSON.parse(after) as { runtimeTag?: string }).runtimeTag).toBe('v4.27.0')
    // 换名之后不该留 tmp
    expect(readdirSync(rec.dir).filter((n) => n.includes('.tmp'))).toEqual([])
  })

  it('损坏的 instance.json 不再被错算成 latest（会被报进 unknownBinding）', async () => {
    const h = mk()
    const rec = (await h['instance:create']({ type: 'a', name: '受害户', port: await freePortIn(6100, 6199) })) as {
      id: string
      dir: string
    }
    await h['instance:setRuntime']({ id: rec.id, tag: 'v4.27.0', type: 'a' })

    // 手工造一个截断的 instance.json（模拟老版本非原子写留下的）
    writeFileSync(join(rec.dir, 'instance.json'), '{"id":"a_x","runtimeTag":"v4.2', 'utf8')

    /*
     * 删 v4.28.0（latest，**不是**它真正在用的 v4.27.0）。
     *
     * 旧行为：`readInstanceTag(...) ?? latest` 会算出 'v4.28.0'，
     * 于是这个实例被当成"在用 v4.28.0" → 出现在 usedBy 里
     * （看似无害，但它同时意味着删 v4.27.0 时它**不会**出现 →
     *   正在跑的话会被当成没人用而删掉代码）。
     *
     * 新行为：文件存在但读不出来 → 不猜，报进 unknownBinding，
     * 由界面提示用户去修记录。
     */
    const r = (await h['runtimes:remove']({ type: 'a', tag: 'v4.28.0' })) as {
      usedBy: string[]
      unknownBinding?: string[]
    }
    expect(Array.isArray(r.usedBy)).toBe(true)
    expect(
      r.unknownBinding,
      '版本记录损坏的实例必须被单独报出来 —— 否则它会在下次启动时莫名失败'
    ).toContain('受害户')
    expect(
      r.usedBy,
      '不能被当成"确定在用 latest" —— 那是猜的，猜错会删掉活人的代码'
    ).not.toContain('受害户')
  })

  it('instance.json **不存在**时仍退回 latest（很老的实例，这是合理近似）', async () => {
    const h = mk()
    const rec = (await h['instance:create']({ type: 'a', name: '老实例', port: await freePortIn(6100, 6199) })) as {
      id: string
      dir: string
    }
    // 删掉记录文件，模拟"从来没有 runtimeTag"的老实例
    rmSync(join(rec.dir, 'instance.json'), { force: true })

    const r = (await h['runtimes:remove']({ type: 'a', tag: 'v4.28.0' })) as {
      usedBy: string[]
      unknownBinding?: string[]
    }
    /*
     * 没有任何版本信息的老实例：退回 latest 是合理的
     * （老版本建实例时绑的就是当时的最新版）。
     * 所以它应该出现在 usedBy，而**不是** unknownBinding。
     */
    expect(r.usedBy, '文件不存在时退回 latest 是刻意的近似，不该报成损坏').toContain('老实例')
    expect(r.unknownBinding ?? [], '文件不存在 ≠ 文件损坏').not.toContain('老实例')
  })
})

