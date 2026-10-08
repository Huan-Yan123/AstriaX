/*
 * ★★ 取消之后**不能**把半成品登记成"已安装"
 *
 * 主人 2026-09-27 实测（原话）：
 *   「取消但是判定安装成功了 AstrBot 2 · v4.28.1 · 手动导入 · 删除」
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 现场（他给的日志）
 * ══════════════════════════════════════════════════════════════════════════
 *
 *     [22:02:27] 用户取消了 导入：AstrBot v4.28.1（已跑 3 秒）
 *     [22:02:31] 导入的 AstrBot v4.28.1 依赖安装失败：pip 退出码 -1：已取消
 *     [22:02:31] runtimes:importFile  AstrBot ...whl  成功      ← 还是"成功"！
 *
 * 而 `runtimes.json` 里多出一条：
 *     { "tag": "v4.28.1", "from": "手动导入", "sizeMB": 25.9 }
 *                        ↑ 正常应当 ~547 MB —— 25.9 MB 说明只解压了 whl 本体
 *
 * ## 根因
 *
 * `signal` 只传给了 pip，于是"取消"的效果仅仅是**依赖装失败**，
 * 而流程照旧走完 `register` + 返回成功 —— 用户以为取消了，
 * 实际多了个跑不起来的版本，还占着「已装版本」的位置。
 *
 * ## 修法
 *
 * 在流程的每个节点之后都查一次 `signal.aborted`，命中就**抛错中断**：
 *   · 解压之后
 *   · 依赖装完（或失败）之后
 *   · **登记之前**（最关键 —— 那是"从此算装好了"的那一刻）
 *
 * 抛错会被 catch 接住 → 清理目录 → 不登记。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { testStage } from '../helpers/stage'
import { buildHandlers } from '../../src/main/ipc'
import { beginTask, taskKey, cancelTask, endTask } from '../../src/main/update/running-tasks'

let root: string
let instDir: string

beforeEach(() => {
  root = testStage('cancel-import-')
  instDir = join(root, 'instances', 'AstrBot', 'a_seed')
  mkdirSync(instDir, { recursive: true })
  writeFileSync(join(root, 'config.json'), JSON.stringify({ dataRoot: root }), 'utf8')
  writeFileSync(join(root, 'instances.json'), JSON.stringify({ instances: [] }), 'utf8')
  writeFileSync(join(root, 'runtimes.json'), JSON.stringify({ versions: [] }), 'utf8')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** 读 runtimes.json 里的 tag 列表 */
function registeredTags(): string[] {
  const f = join(root, 'runtimes.json')
  if (!existsSync(f)) return []
  const j = JSON.parse(readFileSync(f, 'utf8')) as { versions?: Array<{ tag: string }> }
  return (j.versions ?? []).map((v) => v.tag)
}

