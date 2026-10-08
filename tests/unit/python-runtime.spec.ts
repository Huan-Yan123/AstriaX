import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  PYTHON_VERSION,
  PYTHON_SOURCES,
  pythonDirFor,
  pythonExeFor,
  enableEmbedSite,
  ensurePip,
  ensureSiteCustomize,
  pythonEnvFor,
  findPython
} from '../../src/main/runtime/python-runtime'
import { testStage } from '../helpers/stage'

let root: string

beforeEach(() => {
  root = testStage('mx-py-')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('内置 Python 3.12', () => {
  it('固定版本号与官方/国内镜像源', () => {
    expect(PYTHON_VERSION).toBe('3.12.10')
    expect(PYTHON_SOURCES.length).toBeGreaterThan(1)
    expect(PYTHON_SOURCES[0]).toContain('python-3.12.10-embed-amd64.zip')
    // 至少有一个国内镜像（python.org 在国内不稳）
    expect(PYTHON_SOURCES.some((u) => /huaweicloud|aliyun|npmmirror/.test(u))).toBe(true)
  })

  it('内置目录约定：runtime/python/', () => {
    expect(pythonDirFor(root)).toBe(join(root, 'runtime', 'python'))
    expect(pythonExeFor(root)).toBe(join(root, 'runtime', 'python', 'python.exe'))
  })

  it('embed 包默认禁 site，必须打开才能用 pip（改 ._pth 文件）', () => {
    const dir = pythonDirFor(root)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'python312._pth'), 'python312.zip\n.\n#import site\n', 'utf8')
    enableEmbedSite(dir)
    const patched = readFileSync(join(dir, 'python312._pth'), 'utf8')
    expect(patched).toContain('import site')
    expect(patched).not.toContain('#import site')
    // 幂等：再改一次不变样
    enableEmbedSite(dir)
    expect(readFileSync(join(dir, 'python312._pth'), 'utf8')).toBe(patched)
  })

  it('ensurePip：没有 pip 时下载 get-pip.py 并执行', async () => {
    const dir = pythonDirFor(root)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'python.exe'), 'fake', 'utf8')
    const ran: string[][] = []
    let pipInstalled = false
    await ensurePip({
      dir,
      runPython: (args) => {
        ran.push(args)
        const isPipProbe = args.join(' ').includes('pip --version')
        if (isPipProbe) return { status: pipInstalled ? 0 : 1, stdout: '', stderr: '' }
        // 执行 get-pip.py 视为装好了 pip
        if (args.some((a) => a.includes('get-pip.py'))) pipInstalled = true
        return { status: 0, stdout: '', stderr: '' }
      },
      fetchText: async () => '# get-pip content',
      writeFile: (p, c) => writeFileSync(p, c, 'utf8')
    })
    // 先执行 get-pip.py 装 pip
    expect(ran.some((a) => a.some((x) => x.includes('get-pip.py')))).toBe(true)
    // 再 --version 验证
    expect(ran.some((a) => a.join(' ').includes('pip --version'))).toBe(true)
  })

  it('★ embed 版缺 distutils：get-pip 报 ModuleNotFoundError 时必须自动补装并重试（主人 2026-10-08 实测）', async () => {
    const dir = pythonDirFor(root)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'python.exe'), 'fake', 'utf8')
    const ran: string[][] = []
    let pipInstalled = false
    /* 第一次跑 get-pip.py 会因缺 distutils 崩掉，这正是用户机器上的表现 */
    let distutilsFixed = false
    await ensurePip({
      dir,
      runPython: (args) => {
        ran.push(args)
        const joined = args.join(' ')
        if (joined.includes('pip --version')) {
          return { status: pipInstalled ? 0 : 1, stdout: '', stderr: '' }
        }
        // 补 distutils 的动作（装 setuptools）——做了它之后 pip 才能引导成功
        if (joined.includes('setuptools')) {
          distutilsFixed = true
          return { status: 0, stdout: '', stderr: '' }
        }
        if (args.some((a) => a.includes('get-pip.py'))) {
          if (!distutilsFixed) {
            return {
              status: 1,
              stdout: '',
              stderr: "ModuleNotFoundError: No module named 'distutils'"
            }
          }
          pipInstalled = true
          return { status: 0, stdout: '', stderr: '' }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
      fetchText: async () => '# get-pip content',
      writeFile: (p, c) => writeFileSync(p, c, 'utf8')
    })
    /* 关键断言：必须真的补过 distutils，而不是直接失败 */
    expect(
      ran.some((a) => a.join(' ').includes('setuptools')),
      '缺 distutils 时要装 setuptools 补上，否则 pip 永远装不了'
    ).toBe(true)
    expect(pipInstalled, '补上 distutils 后 get-pip 应能成功').toBe(true)
  })

  it('★ 已装 Python 时 ensurePip 接受取消信号（否则界面点取消没反应）', async () => {
    const dir = pythonDirFor(root)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'python.exe'), 'fake', 'utf8')
    const ac = new AbortController()
    let sawSignal = false
    await ensurePip({
      dir,
      signal: ac.signal,
      runPython: (_args, opts) => {
        if (opts?.signal) sawSignal = true
        return { status: 0, stdout: '', stderr: '' }
      },
      probe: () => false,
      fetchText: async () => '# get-pip content',
      writeFile: (p, c) => writeFileSync(p, c, 'utf8')
    })
    expect(sawSignal, 'runPython 必须拿到取消信号，否则取消按钮是死的').toBe(true)
  })

  it('已有 pip 时跳过安装（幂等，不重复下载）', async () => {
    const dir = pythonDirFor(root)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'python.exe'), 'fake', 'utf8')
    let fetched = 0
    await ensurePip({
      dir,
      probe: () => true, // 已装
      runPython: () => ({ status: 0, stdout: '', stderr: '' }),
      fetchText: async () => {
        fetched += 1
        return ''
      },
      writeFile: (p, c) => writeFileSync(p, c, 'utf8')
    })
    expect(fetched).toBe(0)
  })

  it('pythonEnvFor：把 AstrBot/NapCat 的 python 指向内置解释器', () => {
    const env = pythonEnvFor({ dataRoot: root, extra: { FOO: 'bar' } })
    expect(env.PATH?.split(';')[0]).toBe(pythonDirFor(root))
    expect(env.MX_PYTHON).toBe(pythonExeFor(root))
    expect(env.PYTHONHOME).toBe(pythonDirFor(root))
    expect(env.FOO).toBe('bar')
    // 不继承外部 PYTHONPATH，避免串到系统解释器
    expect(env.PYTHONPATH).toBeUndefined()
  })

  it('findPython：内置优先，没装则回落到系统 python', () => {
    // 未装内置 → 返回系统（探测注入）
    const sys = findPython({ dataRoot: root, systemPython: 'C:\\Python312\\python.exe', exists: () => false })
    expect(sys).toEqual({ exe: 'C:\\Python312\\python.exe', source: 'system' })

    // 装了内置 → 用内置
    const builtin = findPython({
      dataRoot: root,
      systemPython: 'C:\\Python312\\python.exe',
      exists: (p) => p === pythonExeFor(root)
    })
    expect(builtin).toEqual({ exe: pythonExeFor(root), source: 'builtin' })
  })

  it('findPython：都没有时返回 null（UI 提示去下载）', () => {
    expect(findPython({ dataRoot: root, systemPython: undefined, exists: () => false })).toBeNull()
  })

  it('ensureSiteCustomize：注入读 MXBOT_SITE 的钩子，并建出 site-packages', () => {
    const dir = pythonDirFor(root)
    mkdirSync(dir, { recursive: true })
    ensureSiteCustomize(dir)

    const f = join(dir, 'Lib', 'site-packages', 'sitecustomize.py')
    expect(existsSync(f)).toBe(true)
    const body = readFileSync(f, 'utf8')
    // 必须读 MXBOT_SITE（每个实例各指各的包目录）并插到 sys.path 最前
    expect(body).toContain('MXBOT_SITE')
    expect(body).toContain('sys.path.insert')
    // 说明为什么不能靠 PYTHONPATH，免得后人又改回去
    expect(body).toContain('PYTHONPATH')
  })

  it('ensureSiteCustomize：幂等，重复调用不改变内容', () => {
    const dir = pythonDirFor(root)
    mkdirSync(dir, { recursive: true })
    ensureSiteCustomize(dir)
    const f = join(dir, 'Lib', 'site-packages', 'sitecustomize.py')
    const first = readFileSync(f, 'utf8')
    ensureSiteCustomize(dir)
    expect(readFileSync(f, 'utf8')).toBe(first)
  })

  it('ensureSiteCustomize：内容被改坏时会重写回来', () => {
    const dir = pythonDirFor(root)
    mkdirSync(join(dir, 'Lib', 'site-packages'), { recursive: true })
    const f = join(dir, 'Lib', 'site-packages', 'sitecustomize.py')
    writeFileSync(f, 'print("被玩坏了")', 'utf8')
    ensureSiteCustomize(dir)
    expect(readFileSync(f, 'utf8')).toContain('MXBOT_SITE')
  })
})
