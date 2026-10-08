import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { gunzipSync, gzipSync } from 'zlib'
import { join } from 'path'
import { backupRuntime, restoreBackup, pruneBackups } from '../../src/main/update/backup'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('acb-bak-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * 造一份「实例数据」。
 * 注意这里**故意不造 runtime 目录**——真机上实例目录里也没有它，
 * 运行时代码在多版本改造后是同类实例共享的 runtimes\<type>\<tag>\。
 * 旧实现从这里找 runtime，所以每次备份都是 20 字节空包。
 */
function seedInstanceData(dir: string): void {
  mkdirSync(join(dir, 'data', 'config'), { recursive: true })
  writeFileSync(join(dir, 'data', 'config', 'astrbot_config.json'), '{"admin":{"password":"x"}}', 'utf8')
  writeFileSync(join(dir, 'data', 'astrbot.db'), 'sqlite-fake', 'utf8')
  mkdirSync(join(dir, 'config'), { recursive: true })
  writeFileSync(join(dir, 'config', 'onebot11_1.json'), '{"token":"t"}', 'utf8')
  writeFileSync(join(dir, 'instance.json'), '{"id":"x","runtimeTag":"v1"}', 'utf8')
}

describe('backupRuntime / restoreBackup（备份实例数据，不是共享运行时）', () => {
  it('备份产出 tar.gz + manifest，且校验 sha256 属性存在', async () => {
    const dir = join(root, 'inst1')
    seedInstanceData(dir)
    const bak = await backupRuntime({ dir, templateVersion: 1, stamp: () => '20260912-120000' })
    expect(bak.file).toContain('backups')
    expect(bak.file.endsWith('20260912-120000-v1.tar.gz')).toBe(true)
    expect(existsSync(bak.file)).toBe(true)
    expect(bak.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(existsSync(bak.file.replace(/\.tar\.gz$/, '.json'))).toBe(true)
  })

  it('【回归】实例目录里没有 runtime 时，备份必须仍然是有内容的（旧实现只出 20 字节空包）', async () => {
    const dir = join(root, 'inst-empty-rt')
    seedInstanceData(dir)
    expect(existsSync(join(dir, 'runtime'))).toBe(false)
    const bak = await backupRuntime({ dir, templateVersion: 1 })
    expect(statSync(bak.file).size).toBeGreaterThan(100)
    const mf = JSON.parse(readFileSync(bak.file.replace(/\.tar\.gz$/, '.json'), 'utf8')) as {
      scope?: string
      files?: number
    }
    expect(mf.scope).toBe('data')
    expect(mf.files).toBeGreaterThan(0)
  })

  it('备份不含 logs/tmp/backups 目录', async () => {
    const dir = join(root, 'inst2')
    seedInstanceData(dir)
    mkdirSync(join(dir, 'logs'), { recursive: true })
    writeFileSync(join(dir, 'logs', 'noise.txt'), 'noise', 'utf8')
    mkdirSync(join(dir, 'data', 'logs'), { recursive: true })
    writeFileSync(join(dir, 'data', 'logs', 'inner.txt'), 'noise', 'utf8')
    const bak = await backupRuntime({ dir, templateVersion: 1 })
    const gz = gunzipSync(readFileSync(bak.file))
    const text = gz.toString('utf8')
    expect(text).not.toContain('noise.txt')
    expect(text).not.toContain('inner.txt')
    expect(text).toContain('astrbot_config.json')
  })

  it('备份后改动数据 → 回滚恢复原内容（配置/数据库都在 data 下）', async () => {
    const dir = join(root, 'inst3')
    seedInstanceData(dir)
    const bak = await backupRuntime({ dir, templateVersion: 1 })
    writeFileSync(join(dir, 'data', 'config', 'astrbot_config.json'), '{"admin":{"password":"changed"}}', 'utf8')
    await restoreBackup({ dir, file: bak.file })
    const restored = readFileSync(join(dir, 'data', 'config', 'astrbot_config.json'), 'utf8')
    expect(restored).toBe('{"admin":{"password":"x"}}')
    expect(readFileSync(join(dir, 'data', 'astrbot.db'), 'utf8')).toBe('sqlite-fake')
    expect(readFileSync(join(dir, 'config', 'onebot11_1.json'), 'utf8')).toBe('{"token":"t"}')
  })

  it('回滚不会把实例元信息弄丢（instance.json 在备份里）', async () => {
    const dir = join(root, 'inst-meta')
    seedInstanceData(dir)
    const bak = await backupRuntime({ dir, templateVersion: 1 })
    rmSync(join(dir, 'instance.json'), { force: true })
    await restoreBackup({ dir, file: bak.file })
    expect(readFileSync(join(dir, 'instance.json'), 'utf8')).toContain('runtimeTag')
  })

  it('回滚旧格式备份（无 scope 标记）仍然还原到 runtime\\，保持向后兼容', async () => {
    const dir = join(root, 'inst-legacy')
    mkdirSync(join(dir, 'runtime', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'runtime', 'bin', 'python.exe'), 'legacy-py', 'utf8')
    // 手工造一份旧格式：rel 相对 runtime、manifest 无 scope
    const pairs: Array<[string, string]> = [['bin/python.exe', 'legacy-py']]
    const tar = Buffer.concat(
      pairs.map(([rel, body]) => {
        const r = Buffer.from(rel, 'utf8')
        const l = Buffer.alloc(4)
        l.writeUInt32LE(r.length)
        const d = Buffer.alloc(8)
        d.writeBigUInt64LE(BigInt(Buffer.byteLength(body)))
        return Buffer.concat([l, r, d, Buffer.from(body, 'utf8')])
      })
    )
    const backups = join(dir, 'backups')
    mkdirSync(backups, { recursive: true })
    const file = join(backups, '20260101000000-v1.tar.gz')
    writeFileSync(file, gzipSync(tar))
    writeFileSync(file.replace(/\.tar\.gz$/, '.json'), JSON.stringify({ files: 1 }), 'utf8')

    rmSync(join(dir, 'runtime'), { recursive: true, force: true })
    await restoreBackup({ dir, file })
    expect(readFileSync(join(dir, 'runtime', 'bin', 'python.exe'), 'utf8')).toBe('legacy-py')
  })

  it('pruneBackups 保留最近 keep 份', async () => {
    const dir = join(root, 'inst4')
    seedInstanceData(dir)
    const kept = new Set<string>()
    for (let i = 1; i <= 5; i++) {
      const bak = await backupRuntime({ dir, templateVersion: 1, stamp: () => `20260912-00000${i}` })
      if (i > 2) kept.add(bak.file)
    }
    const removed = pruneBackups({ dir, keep: 2 })
    expect(removed).toHaveLength(3)
    const after = readdirSync(join(dir, 'backups')).filter((f) => f.endsWith('.tar.gz'))
    expect(after).toHaveLength(2)
  })

  it('默认时间戳用本地时间且是 14 位数字（不出现 42:14 那种时刻、也不带多余的点）', async () => {
    const dir = join(root, 'inst5')
    seedInstanceData(dir)
    const bak = await backupRuntime({ dir, templateVersion: 1 })
    const name = bak.file.split(/[\\/]/).pop()!
    // 形如 20260912221434-v1.tar.gz
    const m = /^(\d{14})-v1\.tar\.gz$/.exec(name)
    expect(m, `文件名应恰好是 14 位本地时间戳，实际 ${name}`).not.toBeNull()
    const digits = m![1]
    const hh = Number(digits.slice(8, 10))
    const mm = Number(digits.slice(10, 12))
    const ss = Number(digits.slice(12, 14))
    expect(hh).toBeLessThan(24)
    expect(mm).toBeLessThan(60)
    expect(ss).toBeLessThan(60)
    // 本地时间的日期部分应当就是今天（UTC 会把东八区下午/晚上的记录退到前一天）
    const now = new Date()
    const ymd =
      `${now.getFullYear()}` +
      `${String(now.getMonth() + 1).padStart(2, '0')}` +
      `${String(now.getDate()).padStart(2, '0')}`
    expect(digits.slice(0, 8)).toBe(ymd)
    expect(name).not.toContain('.-v')
  })
})
