/*
 * 覆盖更新自动备份的**清理**逻辑。
 * ========================================================================
 *
 * ## 为什么需要这个
 *
 * 安装器在每次覆盖更新前都会打一份数据备份（用户要求的功能）。
 * 但安装器**只管打、不管删** —— NSIS 里做排序删旧包又脆又容易编不过，
 * 而且判断"哪些该删"属于业务逻辑，本来就该在程序里做。
 *
 * 实测（scripts/test-installer-e2e.cjs 用例 7b）：连续更新两次后
 * 备份文件夹里就攒了 3 份。用户是"0.1.0 → 0.1.1 → 0.1.2 …"这样一直更新的，
 * 不清理就是**无上限增长** —— 每个版本都留一份几十 KB~几 MB 的包，
 * 一年下来就是几百个目录。这正是本项目反复踩的"只堆不清"那类问题
 * （之前 cache\tmp 攒到 916 个条目、GB 级）。
 *
 * ## 清理规则（每条都有理由）
 *
 *  1. **按时间倒序保留最近 N 份**，其余删掉。
 *  2. **N 来自配置 config.backupKeep**（和实例备份共用同一个用户设置）——
 *     用户已经有一个"保留几份"的旋钮，不该再让他学第二个。
 *  3. **N 最小为 1**，配置成 0 或负数时回落到默认值，而不是"一份不留"。
 *     理由：更新前备份是**最后一道保险**。用户把 backupKeep 调成 0
 *     通常是想"别占我空间"，但如果因此把唯一的救命备份也删了，
 *     出事时他什么都没有。所以宁可保守。
 *  4. **只删自己认识的东西**：目录名必须是时间戳形状、且里面确实有
 *     `mxbot-data.tar.gz`。不认识的目录一律不碰 —— 万一用户自己在
 *     `backups\` 下放了东西，绝不能被我们的清理顺手删掉。
 *  5. **永不抛异常**：清理失败不能影响启动。逐项 try/catch。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testStage } from '../helpers/stage'
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'fs'
import { join } from 'path'
import { listUpdateBackups, pruneUpdateBackups, updateBackupsRoot, UPDATE_BACKUP_FILE } from '../../src/main/update/update-backups'

let root: string
let dataRoot: string

/** 造一份备份目录（stamp 形如 20260914-151447） */
function seedBackup(stamp: string, bytes = 100, withFile = true): string {
  const dir = join(updateBackupsRoot(dataRoot), stamp)
  mkdirSync(dir, { recursive: true })
  if (withFile) {
    writeFileSync(join(dir, UPDATE_BACKUP_FILE), 'X'.repeat(bytes), 'utf8')
  }
  return dir
}

