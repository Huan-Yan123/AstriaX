/*
 * 迁移失败时**绝不能改记录里的 dir**
 *
 * ## 缺陷（审计抓出来的 "Bug C"）
 *
 * relocate.ts 的实例复制循环原来长这样：
 *
 *     try {
 *       copyInto(rec.dir, dest)
 *       moved.push(...)
 *     } catch (e) {
 *       failed.push({ item: ..., reason: ... })   // → 记了失败
 *     }
 *     repo.setRecordDir(rec.id, dest)             // → 但在 catch 外面
 *
 * `setRecordDir` 在 try/catch **之外**，所以无论复制成功还是失败，
 * 记录里的 `dir` 都会被改写成新根的位置。
 *
 * ## 为什么这不只是"少拷了文件"那么轻
 *
 * `dir` 是「实例数据在哪」的唯一真相（见 instance-repo.ts 的 setRecordDir）。
 * 复制失败（Windows 上最常见：某个文件被正在跑的实例占着）之后：
 *
 *   1. 新根下那个 `dest` 只是 `mkdirSync` 建出来的**空目录**；
 *   2. 记录却已经指了过去；
 *   3. 用户在新根打开软件 → 实例卡片还在，但数据（配置、插件、凭据）全空；
 *   4. 旧根里那份**完好的**数据再也没人引用，用户以为迁移把数据搞丢了。
 *
 * 也就是说：一次*有失败的迁移*会*静默地把实例指向空目录*，
 * 而用户看到的是「迁移成功（1 项失败）」—— 那 1 项看起来无关紧要。
 *
 * ## 正确行为
 *
 * 复制失败就**不要动** `dir`，让它继续指向旧位置（数据还在那儿，能用）。
 * 失败项照旧报给用户。
 *
 * ## 怎么造"复制失败"
 *
 * **不能用 `vi.spyOn(fs, 'cpSync')`** —— 这一版我试过，静默无效：
 * relocate.ts 是 `import { cpSync } from 'fs'` 的**具名导入**，
 * 打包/转译之后调用的是模块内部绑定，改 `fs.cpSync` 这个属性
 * 影响不到它。测试于是"通过了失败断言为 0" —— 又一个假绿。
 *
 * 改用**真实的文件系统障碍**：让源"实例目录"实际是一个**普通文件**。
 * `existsSync` 对文件也返回 true（不会跳过复制），而
 * `fsp.cp(文件 → 目录, {recursive:true})` 复制目录树时会失败
 * （dest 已被 mkdirSync 建成目录，源却是文件 —— 结构对不上），
 * 稳定复现，且不需要任何 mock。
 *
 * （试过的另一种"悬空 junction"，existsSync 对断链返回 **false**，
 *  会被 `if (existsSync(rec.dir))` 直接跳过，篡根不进 try —— 不行。）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createInstanceRepo } from '../../src/main/store/instance-repo'
import { relocateDataRoot } from '../../src/main/store/relocate'
import { testStage } from '../helpers/stage'

let root: string
let srcRoot: string
let dstRoot: string

beforeEach(() => {
  root = testStage('acb-reloc-faildir-')
  srcRoot = join(root, 'old')
  dstRoot = join(root, 'new')
  mkdirSync(srcRoot, { recursive: true })
  mkdirSync(dstRoot, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 在旧根造一个带数据、且记录已登记好的实例 */
function seedInstance(): ReturnType<typeof createInstanceRepo> {
  const repo = createInstanceRepo({ dataRoot: srcRoot })
  const rec = repo.create({ type: 'n', name: '测试实例' })
  mkdirSync(rec.dir, { recursive: true })
  writeFileSync(join(rec.dir, 'config.json'), '{"precious":true}', 'utf8')
  writeFileSync(join(rec.dir, 'cred.txt'), 'SECRET', 'utf8')
  return repo
}

/**
 * 把某个实例目录变成「存在但复制一定失败」的状态。
 *
 * 做法：在 `rec.dir` 位置放一个**普通文件**（文件也算"存在"），
 * 而 `copyInto` 里 `fsp.cp(文件, 目录, {recursive:true})` 结构对不上 → 失败。
 */
function breakInstanceDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
  // 用一个**文件**占住"实例目录"这个位置
  writeFileSync(dir, 'not-a-directory', 'utf8')
}

describe('迁移：实例复制失败时不能改写 dir', () => {
  it('★复制失败 → dir 仍指向旧位置（数据还在那儿，记录必须说真话）', async () => {
    const repo = seedInstance()
    const rec = repo.list()[0]
    const oldDir = rec.dir

    breakInstanceDir(oldDir)
    expect(existsSync(oldDir)).toBe(true) // 前置判断不会被跳过
    const r = await relocateDataRoot(repo, { target: dstRoot })

    // 必须报出失败
    expect(r.failed.length).toBeGreaterThan(0)

    /*
     * 关键断言：记录里的 dir 没有被改到新根的空目录。
     *
     * 缺陷版本（setRecordDir 在 catch 外）在这里会失败：
     * 记录被改写成 <new>\instances\NapCat\<id>，而那个目录是空的，
     * 旧根里那份完好的数据再也没人引用。
     */
    const still = createInstanceRepo({ dataRoot: srcRoot }).list()
    expect(still).toHaveLength(1)
    expect(still[0].dir).toBe(oldDir)

    const after = createInstanceRepo({ dataRoot: dstRoot }).list()
    expect(after.find((x) => x.id === rec.id)?.dir ?? '').not.toBe(
      join(dstRoot, 'instances', 'NapCat', rec.id)
    )
  })

  it('复制成功时 dir 正常改到新根（别把正常流程一起搞坏了）', async () => {
    const repo = seedInstance()
    const rec = repo.list()[0]
    const r = await relocateDataRoot(repo, { target: dstRoot })
    expect(r.failed).toHaveLength(0)

    const after = createInstanceRepo({ dataRoot: dstRoot }).list()
    const moved = after.find((x) => x.id === rec.id)
    expect(moved).toBeTruthy()
    expect(moved!.dir).toBe(join(dstRoot, 'instances', 'NapCat', rec.id))
    expect(existsSync(join(moved!.dir, 'config.json'))).toBe(true)
  })
})
