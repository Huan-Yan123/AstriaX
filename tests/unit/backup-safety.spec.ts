/*
 * 备份/回滚的安全与整洁。
 *
 * 三条都是真问题，而且第一条比较重：
 *
 * 1. **路径穿越**。restoreBackup 直接 `join(base, e.rel)` 写文件，
 *    而 rel 是从 tar 里读出来的**外部输入**。备份归档是用户能在磁盘上
 *    看到、也能互相传的东西（「用我的备份试试」），所以一个 rel 写成
 *    `..\..\..\Windows\System32\...` 的归档就能往任意位置写文件。
 *    尤其要紧的是：**这个启动器是自我提权运行的（管理员）** ——
 *    于是「往任意位置写」等于「以管理员身份任意写」，后果被放大一档。
 *
 * 2. **孤儿 sidecar**。pruneBackups 只删 `.tar.gz`，配套的 `.json`
 *    永远留在那里。备份页只认 `.tar.gz`，所以这些孤儿是**看不见的垃圾**，
 *    每淘汰一轮就多攒几个，用户永远清不掉。
 *
 * 3. **`.deleted-*` 残骸**。回滚时把要覆盖的顶层项改名成 `.deleted-<时间戳>`
 *    挪走，但成功之后从来不清理。每回滚一次就多留一份完整旧数据
 *    （AstrBot 的 data 可能几百 MB），回滚几次就把盘吃出大坑。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { gzipSync } from 'zlib'
import { restoreBackup, pruneBackups, backupRuntime } from '../../src/main/update/backup'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('acb-backup-safe-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 按 backup.ts 的私有 tar 结构手工造一个归档（模拟伪造/损坏的备份） */
function craftTar(entries: Array<{ rel: string; data: string }>): Buffer {
  return Buffer.concat(
    entries.map((e) => {
      const rel = Buffer.from(e.rel, 'utf8')
      const len = Buffer.alloc(4)
      len.writeUInt32LE(rel.length)
      const body = Buffer.from(e.data, 'utf8')
      const dlen = Buffer.alloc(8)
      dlen.writeBigUInt64LE(BigInt(body.length))
      return Buffer.concat([len, rel, dlen, body])
    })
  )
}