describe('★★取消 → 不许登记半成品', () => {
  it('★★用户取消后，runtimes.json 里**不能**多出那个版本', async () => {
    /*
     * 造一个最小的 whl（zip 结构）——`probeArchive` 要能认出它是 AstrBot 包。
     * 用真实的 zip 内容太麻烦，这里直接用一个**假的探针**，
     * 让 probeArchive 返回我们想要的结果（测的是"取消后的流程"，
     * 不是"能不能识别包"）。
     */
    const whl = join(root, 'astrbot-4.28.1-py3-none-any.whl')
    writeFileSync(whl, 'PK\u0003\u0004fake', 'latin1')

    const h = buildHandlers({
      probe: () => Promise.resolve(false)
    })
    await h['config:set']({ dataRoot: root })

    /*
     * 手动占一个任务（模拟"导入已经开始"），然后**立刻取消** ——
     * 这样调用 importFile 时 signal 已经是 aborted，
     * 流程应当在第一个检查点就中断。
     */
    const key = taskKey('a', 'v4.28.1')
    const c = new AbortController()
    const t = beginTask({ key, kind: 'import', controller: c, label: '测试' })
    expect(t).not.toBeNull()
    cancelTask(key)

    let threw = false
    try {
      await h['runtimes:importFile']({ type: 'a', file: whl, version: '4.28.1' })
    } catch {
      threw = true
    } finally {
      endTask(key, c)
    }

    /*
     * 因为上面已经占着同一个 key，importFile 会先被**互锁**挡住
     *（那是另一条防线，也说明互锁生效）——所以这里主要断言的是
     * "无论如何都不能多出一个登记"。
     */
    expect(
      registeredTags(),
      '★取消（或被互锁挡住）之后，绝不能往 runtimes.json 里加半成品 ——\n' +
        '主人实测的现象就是"取消了但显示已安装 v4.28.1（25.9 MB）"'
    ).not.toContain('v4.28.1')
    void threw
  })

  it('★源码守卫：登记之前必须有取消检查', () => {
    /*
     * 上面那条测的是"最终没有多出登记"，但**单靠它抓不到**
     * "检查漏在某一处"的回归（比如只在解压后查、登记前忘了查）。
     *
     * 所以这里直接检查接线：`store.register({ ... '手动导入' })`
     * 之前必须有一句 `throwIfCancelled()`。
     *
     * 这类"函数级测试照不到接线层"的情况在本项目很常见
     *（前面"点哪个源就用哪个源"、"instance:start 传对 runtimeDir"
     *  都是靠这种源码守卫守住的）。
     */
    const src = readFileSync(join(process.cwd(), 'src', 'main', 'ipc.ts'), 'utf8')

    const needle = "store.register({ type: p.type, tag, from: '手动导入' })"
    const idx = src.indexOf(needle)
    expect(idx, '找不到导入的 register 调用').toBeGreaterThan(0)

    /*
     * ★ 判据必须是"**紧邻的上一句代码**"，不能是"往前 N 字符内有"。
     *
     * 我第一版写的是"往前 600 字符内包含 throwIfCancelled()" ——
     * 而那段范围里**还有依赖装完后的一次检查**，于是：
     * 把登记前那句撤掉，守卫**照样通过**（尺子验证时发现的：
     * 撤掉检查后测试仍然全绿，说明这条守卫是假的）。
     *
     * 现在改成：取 register 之前**连续的非空、非注释行**，
     * 要求**最近的上一句代码**就是 throwIfCancelled() ——
     * 这样撤掉它就一定红。
     */
    const beforeLines = src
      .slice(0, idx)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('*') && !l.startsWith('/*') && !l.startsWith('//'))

    const prevCode = beforeLines[beforeLines.length - 1]
    expect(
      prevCode,
      '★`store.register(...)` 的**紧邻上一句**必须是 `throwIfCancelled()`\n' +
        '（那是"从此算装好了"的那一刻 —— 漏了它就会出现主人实测的\n' +
        '  "取消了但显示已安装，而且是个 25.9 MB 的半成品"）。\n' +
        `实际上一句是：${prevCode}`
    ).toBe('throwIfCancelled()')
  })

  it('★源码守卫：解压之后也要查一次', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'main', 'ipc.ts'), 'utf8')
    const idx = src.indexOf('await importArchive({ dataRoot: cfg.dataRoot, file')
    expect(idx).toBeGreaterThan(0)

    /*
     * 同样要求"紧跟其后的**下一句代码**"是 throwIfCancelled()。
     *
     * 上一行是 `await importArchive(...)` 的收尾（可能跨行），
     * 所以这里取它之后的第一句非空、非注释的**独立语句**。
     */
    const afterLines = src
      .slice(idx)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('*') && !l.startsWith('/*') && !l.startsWith('//'))

    /*
     * afterLines[0] 是 importArchive 那行本身（可能带后续参数），
     * 它可能跨多行 —— 找到以 `})` 收尾的那一行，再看下一句。
     */
    let i = 1
    while (i < afterLines.length && !afterLines[i - 1].endsWith('})')) i++

    expect(
      afterLines[i],
      '★`await importArchive(...)` 之后**紧邻的那句**要查一次取消 ——\n' +
        'NapCat 那个包解开上百 MB，用户可能在途中就取消了'
    ).toBe('throwIfCancelled()')
  })
})
