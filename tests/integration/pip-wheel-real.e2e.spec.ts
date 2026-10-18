/**
 * 真实端到端验证：用**源码里真正的函数**装一次 pip。
 *
 * 与单测的区别：这里真的联网、真的解压、真的跑 python.exe -m pip --version。
 * 目的：证明 v1.0.2 的修复不是"测试通过"，而是**真的能用**。
 *
 * 前置：需要一个干净的 embed Python 目录（含 python.exe、._pth 已开 import site）。
 * 环境变量 REPRO_PY 指向它；没有就自动跳过（CI 里不该依赖外网）。
 */
import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { pickLatestPipWheel, PIP_WHEEL_INDEXES, nodeGetText, nodeGetBuffer } from '../../src/main/runtime/python-runtime'

const PY = process.env.REPRO_PY

describe.skipIf(!PY || !existsSync(join(PY ?? '', 'python.exe')))('真实安装 pip（需要 REPRO_PY）', () => {
  it('走 pip wheel 直装：找到最高版本、下载、解压、pip 可用', async () => {
    const py = PY as string
    let installed = false
    for (const idx of PIP_WHEEL_INDEXES) {
      try {
        const html = await nodeGetText(idx)
        const url = pickLatestPipWheel(html, idx)
        if (!url) continue
        const buf = await nodeGetBuffer(url)
        expect(buf.length, 'wheel 不该是空文件').toBeGreaterThan(100_000)
        const zip = join(py, 'pip-wheel.zip')
        writeFileSync(zip, buf)
        const sp = join(py, 'Lib', 'site-packages')
        mkdirSync(sp, { recursive: true })
        execFileSync(
          'powershell',
          ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${sp}' -Force`],
          { stdio: 'ignore' }
        )
        const out = execFileSync(join(py, 'python.exe'), ['-m', 'pip', '--version'], { encoding: 'utf8' })
        expect(out).toMatch(/pip \d+\.\d+/)
        expect(existsSync(join(sp, 'pip'))).toBe(true)
        installed = true
        break
      } catch {
        /* 换下一个索引 */
      }
    }
    expect(installed, '三个索引都试过仍装不上').toBe(true)
  }, 180_000)
})
