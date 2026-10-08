import { describe, it, expect } from 'vitest'
import { rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ensureDir, makeStage, pipEnvFor, pipCacheDirFor, tempDirFor, workDirFor, cleanStage } from '../../src/main/util/workdir'
import { testStage } from '../helpers/stage'

const root = testStage('mx-workdir-')

describe('工作目录：所有临时与缓存都落在 data 下，绝不碰 C 盘', () => {
  it('workDir / tempDir / pipCache 都在 data 目录里面', () => {
    const work = workDirFor(root)
    const temp = tempDirFor(root)
    const cache = pipCacheDirFor(root)
    expect(work.startsWith(root)).toBe(true)
    expect(temp.startsWith(root)).toBe(true)
    expect(cache.startsWith(root)).toBe(true)
    expect(work).toBe(join(root, 'cache'))
    expect(temp).toBe(join(root, 'cache', 'tmp'))
    expect(cache).toBe(join(root, 'cache', 'pip-cache'))
  })

  it('pipEnvFor 把 pip 缓存与临时目录都指向 data（这是吃掉 C 盘 6.8GB 的元凶）', () => {
    const env = pipEnvFor(root, { PATH: 'x' })
    expect(env.PIP_CACHE_DIR).toBe(pipCacheDirFor(root))
    expect(env.TMP).toBe(tempDirFor(root))
    expect(env.TEMP).toBe(tempDirFor(root))
    expect(env.TMPDIR).toBe(tempDirFor(root))
    // 原有环境变量不能被丢掉
    expect(env.PATH).toBe('x')
    // 目录要真的被建出来，否则 pip 会回落到默认位置
    expect(existsSync(pipCacheDirFor(root))).toBe(true)
    expect(existsSync(tempDirFor(root))).toBe(true)
    // 关键：一律不等于系统临时目录
    expect(env.TEMP).not.toBe(tmpdir())
    expect(env.TMP).not.toBe(tmpdir())
    // 且必须都在 dataRoot 里面
    expect(env.PIP_CACHE_DIR!.startsWith(root)).toBe(true)
    expect(env.TEMP!.startsWith(root)).toBe(true)
  })

  it('真实安装目录（E 盘那种）下算出来的路径也不含 AppData', () => {
    // 用主人实际的安装位置验证一遍：data 在 E 盘，缓存也必须跟着在 E 盘
    const eRoot = 'E:\\MX\\launcher-acb\\data'
    const env = pipEnvFor(eRoot)
    expect(env.PIP_CACHE_DIR).toBe('E:\\MX\\launcher-acb\\data\\cache\\pip-cache')
    expect(env.TEMP).toBe('E:\\MX\\launcher-acb\\data\\cache\\tmp')
    expect(env.PIP_CACHE_DIR).not.toContain('AppData')
    expect(env.TEMP).not.toContain('AppData')
  })

  it('makeStage 建在 data 下且可以干净删掉', () => {
    const stage = makeStage(root, 'rt')
    expect(stage.startsWith(tempDirFor(root))).toBe(true)
    expect(existsSync(stage)).toBe(true)
    cleanStage(stage)
    expect(existsSync(stage)).toBe(false)
  })

  it('cleanStage 对 undefined / 不存在的路径都不抛（退出流程不能因清理失败崩）', () => {
    expect(() => cleanStage(undefined)).not.toThrow()
    expect(() => cleanStage(join(root, '从来没有过的目录'))).not.toThrow()
  })

  it('ensureDir 幂等', () => {
    const d = join(root, 'a', 'b', 'c')
    expect(ensureDir(d)).toBe(d)
    expect(ensureDir(d)).toBe(d)
    expect(existsSync(d)).toBe(true)
  })
})

// 收尾清理
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})
