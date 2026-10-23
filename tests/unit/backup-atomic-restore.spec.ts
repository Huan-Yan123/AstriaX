import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { gzipSync } from 'zlib'
import { backupRuntime, restoreBackup } from '../../src/main/update/backup'
import { testStage } from '../helpers/stage'

const fault = vi.hoisted(() => ({ movingConfig: false, unreadable: false }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const renameSync = (from: string, to: string): void => {
    if (fault.movingConfig && basename(String(from)) === 'config' && String(to).includes('.deleted-')) {
      fault.movingConfig = false
      throw new Error('模拟 config 被占用，无法改名')
    }
    return actual.renameSync(from, to)
  }
  const promises = {
    ...actual.promises,
    readFile: (file: Parameters<typeof actual.promises.readFile>[0], ...options: unknown[]) => {
      if (fault.unreadable && basename(String(file)) === 'unreadable.db') return Promise.reject(new Error('文件被占用'))
      return Reflect.apply(actual.promises.readFile, actual.promises, [file, ...options])
    }
  }
  return {
    ...actual,
    default: { ...actual, renameSync, promises },
    promises,
    renameSync
  }
})

let root: string
beforeEach(() => { root = testStage('backup-transaction-'); fault.movingConfig = false; fault.unreadable = false })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function archive(rel: string, data: string): string {
  const name = Buffer.from(rel)
  const len = Buffer.alloc(4)
  len.writeUInt32LE(name.length)
  const bytes = Buffer.from(data)
  const size = Buffer.alloc(8)
  size.writeBigUInt64LE(BigInt(bytes.length))
  const file = join(root, 'bad.tar.gz')
  writeFileSync(file, gzipSync(Buffer.concat([len, name, size, bytes])))
  writeFileSync(file.replace('.tar.gz', '.json'), JSON.stringify({ scope: 'data' }))
  return file
}

describe('备份恢复：失败保留当前数据，空目录也能恢复', () => {
  it('文件读取失败时拒绝生成不完整的成功备份', async () => {
    mkdirSync(join(root, 'data'))
    writeFileSync(join(root, 'data', 'unreadable.db'), '重要数据')
    fault.unreadable = true
    await expect(backupRuntime({ dir: root, templateVersion: 1, stamp: () => 'read-failed' })).rejects.toThrow(/读取备份文件失败/)
    expect(existsSync(join(root, 'backups', 'read-failed-v1.tar.gz'))).toBe(false)
    expect(readFileSync(join(root, 'data', 'unreadable.db'), 'utf8')).toBe('重要数据')
  })

  it('目标实例目录已被删除时仍然可以从备份恢复', async () => {
    mkdirSync(join(root, 'data'))
    writeFileSync(join(root, 'data', 'restored.db'), '备份中的数据')
    const snapshot = await backupRuntime({ dir: root, templateVersion: 1 })
    const missing = join(root, 'missing-instance')
    await restoreBackup({ dir: missing, file: snapshot.file })
    expect(readFileSync(join(missing, 'data', 'restored.db'), 'utf8')).toBe('备份中的数据')
  })

  it('备份时为空的数据目录，恢复后应清掉后来新增的文件', async () => {
    mkdirSync(join(root, 'data'))
    const snapshot = await backupRuntime({ dir: root, templateVersion: 1 })
    writeFileSync(join(root, 'data', 'later.db'), '后来新增')
    await restoreBackup({ dir: root, file: snapshot.file })
    expect(existsSync(join(root, 'data'))).toBe(true)
    expect(existsSync(join(root, 'data', 'later.db'))).toBe(false)
  })

  it('归档中的非法文件名必须在移动当前数据之前被拒绝', async () => {
    mkdirSync(join(root, 'data'))
    writeFileSync(join(root, 'data', 'current.db'), '当前可用数据')
    const file = archive('data/illegal<name.db', '坏条目')
    await expect(restoreBackup({ dir: root, file })).rejects.toThrow()
    expect(readFileSync(join(root, 'data', 'current.db'), 'utf8')).toBe('当前可用数据')
  })

  it('第二个目录替换失败时，已替换的第一个目录自动恢复到操作前', async () => {
    mkdirSync(join(root, 'data'))
    mkdirSync(join(root, 'config'))
    writeFileSync(join(root, 'data', 'current.db'), '旧备份')
    writeFileSync(join(root, 'config', 'settings.json'), '旧配置')
    const snapshot = await backupRuntime({ dir: root, templateVersion: 1 })
    writeFileSync(join(root, 'data', 'current.db'), '当前可用数据')
    writeFileSync(join(root, 'config', 'settings.json'), '当前可用配置')
    fault.movingConfig = true
    await expect(restoreBackup({ dir: root, file: snapshot.file })).rejects.toThrow()
    expect(readFileSync(join(root, 'data', 'current.db'), 'utf8')).toBe('当前可用数据')
    expect(readFileSync(join(root, 'config', 'settings.json'), 'utf8')).toBe('当前可用配置')
  })

  it.each(['data/../instance.json', 'data/file:stream', 'backups/overwrite.tar.gz'])('拒绝非规范路径或非数据范围：%s', async (rel) => {
    const file = archive(rel, '不可信条目')
    await expect(restoreBackup({ dir: root, file })).rejects.toThrow()
  })
})
