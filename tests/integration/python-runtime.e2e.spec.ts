// 真实落地内置 Python 3.12.10 并验证可执行（网络 + 解压 + site 打开）
import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { PYTHON_VERSION, PYTHON_SOURCES, pythonDirFor, pythonExeFor, enableEmbedSite, ensurePip } from '../../src/main/runtime/python-runtime'
import { testStage } from '../helpers/stage'

const root = testStage('mx-py-e2e-')

describe('内置 Python 端到端', () => {
  it('从镜像下载 3.12.10 embed 并解压成功', async () => {
    const dir = pythonDirFor(root)
    const zip = join(root, 'python.zip')

    let ok = false
    let lastErr = ''
    for (const url of PYTHON_SOURCES) {
      try {
        const r = await fetch(url)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const buf = Buffer.from(await r.arrayBuffer())
        writeFileSync(zip, buf)
        console.log('downloaded from', new URL(url).host, Math.round(buf.length / 1048576 * 10) / 10, 'MB')
        ok = true
        break
      } catch (e) {
        lastErr = String(e)
      }
    }
    expect(ok, `所有源都失败：${lastErr}`).toBe(true)

    const ex = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`], { timeout: 300000 })
    expect(ex.status).toBe(0)
    expect(existsSync(pythonExeFor(root))).toBe(true)
  }, 600000)

  it('打开 site 后能跑起来并报出 3.12', () => {
    const dir = pythonDirFor(root)
    enableEmbedSite(dir)
    const r = spawnSync(pythonExeFor(root), ['-c', 'import sys; print(sys.version)'], { encoding: 'utf8', timeout: 60000 })
    console.log('python version:', (r.stdout ?? '').trim().split('\n')[0])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('3.12')
  }, 120000)

  it('装上 pip 并能用', async () => {
    const dir = pythonDirFor(root)
    await ensurePip({
      dir,
      runPython: (args) => {
        const r = spawnSync(pythonExeFor(root), args, { encoding: 'utf8', timeout: 300000 })
        return { status: r.status, stdout: r.stdout, stderr: r.stderr }
      },
      onNote: (m) => console.log('  pip:', m)
    })
    const v = spawnSync(pythonExeFor(root), ['-m', 'pip', '--version'], { encoding: 'utf8', timeout: 120000 })
    console.log('pip:', (v.stdout ?? '').trim())
    expect(v.status).toBe(0)
    expect(v.stdout).toContain('pip')
  }, 900000)

  afterAll(() => rmSync(root, { recursive: true, force: true }))
})
