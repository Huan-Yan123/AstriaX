/*
 * instances.json 损坏时，**坏文件必须被留证**，不能被下一次写入静默覆盖。
 *
 * ## 缺陷（审计抓出来的 "Bug B"）
 *
 * instance-repo.ts 的 readAll() 遇到坏文件会降级返回 `{ instances: [] }`，
 * 注释写得很清楚：
 *
 *     「注意**不覆盖**坏文件 —— 那是用户唯一的现场证据，留着才能人工抢救。」
 *
 * 但**没有任何代码实现这个承诺**。readAll 只是"这次不写"，而
 * `writeAll()` 是 `writeFileSync(tmp) + renameSync(tmp, file)` ——
 * 原子替换，**直接盖掉**原文件。
 *
 * 于是真实的用户路径是：
 *
 *   1. 用户手工编辑 instances.json，改坏了一个引号
 *      （或者写盘时断电 / 同步盘回滚 / 杀软截断）
 *   2. 打开软件 → readAll 降级成空列表 → 界面**一个实例都没有**
 *   3. 用户以为是软件坏了，去点「新建实例」试一下
 *   4. create() 内部 readAll() 拿到空列表 → 写回 → **坏文件被永久覆盖**
 *   5. 那份"唯一现场证据"没了；用户本来还能照着它手工恢复
 *
 * 第 4 步是致命的：一步再普通不过的操作，就把唯一的线索毁了。
 * 而且文件里可能本来还有 7 条完好的记录，只是某一条坏了 ——
 * 一起没了。
 *
 * ## 正确行为
 *
 * 检测到损坏时**立刻**把坏文件改名留证（`instances.json.corrupt-<时间戳>`），
 * 然后才允许后续写入生成新的干净文件。这样：
 *   - 用户能从 `.corrupt-*` 文件里手工抢救数据；
 *   - 新文件是干净的，软件能正常用；
 *   - 谁也没覆盖谁。
 *
 * 留证动作必须在**检测的那一刻**做（而不是等 writeAll 之前），
 * 因为 writeAll 有可能在别的路径上被调用，漏掉一处就又回到老问题。
 *
 * ## 关于"别把正常文件误判成损坏"
 *
 * 只有**真的解析失败或结构不对**才留证。空文件（0 字节）算损坏
 * （JSON.parse('') 抛错），但 `{"instances":[]}` 这种合法空仓库不算。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { createInstanceRepo } from '../../src/main/store/instance-repo'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('mx-repo-corrupt-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const FILE = (): string => join(root, 'instances.json')

/** 找出留证文件（instances.json.corrupt-* 之类） */
function corruptFiles(): string[] {
  try {
    return readdirSync(root).filter((f) => /instances\.json\.(corrupt|bad|bak)/i.test(f))
  } catch {
    return []
  }
}

/** 一份**内容完好**但语法坏掉的索引（含两条记录，好让人能手工抢救） */
const BROKEN = `{
  "instances": [
    { "id": "n_aaaa111111", "type": "n", "name": "救得回来的实例", "port": 6200 },
    { "id": "n_bbbb222222", "type": "n", "name": "第二条" "port": 6201 }
  ]
}`

describe('instances.json 损坏：坏文件必须留证', () => {
  it('★坏文件被留证，不被静默覆盖', () => {
    writeFileSync(FILE(), BROKEN, 'utf8')
    const repo = createInstanceRepo({ dataRoot: root })

    // 读的时候降级成空列表（既有行为，不能坏）
    expect(repo.list()).toEqual([])

    // 关键：坏文件已经被改名留证，原文还能读回来
    const saved = corruptFiles()
    expect(saved.length).toBeGreaterThan(0)
    const text = readFileSync(join(root, saved[0]), 'utf8')
    expect(text).toContain('救得回来的实例')
    expect(text).toContain('n_aaaa111111')
  })

  it('★留证之后新建实例：证据仍在，新文件是干净的', () => {
    writeFileSync(FILE(), BROKEN, 'utf8')
    const repo = createInstanceRepo({ dataRoot: root })

    const rec = repo.create({ type: 'n', name: '新实例' })
    expect(rec.id).toBeTruthy()

    // 证据没被 create 的写回覆盖
    const saved = corruptFiles()
    expect(saved.length).toBeGreaterThan(0)
    expect(readFileSync(join(root, saved[0]), 'utf8')).toContain('救得回来的实例')

    // 新文件能正常解析，且只有新实例
    const now = JSON.parse(readFileSync(FILE(), 'utf8')) as { instances: unknown[] }
    expect(now.instances).toHaveLength(1)
  })

  it('损坏只留证一次（反复读不会堆出一堆 .corrupt 文件）', () => {
    writeFileSync(FILE(), BROKEN, 'utf8')
    const repo = createInstanceRepo({ dataRoot: root })
    repo.list()
    repo.list()
    repo.list()
    repo.create({ type: 'n', name: 'a' })
    repo.list()
    expect(corruptFiles().length).toBe(1)
  })

  it('保留多条记录的能力：留证文件里两条都在（哪怕整体解析失败）', () => {
    writeFileSync(FILE(), BROKEN, 'utf8')
    const repo = createInstanceRepo({ dataRoot: root })
    repo.list()
    const saved = corruptFiles()
    const text = readFileSync(join(root, saved[0]), 'utf8')
    expect(text).toContain('n_aaaa111111')
    expect(text).toContain('n_bbbb222222')
  })

  it('合法空仓库不触发留证（别把正常情况当损坏）', () => {
    writeFileSync(FILE(), '{"instances":[]}', 'utf8')
    const repo = createInstanceRepo({ dataRoot: root })
    expect(repo.list()).toEqual([])
    expect(corruptFiles()).toHaveLength(0)
  })

  it('结构不对（instances 不是数组）也留证', () => {
    writeFileSync(FILE(), '{"instances":{"a":1}}', 'utf8')
    const repo = createInstanceRepo({ dataRoot: root })
    repo.list()
    expect(corruptFiles().length).toBeGreaterThan(0)
  })

  it('文件不存在时不产生留证文件（那不是损坏）', () => {
    const repo = createInstanceRepo({ dataRoot: root })
    repo.list()
    expect(existsSync(FILE())).toBe(false)
    expect(corruptFiles()).toHaveLength(0)
  })

  it('0 字节文件算损坏并留证', () => {
    writeFileSync(FILE(), '', 'utf8')
    const repo = createInstanceRepo({ dataRoot: root })
    repo.list()
    expect(corruptFiles().length).toBeGreaterThan(0)
  })

  it('正常文件反复读写不产生留证（回归保护）', () => {
    const repo = createInstanceRepo({ dataRoot: root })
    repo.create({ type: 'n', name: '正常' })
    repo.list()
    repo.create({ type: 'a', name: '正常2' })
    expect(corruptFiles()).toHaveLength(0)
    expect(repo.list()).toHaveLength(2)
  })
})
