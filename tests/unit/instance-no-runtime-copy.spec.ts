import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildHandlers } from '../../src/main/ipc'
import { createProcessManager } from '../../src/main/proc/process-manager'
import { mkdirSync, writeFileSync } from 'fs'
import { testStage } from '../helpers/stage'

/**
 * 建实例**不该**复制运行时 —— 这条用真实 handler 链路量一遍。
 *
 * 为什么值得单独测：这个 bug 白吃几百 MB，而且不报错、不崩，
 * 只在用户的磁盘上默默膨胀，非常难发现。
 *
 * 实测过的事实（2026-09-13）：
 *   AstrBot v4.28.0 运行时  565.4 MB / 49133 个文件
 *   NapCat  v4.18.19 运行时  90.1 MB /   692 个文件
 * 旧行为下建一个 AstrBot 实例就复制 565 MB，建 5 个实例 2.8 GB。
 *
 * 而启动时读的是共享运行时目录（ipc.ts defaultCommandFor 里
 * `src = store.dirFor(rec.type, tag)`），那份副本**没有任何代码读**。
 * 实测也证明不需要：NapCat 用完全空的工作目录能正常启动。
 */

/** 造一个"装着大文件"的假运行时，模拟真实体量 */
function seedBigRuntime(root: string, type: 'a' | 'n', tag: string): void {
  const dir = join(root, 'runtimes', type, tag)
  mkdirSync(dir, { recursive: true })
  if (type === 'a') {
    // AstrBot：astrbot 包 + 我们的 pypi 标记
    mkdirSync(join(dir, 'astrbot'), { recursive: true })
    writeFileSync(join(dir, 'astrbot', '__init__.py'), '__version__ = "4.28.0"', 'utf8')
    writeFileSync(join(dir, 'mxbot-runtime.json'), JSON.stringify({ tag, kind: 'pypi' }), 'utf8')
    // 模拟真实的大文件（真实运行时 565 MB）
    writeFileSync(join(dir, 'astrbot', 'big-model.bin'), Buffer.alloc(8 * 1024 * 1024))
  } else {
    // NapCat：注入器 + napcat.mjs
    writeFileSync(join(dir, 'napcat.mjs'), Buffer.alloc(8 * 1024 * 1024))
    writeFileSync(join(dir, 'NapCatWinBootMain.exe'), 'MZ', 'utf8')
    writeFileSync(join(dir, 'NapCatWinBootHook.dll'), 'MZ', 'utf8')
    writeFileSync(join(dir, 'qqnt.json'), '{}', 'utf8')
    writeFileSync(join(dir, 'mxbot-runtime.json'), JSON.stringify({ tag, kind: 'node' }), 'utf8')
  }
  // 运行时登记（instance:create 要求 store.list 非空）
  writeFileSync(
    join(root, 'runtimes', type, 'installed.json'),
    JSON.stringify({ [tag]: { tag, from: 'test', installedAt: Date.now() } }),
    'utf8'
  )
}

function dirSize(p: string): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  const walk = (d: string): void => {
    if (!existsSync(d)) return
    for (const n of readdirSync(d)) {
      const f = join(d, n)
      const st = statSync(f)
      if (st.isDirectory()) walk(f)
      else {
        bytes += st.size
        files++
      }
    }
  }
  walk(p)
  return { bytes, files }
}

describe('建实例不复制运行时（省磁盘）', () => {
  let root = ''
  beforeEach(() => {
    root = testStage('inst-nocopy-')
  })
  afterEach(() => {
    /* 保留现场便于排查；stage 在 data 下，不占 C 盘 */
  })

  it('AstrBot 实例目录不含运行时大文件', async () => {
    seedBigRuntime(root, 'a', 'v4.28.0')
    // AstrBot 还要求内置 Python 就绪
    mkdirSync(join(root, 'runtime', 'python'), { recursive: true })
    writeFileSync(join(root, 'runtime', 'python', 'python.exe'), '', 'utf8')

    const h = buildHandlers({ probe: async () => true, processManager: createProcessManager() })
    await h['config:set']({ dataRoot: root })
    const rec = (await h['instance:create']({ type: 'a', name: '省磁盘测试' })) as {
      id: string
      dir: string
    }

    const inst = dirSize(rec.dir)
    const rt = dirSize(join(root, 'runtimes', 'a', 'v4.28.0'))

    // 运行时确实有 8MB 大文件（否则这个测试没意义）
    expect(rt.bytes).toBeGreaterThan(8 * 1024 * 1024)

    // 实例目录不该含有那份大文件
    expect(
      existsSync(join(rec.dir, 'astrbot', 'big-model.bin')),
      '运行时的大文件被复制进实例目录了 —— 这是白占磁盘的 bug'
    ).toBe(false)
    expect(existsSync(join(rec.dir, 'astrbot'))).toBe(false)

    // 实例目录应该很小（骨架 + 标记而已）
    expect(
      inst.bytes,
      `实例目录 ${inst.bytes} 字节 / ${inst.files} 文件，应该只有骨架`
    ).toBeLessThan(64 * 1024)

    // 但仍然要是可识别的实例（有 meta）
    expect(existsSync(join(rec.dir, 'instance.json'))).toBe(true)
  })

  it('NapCat 实例目录不含 napcat.mjs 等运行时文件', async () => {
    seedBigRuntime(root, 'n', 'v4.18.19')
    const h = buildHandlers({ probe: async () => true, processManager: createProcessManager() })
    await h['config:set']({ dataRoot: root })
    const rec = (await h['instance:create']({ type: 'n', name: '省磁盘测试N' })) as {
      id: string
      dir: string
    }

    const inst = dirSize(rec.dir)
    const rt = dirSize(join(root, 'runtimes', 'n', 'v4.18.19'))
    expect(rt.bytes).toBeGreaterThan(8 * 1024 * 1024)

    expect(existsSync(join(rec.dir, 'napcat.mjs'))).toBe(false)
    expect(existsSync(join(rec.dir, 'NapCatWinBootMain.exe'))).toBe(false)
    expect(inst.bytes).toBeLessThan(64 * 1024)
  })
})
