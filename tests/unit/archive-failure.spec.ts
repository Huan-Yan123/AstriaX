import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { expandArchive } from '../../src/main/util/async-exec'
import { importArchive } from '../../src/main/update/import-archive'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => { root = testStage('archive-failure-') })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe.skipIf(process.platform !== 'win32')('损坏压缩包不能被登记成已安装运行时', () => {
  it('PowerShell 解压错误必须返回非零退出码', async () => {
    const file = join(root, 'broken.zip')
    writeFileSync(file, 'not-a-zip')
    const result = await expandArchive(file, join(root, 'expanded'))
    expect(result.status).not.toBe(0)
  }, 20000)

  it('先前探测通过、解压时文件损坏，也不能生成运行时标记', async () => {
    const file = join(root, 'broken.zip')
    const dest = join(root, 'runtimes', 'a', 'v1.0.0')
    writeFileSync(file, 'not-a-zip')
    await expect(importArchive({
      dataRoot: root, file, type: 'a', destDir: dest,
      probe: { kind: 'a', version: '1.0.0', reason: '', entries: [], sizeBytes: 9, sha256: '' }
    })).rejects.toThrow(/解压/)
    expect(existsSync(join(dest, 'mxbot-runtime.json'))).toBe(false)
  }, 20000)
})
