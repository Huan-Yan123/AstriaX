import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { listBackups, deleteBackup } from '../../src/main/update/backup-list'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('acb-blist-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('备份列表（backup:list 页面数据源）', () => {
  it('扫全部实例的 backups\\.tar.gz + manifest → 按时间倒序', () => {
    const repo = join(root, 'data', 'instances', 'AstrBot', 'a_x1')
    mkdirSync(join(repo, 'backups'), { recursive: true })
    writeFileSync(join(repo, 'backups', '20260912-120000-v1.tar.gz'), 'x', 'utf8')
    writeFileSync(join(repo, 'backups', '20260912-120000-v1.json'), JSON.stringify({ createdAt: '', templateVersion: 1, sha256: 'a', files: 1 }), 'utf8')
    writeFileSync(join(repo, 'backups', '20260911-090000-v1.tar.gz'), 'y', 'utf8')

    const out = listBackups({ dataRoot: join(root, 'data') })
    expect(out).toHaveLength(2)
    expect(out[0].stamp).toBe('20260912-120000')
    expect(out[0].instanceName).toBe('a_x1')
  })

  it('deleteBackup：删除 tar.gz 与 manifest', () => {
    const repo = join(root, 'data', 'instances', 'AstrBot', 'a_x1')
    mkdirSync(join(repo, 'backups'), { recursive: true })
    const f = join(repo, 'backups', 's-v1.tar.gz')
    writeFileSync(f, 'x', 'utf8')
    writeFileSync(f.replace('.tar.gz', '.json'), '{}', 'utf8')
    deleteBackup({ file: f })
    expect(existsSync(f)).toBe(false)
    expect(existsSync(f.replace('.tar.gz', '.json'))).toBe(false)
  })
})
