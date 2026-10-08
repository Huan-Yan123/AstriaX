/*
 * ★ 旧版本产出的备份，新代码还能不能回滚？（数据恢复路径的兼容性）
 *
 * ## 为什么必须有这条测试
 *
 * 审查指出：已发布版本（HEAD）算 sha256 用的是
 *     createHash('sha256').update(gz)          ← gzip **之后**的整包
 * 而本轮把它改成了
 *     createHash('sha256').update(bodyBuf)     ← gzip **之前**的正文
 *
 * 两条算法结果不同，而 manifest 里的字段名**还叫 sha256**（没改名），
 * 回滚侧照旧拿它比对 —— 于是用户在当前版本里做的每一个备份，
 * 升级后点"回滚"都会被判成"备份文件已损坏"并拒绝。
 * 那是**数据恢复路径**：等于把用户已有的保险作废。
 * 而且错误措辞（"文件已损坏"）会把用户和我们自己都指向错误方向 ——
 * 文件其实完好，是算法换了。
 *
 * 这条测试就用"旧算法"造一份备份，喂给新代码回滚。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { gzipSync } from 'zlib'
import { createHash } from 'crypto'
import { restoreBackup } from '../../src/main/update/backup'
import { testStage } from '../helpers/stage'

let root: string
let inst: string
beforeEach(() => {
  root = testStage('legacy-bak-')
  inst = join(root, 'inst')
  mkdirSync(join(inst, 'data'), { recursive: true })
  mkdirSync(join(inst, 'backups'), { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 复刻项目私有的极简 tar 条目格式 */
function tarEntry(rel: string, data: Buffer): Buffer {
  const relBuf = Buffer.from(rel, 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32LE(relBuf.length)
  const dlen = Buffer.alloc(8)
  dlen.writeBigUInt64LE(BigInt(data.length))
  return Buffer.concat([len, relBuf, dlen, data])
}

/** 用 **HEAD（已发布版本）的算法**造一个备份：sha256 算在 gzip 后的整包上 */
function makeLegacyBackup(): { file: string; sha: string } {
  const payload = JSON.stringify({ token: 'PRECIOUS-DATA' })
  writeFileSync(join(inst, 'data', 'cfg.json'), payload, 'utf8')

  const tarBuf = Buffer.concat([tarEntry('data/cfg.json', Buffer.from(payload, 'utf8'))])
  const gz = gzipSync(tarBuf)
  // ★ 旧算法：整包 gzip 之后算
  const sha = createHash('sha256').update(gz).digest('hex')

  const file = join(inst, 'backups', '20260101000000-v1.tar.gz')
  writeFileSync(file, gz)
  // 旧版 manifest 是**旁文件**
  writeFileSync(
    file.replace(/\.tar\.gz$/, '.json'),
    JSON.stringify(
      { createdAt: new Date().toISOString(), templateVersion: 1, sha256: sha, files: 1, scope: 'data' },
      null,
      2
    ),
    'utf8'
  )
  return { file, sha }
}

describe('★旧版本产出的备份必须仍能回滚（否则用户的保险被作废）', () => {
  /*
   * ★ 必须是 async（踩过的坑）
   *
   * `restoreBackup` 已经改成 async（内部有 fsp.readFile + gunzip 回调）。
   * 第一版这里写的是 `it('...', () => {...})` —— 用 `expect(() => restoreBackup(...)).not.toThrow()`
   * 测同步抛错。而 async 函数**永远不会同步抛**，那个断言恒真；
   * 紧接着的 `readFileSync` 就在回滚**还没完成时**读了文件，
   * 于是拿到旧内容、报"数据必须真的回来"失败。
   *
   * 这条测试的价值（守旧备份兼容）是真实的，但**写法必须 await**，
   * 否则它测的是空气。这正是"测了一个永远不会发生的形态"的又一例。
   */
  it('HEAD 算法产出的备份 → 新代码回滚必须成功', async () => {
    const { file } = makeLegacyBackup()
    // 改动数据，模拟"回滚前数据已经变了"
    writeFileSync(join(inst, 'data', 'cfg.json'), JSON.stringify({ token: 'CHANGED' }), 'utf8')

    expect(existsSync(file), '旧备份应已造好').toBe(true)

    /*
     * 这条断言就是全部意义：修复 sha256 算法时**不能**只改成新算法，
     * 必须同时兼容旧包。失败时抛的是"备份文件已损坏（校验和不匹配）"——
     * 而文件其实完好。
     */
    await expect(
      restoreBackup({ dir: inst, file }),
      '旧版备份被拒了 —— 用户在当前版本里做的每个备份升级后都无法回滚'
    ).resolves.toBeUndefined()

    const now = readFileSync(join(inst, 'data', 'cfg.json'), 'utf8')
    expect(now, '数据必须真的回来').toContain('PRECIOUS-DATA')
  })
})
