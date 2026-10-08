import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { checkForUpdate, runUpdate } from '../../src/main/update/updater'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('acb-upd-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const payload = 'TEMPLATE-PAYLOAD'
const payloadSha = createHash('sha256').update(payload).digest('hex')

const fakeTgz = (dir: string): string => {
  mkdirSync(join(dir, 'astrbot'), { recursive: true })
  writeFileSync(join(dir, 'astrbot', 'main.py'), payload, 'utf8')
  writeFileSync(join(dir, 'astrbot', '.mx-ready'), 'template', 'utf8')
  writeFileSync(join(dir, 'astrbot', 'manifest.json'), JSON.stringify({ version: 2 }), 'utf8')
  return join(dir, 'astrbot')
}

describe('checkForUpdate / runUpdate', () => {
  it('checkForUpdate：manifest 版本高于当前模板 → 有更新', async () => {
    const r = await checkForUpdate({
      currentVersion: 1,
      fetch: async () => JSON.stringify({ version: 2, sha256: payloadSha, url: 'http://m/dist.zip' })
    })
    expect(r.hasUpdate).toBe(true)
    expect(r.manifest.version).toBe(2)
    const same = await checkForUpdate({ currentVersion: 2, fetch: async () => '{}' })
    expect(same.hasUpdate).toBe(false)
  })

  it('runUpdate：下载→校验→备份→换 runtime→版本前进；坏 SHA → 抛错不改动', async () => {
    const instDir = join(root, 'inst')
    const rt = join(instDir, 'runtime')
    mkdirSync(rt, { recursive: true })
    writeFileSync(join(rt, 'old.txt'), 'old', 'utf8')

    const stage = (stageDir: string): string => {
      mkdirSync(join(stageDir, 'runtime'), { recursive: true })
      writeFileSync(join(stageDir, 'runtime', 'main.py'), payload, 'utf8')
      return stageDir
    }
    const fetchManifest = async () => JSON.stringify({ version: 2, sha256: payloadSha, url: 'http://m/dist' })

    const ok = await runUpdate({
      dir: instDir,
      currentTemplateVersion: 1,
      fetchManifest,
      fetchAsset: async () => Buffer.from(payload),
      stageDirectory: stage,
      stamp: () => '20260912-120000'
    })
    expect(ok.newVersion).toBe(2)
    expect(existsSync(join(rt, 'main.py'))).toBe(true)
    expect(existsSync(join(rt, 'old.txt'))).toBe(false) // 换血覆盖
    expect(existsSync(join(instDir, 'backups'))).toBe(true) // 更新前备份落了

    // 坏 SHA 整体不落地
    const inst2 = join(root, 'inst2')
    mkdirSync(join(inst2, 'runtime'), { recursive: true })
    await expect(
      runUpdate({
        dir: inst2,
        currentTemplateVersion: 1,
        fetchManifest: async () => JSON.stringify({ version: 9, sha256: 'deadbeef', url: 'http://m/x' }),
        fetchAsset: async () => Buffer.from(payload),
        stageDirectory: stage
      })
    ).rejects.toThrow(/校验失败/)
    expect(existsSync(join(inst2, 'runtime', 'main.py'))).toBe(false)
  })
})
