/*
 * 遗留 `.deleting-*` 垃圾目录的清理。
 *
 * ## 它们是怎么来的
 *
 * 删版本时先把目录改名叫 `<tag>.deleting-<stamp>`（让列表立刻干净），
 * 再异步删文件。如果那时**有实例正在用这个版本**，Windows 会因为
 * 文件被占用而删不掉 —— 于是一个残缺目录永久留下。
 *
 * 实机现场（主人机器）：
 *   runtimes\a\v4.27.0.deleting-mu0knsw0\
 *     aiohttp/ numpy/ ...  ← 依赖还在
 *     astrbot/             ← 空掉了
 * 它占着几百 MB，永远不会自己消失。
 *
 * ## 两道防线
 *
 *   1. `runtimes:remove` 拒绝删除正在被运行的版本（新的垃圾不再产生）
 *   2. `sweepTrash` 在启动时清掉已经留下的（这个测试覆盖的）
 *
 * sweepTrash 必须**不抛错、不阻塞**：它是打扫卫生，
 * 删不掉（还被占用）就留着下次再来，绝不能影响启动。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRuntimeStore } from '../../src/main/update/runtime-store'
import { testStage } from '../helpers/stage'
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'

let root: string
beforeEach(() => {
  root = testStage('acb-sweep-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造一个 .deleting-* 残留目录 */
function makeTrash(type: 'a' | 'n', tag: string): string {
  const p = join(root, 'runtimes', type, `${tag}.deleting-abc123`)
  mkdirSync(join(p, 'astrbot'), { recursive: true })
  writeFileSync(join(p, 'astrbot', '__init__.py'), '# 残留\n', 'utf8')
  return p
}

/** 等 sweepTrash 的后台删除跑完（它是 fire-and-forget 的） */
async function settle(ms = 400): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe('清理遗留的 .deleting-* 目录', () => {
  it('★启动清理要把残留目录删掉', async () => {
    const trash = makeTrash('a', 'v4.27.0')
    expect(existsSync(trash)).toBe(true)

    const notes: string[] = []
    createRuntimeStore({ dataRoot: root }).sweepTrash((m) => notes.push(m))
    await settle()

    expect(existsSync(trash), '残留目录没被清掉').toBe(false)
    expect(notes.length, '清掉了就该记一笔日志（便于排查磁盘去哪了）').toBeGreaterThan(0)
  })

  it('★正常版本目录绝不能被误删', async () => {
    const good = join(root, 'runtimes', 'a', 'v4.28.0')
    mkdirSync(join(good, 'astrbot'), { recursive: true })
    writeFileSync(join(good, 'astrbot', '__init__.py'), '__version__="4.28.0"\n', 'utf8')
    makeTrash('a', 'v4.27.0')

    createRuntimeStore({ dataRoot: root }).sweepTrash()
    await settle()

    expect(existsSync(join(good, 'astrbot', '__init__.py')), '把好版本删了！').toBe(true)
  })

  it('★两类的残留都能清（a 和 n 都要扫）', async () => {
    const ta = makeTrash('a', 'v1.0.0')
    const tn = makeTrash('n', 'v2.0.0')
    createRuntimeStore({ dataRoot: root }).sweepTrash()
    await settle()
    expect(existsSync(ta)).toBe(false)
    expect(existsSync(tn)).toBe(false)
  })

  it('★目录不存在时不能抛（全新安装、还没下载过任何版本）', () => {
    // root 下什么都没有
    expect(() => createRuntimeStore({ dataRoot: root }).sweepTrash()).not.toThrow()
  })

  it('★名字里不含 .deleting- 的目录一律不动', async () => {
    const weird = join(root, 'runtimes', 'a', 'imported-abc123')
    mkdirSync(join(weird, 'astrbot'), { recursive: true })
    createRuntimeStore({ dataRoot: root }).sweepTrash()
    await settle()
    expect(existsSync(weird), '手动导入的版本（imported-* 命名）被误删了').toBe(true)
  })
})