describe('备份回滚的安全', () => {
  it('★归档里的 ..\\ 路径必须被拒绝（应用是管理员权限，任意写 = 提权）', async () => {
    const inst = join(root, 'inst')
    mkdirSync(inst, { recursive: true })
    const evil = join(root, 'evil.tar.gz')
    // 目标算出实例目录外面：<root>\inst\..\..\PWNED.txt
    writeFileSync(evil, gzipSync(craftTar([{ rel: '..\\..\\PWNED.txt', data: 'x' }])))

    /*
     * 多行形态（变换脚本第一版在这里出错：把 await 插进了非 async 的箭头函数，
     * esbuild 直接报 "await can only be used inside an async function"）。
     * 正确写法是把 expect 整个 await 掉、用 rejects：
     */
    await expect(
      restoreBackup({ dir: inst, file: evil }),
      '带 .. 的路径必须抛错，绝不能写出去'
    ).rejects.toThrow()
    expect(existsSync(join(root, 'PWNED.txt')), '文件被写到实例目录外面了').toBe(false)
  })

  it('★绝对路径的 rel 也要被拒绝', async () => {
    const inst = join(root, 'inst')
    mkdirSync(inst, { recursive: true })
    const evil = join(root, 'abs.tar.gz')
    const target = join(root, 'abs-target.txt')
    writeFileSync(evil, gzipSync(craftTar([{ rel: target, data: 'x' }])))

    await expect(restoreBackup({ dir: inst, file: evil })).rejects.toThrow()
    expect(existsSync(target)).toBe(false)
  })

  it('正常备份能正常回滚（别把功能一起挡掉）', async () => {
    const inst = join(root, 'inst')
    mkdirSync(join(inst, 'data'), { recursive: true })
    writeFileSync(join(inst, 'data', 'db.sqlite'), 'v1', 'utf8')
    const bak = await backupRuntime({ dir: inst, templateVersion: 1, stamp: () => '20260101000000' })

    // 改坏数据，再回滚
    writeFileSync(join(inst, 'data', 'db.sqlite'), 'broken', 'utf8')
    await restoreBackup({ dir: inst, file: bak.file })
    expect(readFileSync(join(inst, 'data', 'db.sqlite'), 'utf8')).toBe('v1')
  })

  it('★淘汰旧备份时连 .json 一起删（否则留下看不见的孤儿）', async () => {
    const inst = join(root, 'inst')
    mkdirSync(join(inst, 'data'), { recursive: true })
    writeFileSync(join(inst, 'data', 'x'), 'x', 'utf8')

    // 造 5 份备份
    for (let i = 1; i <= 5; i++) {
      const s = `2026010100000${i}`
      await backupRuntime({ dir: inst, templateVersion: i, stamp: () => s })
    }
    const dir = join(inst, 'backups')
    expect(readdirSync(dir).filter((f) => f.endsWith('.tar.gz')).length).toBe(5)

    pruneBackups({ dir: inst, keep: 2 })

    const left = readdirSync(dir)
    expect(left.filter((f) => f.endsWith('.tar.gz')).length).toBe(2)
    expect(
      left.filter((f) => f.endsWith('.json')).length,
      '只删 tar.gz 会把 .json 留成孤儿（备份页看不到、用户也清不掉）'
    ).toBe(2)
  })

  it('★回滚成功后不留 .deleted-* 残骸（否则每回滚一次多占一份数据）', async () => {
    const inst = join(root, 'inst')
    mkdirSync(join(inst, 'data'), { recursive: true })
    writeFileSync(join(inst, 'data', 'db.sqlite'), 'v1', 'utf8')
    const bak = await backupRuntime({ dir: inst, templateVersion: 1, stamp: () => '20260101000000' })

    writeFileSync(join(inst, 'data', 'db.sqlite'), 'v2', 'utf8')
    await restoreBackup({ dir: inst, file: bak.file })

    const leftovers = readdirSync(inst).filter((f) => f.includes('.deleted-'))
    expect(leftovers, `回滚后应清理临时残骸，实际留下：${leftovers.join(',')}`).toEqual([])
    // 但数据确实回滚了
    expect(readFileSync(join(inst, 'data', 'db.sqlite'), 'utf8')).toBe('v1')
  })

  it('★回滚失败时残骸要留着（那是用户唯一的还原点）', async () => {
    const inst = join(root, 'inst')
    mkdirSync(join(inst, 'data'), { recursive: true })
    writeFileSync(join(inst, 'data', 'db.sqlite'), 'keep-me', 'utf8')

    /*
     * 要测的是「**解析成功、写盘阶段**失败」时旧数据有没有保住。
     * 所以不能用一个头部就坏掉的归档 —— 那种在挪走旧数据之前就抛了，
     * 残骸为 0 是正常的（什么都没动，也就没什么要保的）。
     *
     * 这里用 Windows 文件名里非法的 `<`（实测必然 ENOENT）：
     * 解析全程正常、旧数据已经挪走，然后这一条写盘失败 ——
     * 正好落在我们要守的那个阶段。
     */
    const tricky = join(inst, 'backups')
    mkdirSync(tricky, { recursive: true })
    const bad = join(tricky, 'write-fail.tar.gz')
    writeFileSync(bad, gzipSync(craftTar([{ rel: 'data\\il<legal.txt', data: 'x' }])))
    /*
     * 配套 manifest 必须写，且 scope 要标成 'data'。
     * 没有它 restoreBackup 会按**旧格式**处理（base = <实例>\runtime\，
     * 那是早期版本备份 runtime 的位置），于是相对路径的基准就不对了，
     * 这个用例也就测不到「新格式回滚失败」这条路径。
     */
    writeFileSync(
      bad.replace(/\.tar\.gz$/, '.json'),
      JSON.stringify({ scope: 'data', templateVersion: 1 }),
      'utf8'
    )

    await expect(restoreBackup({ dir: inst, file: bad })).rejects.toThrow()
    const leftovers = readdirSync(inst).filter((f) => f.includes('.deleted-'))
    expect(
      leftovers.length,
      '回滚失败时旧数据必须留在 .deleted-* 里，否则用户唯一的还原点也没了'
    ).toBeGreaterThan(0)
    // 而且旧数据**真的还在**（不是只留了个空壳目录）
    const kept = leftovers.find((f) => f.startsWith('data.deleted-'))
    expect(kept, '被挪走的应该是整个 data\\').toBeTruthy()
    expect(readFileSync(join(inst, kept!, 'db.sqlite'), 'utf8')).toBe('keep-me')
  })
})