beforeEach(() => {
  root = testStage('acb-update-prune-')
  dataRoot = join(root, 'data')
  mkdirSync(dataRoot, { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('覆盖更新备份的清理', () => {
  it('备份根目录位置符合约定（backups\\update）', () => {
    expect(updateBackupsRoot(dataRoot)).toBe(join(dataRoot, 'backups', 'update'))
  })

  it('没有任何备份时也安全（不抛异常、返回空）', () => {
    expect(listUpdateBackups(dataRoot)).toEqual([])
    expect(pruneUpdateBackups(dataRoot, 5)).toEqual([])
  })

  it('列出备份：按时间倒序（最新的在前）', () => {
    seedBackup('20260914-100000')
    seedBackup('20260914-120000')
    seedBackup('20260914-110000')

    const list = listUpdateBackups(dataRoot)
    expect(list.map((x) => x.stamp)).toEqual(['20260914-120000', '20260914-110000', '20260914-100000'])
  })

  it('★保留最近 N 份，多余的删掉', () => {
    for (const s of ['20260914-100000', '20260914-110000', '20260914-120000', '20260914-130000']) {
      seedBackup(s)
    }

    const removed = pruneUpdateBackups(dataRoot, 2)

    // 被删的是最旧的两份
    expect(removed.sort()).toEqual(['20260914-100000', '20260914-110000'])
    // 留下的必须是**最新的**两份（不能误删救命的那份）
    const left = readdirSync(updateBackupsRoot(dataRoot)).sort()
    expect(left).toEqual(['20260914-120000', '20260914-130000'])
  })

  it('★最新的那一份永远不能被删（哪怕 keep 设成 0）', () => {
    seedBackup('20260914-100000')
    seedBackup('20260914-120000')

    /*
     * keep=0 是用户可能设的值（想省空间）。但对"更新前保险"来说，
     * 一份不留等于把最后退路删了。所以必须保底留 1 份。
     */
    pruneUpdateBackups(dataRoot, 0)

    const left = readdirSync(updateBackupsRoot(dataRoot))
    expect(left.length, 'keep=0 时把所有备份都删了 —— 用户失去了最后的退路').toBeGreaterThanOrEqual(1)
    expect(left).toContain('20260914-120000') // 留的必须是最新那份
  })

  it('负数 / NaN / 未定义 都按默认值处理，不会误删或崩溃', () => {
    seedBackup('20260914-100000')
    seedBackup('20260914-110000')
    seedBackup('20260914-120000')

    expect(() => pruneUpdateBackups(dataRoot, -5)).not.toThrow()
    expect(() => pruneUpdateBackups(dataRoot, NaN)).not.toThrow()
    expect(() => pruneUpdateBackups(dataRoot, undefined as unknown as number)).not.toThrow()
    // 至少最新的还在
    expect(existsSync(join(updateBackupsRoot(dataRoot), '20260914-120000'))).toBe(true)
  })

  it('★不认识的目录绝不碰（用户自己放的东西不能被清理删掉）', () => {
    seedBackup('20260914-100000')
    seedBackup('20260914-110000')

    // 用户自己放的东西：名字不是时间戳，且没有我们的包文件
    const userDir = join(updateBackupsRoot(dataRoot), '我自己放的重要东西')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'note.txt'), '别删我', 'utf8')

    // 时间戳形状但里面没有我们的包 —— 也不该删（可能用户手工放的）
    const oddDir = join(updateBackupsRoot(dataRoot), '20260914-090000')
    mkdirSync(oddDir, { recursive: true })
    writeFileSync(join(oddDir, 'user-file.txt'), '别人的文件', 'utf8')

    pruneUpdateBackups(dataRoot, 1)

    expect(existsSync(userDir), '用户自己放的目录被删了').toBe(true)
    expect(existsSync(join(userDir, 'note.txt'))).toBe(true)
    expect(existsSync(oddDir), '不含备份包的目录被删了（不该动它）').toBe(true)
  })

  it('备份数量不足 keep 时不做任何删除', () => {
    seedBackup('20260914-100000')
    seedBackup('20260914-110000')
    expect(pruneUpdateBackups(dataRoot, 5)).toEqual([])
    expect(readdirSync(updateBackupsRoot(dataRoot)).length).toBe(2)
  })

  it('list 带上文件大小与路径（界面要显示给用户看）', () => {
    seedBackup('20260914-100000', 2048)
    const [item] = listUpdateBackups(dataRoot)
    expect(item.stamp).toBe('20260914-100000')
    expect(item.file).toBe(join(updateBackupsRoot(dataRoot), '20260914-100000', UPDATE_BACKUP_FILE))
    expect(item.sizeBytes).toBe(2048)
    // 目录不存在或读不了时不能抛，返回 0 就行
    expect(typeof item.mtimeMs).toBe('number')
  })

  it('备份文件损坏/缺失时 list 仍能工作（返回该项但不报错）', () => {
    seedBackup('20260914-100000', 0, false) // 只有目录，没有包文件
    const list = listUpdateBackups(dataRoot)
    expect(list.length).toBe(1)
    expect(list[0].sizeBytes).toBe(0)
    expect(list[0].hasPackage).toBe(false)
  })

  it('★没有包文件的同类目录不能占用保留名额（否则真备份会被提前删）', () => {
    /*
     * 场景：用户自己（或某个残留）在 backups\update\ 下建了**较新**的
     * 时间戳目录，但里面没有我们的包。
     *
     * 这里"较新"是这条用例的关键 —— 第一版我把这个目录放在**最旧**的位置，
     * 结果改不改代码都是绿的（假绿）：最旧的那个本来就会先被 slice 掉。
     * 必须让"空目录"排在真备份**前面**，才会挤掉真备份的名额：
     *
     *   排序（新→旧）: 20260914-130000(空) , 20260914-120000(空) , 20260914-110000(真)
     *   keep=1 且按"所有目录都算份额"的错逻辑 → slice(1) = [120000, 110000]
     *     → 120000 没包文件、跳过；110000 是真备份，**被删**
     *   → 用户只剩一堆空目录，唯一真备份没了。
     *
     * 正确逻辑：份额只算"真的有包文件"的那些，所以 110000 必须留下。
     */
    seedBackup('20260914-110000') // 真备份（唯一一份）
    seedBackup('20260914-120000', 0, false) // 较新，但不是备份
    seedBackup('20260914-130000', 0, false) // 更新，但不是备份

    const removed = pruneUpdateBackups(dataRoot, 1)

    expect(
      existsSync(join(updateBackupsRoot(dataRoot), '20260914-110000')),
      '唯一的真备份被删了 —— 空目录占掉了保留名额，用户失去最后退路'
    ).toBe(true)
    expect(removed, '不该删任何真备份').toEqual([])
  })

  it('★留 2 份时，第 3 份真备份才该被删', () => {
    seedBackup('20260914-100000')
    seedBackup('20260914-110000')
    seedBackup('20260914-120000')

    const removed = pruneUpdateBackups(dataRoot, 2)

    expect(removed).toEqual(['20260914-100000'])
    expect(readdirSync(updateBackupsRoot(dataRoot)).sort()).toEqual([
      '20260914-110000',
      '20260914-120000'
    ])
  })
})
