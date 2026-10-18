import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  PYTHON_VERSION,
  PYTHON_SOURCES,
  GET_PIP_URLS,
  pickLatestPipWheel,
  pythonDirFor,
  pythonExeFor,
  enableEmbedSite,
  ensurePip,
  ensureSiteCustomize,
  pythonEnvFor,
  findPython
} from '../../src/main/runtime/python-runtime'
import { isPythonReady, isPythonUsable } from '../../src/main/runtime/layout'
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

  it('★ 缺 distutils 时走 ensurepip 兜底（非 embed 环境）', async () => {
    /*
     * 这条覆盖"ensurepip **可用**"的环境（普通安装版 Python）。
     * embed 版没有 ensurepip，那条路由「pip wheel 直装」负责 —— 见下一个用例。
     */
    const dir = pythonDirFor(root)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'python.exe'), 'fake', 'utf8')
    const ran: string[][] = []
    let pipInstalled = false
    await ensurePip({
      dir,
      runPython: (args) => {
        ran.push(args)
        const joined = args.join(' ')
        if (joined.includes('pip --version')) {
          return { status: pipInstalled ? 0 : 1, stdout: '', stderr: '' }
        }
        /* ensurepip 可用 */
        if (joined.includes('import ensurepip')) return { status: 0, stdout: '', stderr: '' }
        /* ensurepip 把 pip 铺好 */
        if (joined.includes('-m ensurepip')) {
          pipInstalled = true
          return { status: 0, stdout: '', stderr: '' }
        }
        if (joined.includes('setuptools')) return { status: 0, stdout: '', stderr: '' }
        /* get-pip.py 因缺 distutils 崩掉，这正是故障现场的表现 */
        if (args.some((a) => a.includes('get-pip.py'))) {
          return {
            status: 1,
            stdout: '',
            stderr: "ModuleNotFoundError: No module named 'distutils'"
          }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
      fetchText: async () => '# get-pip content',
      writeFile: (p, c) => writeFileSync(p, c, 'utf8')
    })
    expect(
      ran.some((a) => a.join(' ').includes('setuptools')),
      '铺完 pip 要补 setuptools（提供 distutils），否则装源码包仍会失败'
    ).toBe(true)
    expect(pipInstalled, '经 ensurepip 兜底后 pip 应可用').toBe(true)
  })

  it('★★ 首选 pip wheel 直装：不依赖 get-pip / ensurepip / distutils（v1.0.2 核心修复）', async () => {
    /*
     * 这是本次发布的关键修复。embed Python 3.12 上：
     *   · get-pip.py（官方）要 59.7 秒，且依赖 distutils
     *   · ensurepip 根本不存在
     *   · 阿里云的 get-pip.py 内嵌老 pip，必然崩
     *
     * 而 pip 是纯 Python 包 —— 直接下 wheel 解压进 site-packages 就能用。
     * 本用例断言：这条路由优先走，且成功后**不再**去碰 get-pip.py。
     */
    const dir = pythonDirFor(root)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'python.exe'), 'fake', 'utf8')
    let pipInstalled = false
    let ranGetPip = false
    const extracted: string[] = []
    await ensurePip({
      dir,
      runPython: (args) => {
        const joined = args.join(' ')
        if (joined.includes('pip --version')) {
          return { status: pipInstalled ? 0 : 1, stdout: '', stderr: '' }
        }
        if (args.some((a) => a.includes('get-pip.py'))) {
          ranGetPip = true
          return { status: 1, stdout: '', stderr: '不该走到这里' }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
      /* 索引页里放两个 wheel：必须挑出版本更高的那个 */
      fetchText: async () =>
        '<a href="../../packages/cc/dd/pip-9.0.3-py3-none-any.whl">old</a>' +
        '<a href="../../packages/aa/bb/pip-26.2.1-py3-none-any.whl#sha256=x">new</a>',
      fetchBinary: async () => Buffer.from('PK\u0003\u0004fake'),
      writeBinary: () => {},
      extract: (_zip, dest) => {
        extracted.push(dest)
        pipInstalled = true
        return Promise.resolve({ status: 0 })
      },
      writeFile: (p, c) => writeFileSync(p, c, 'utf8')
    })
    expect(extracted.length, '应该走 wheel 直装').toBeGreaterThan(0)
    expect(extracted[0], 'wheel 要解压进 Lib/site-packages').toContain('site-packages')
    expect(ranGetPip, 'wheel 直装成功就不该再下 get-pip.py').toBe(false)
    expect(pipInstalled).toBe(true)
  })

  it('pickLatestPipWheel：只认 py3-none-any，且取版本最高的那个', () => {
    const html =
      '<a href="../../packages/1/pip-9.0.3-py2.py3-none-any.whl">a</a>' +
      '<a href="../../packages/2/pip-21.0-py3-none-any.whl">b</a>' +
      '<a href="../../packages/3/pip-26.2.1-py3-none-any.whl#sha256=zz">c</a>' +
      '<a href="https://cdn.example.com/packages/4/pip-27.0-py3-none-any.whl">d</a>'
    const got = pickLatestPipWheel(html, 'https://mirror.example.com/pypi/simple/pip/')
    expect(got, '要挑出 27.0 而不是列表最后一个').toBe(
      'https://cdn.example.com/packages/4/pip-27.0-py3-none-any.whl'
    )
    /* 相对链接要拼成绝对地址 */
    const rel = pickLatestPipWheel('<a href="../../packages/3/pip-26.2.1-py3-none-any.whl">c</a>',
      'https://mirror.example.com/pypi/simple/pip/')
    expect(rel).toBe('https://mirror.example.com/pypi/packages/3/pip-26.2.1-py3-none-any.whl')
    expect(pickLatestPipWheel('no wheel here', 'https://x/')).toBeNull()
  })

  it('★ get-pip 源不能含"内嵌老 pip"的镜像（阿里云那份依赖 distutils，3.12 已移除）', () => {
    /*
     * 实测（2026-10-18，embed Python 3.12.10 对照实验）：
     *
     *   mirrors.aliyun.com/pypi/get-pip.py  → 退出码 1
     *       ModuleNotFoundError: No module named 'distutils'
     *       （pip 装不上 → 后续 AstrBot 依赖全失败 → No module named 'click'）
     *   bootstrap.pypa.io/get-pip.py        → 退出码 0，装上 pip 26.2.1
     *
     * 阿里云那份是**2021 年的静态副本**（1,908,226 字节，比官方小 322KB），
     * 内嵌 pip < 21.3，启动时要 `import distutils` —— 而 Python 3.12
     * 已按 PEP 632 移除该模块，于是必然崩溃。
     *
     * 留着它的后果：官方源一旦下载失败（国内很常见），就会切到它，
     * 然后不管重试多少次都装不上 pip。
     */
    expect(
      GET_PIP_URLS.some((u) => u.includes('mirrors.aliyun.com')),
      '阿里云的 get-pip.py 内嵌老 pip，会让 3.12 embed 永远装不上 pip'
    ).toBe(false)
  })

  it('★ embed 版没有 ensurepip：探测到缺失就不该再去跑 -m ensurepip', async () => {
    /*
     * Windows embed 包**不包含 ensurepip**（官方只保留最小运行时，
     * 省略了 ensurepip / tkinter / IDLE）。实测：
     *     python.exe -c "import ensurepip" → ModuleNotFoundError
     *
     * 原来的兜底直接跑 `-m ensurepip --upgrade`，必然失败还白等一轮。
     * 正确做法是先探测，确认不可用就立刻放弃这条路。
     */
    const dir = pythonDirFor(root)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'python.exe'), 'fake', 'utf8')
    const ran: string[][] = []
    await expect(
      ensurePip({
        dir,
        runPython: (args) => {
          ran.push(args)
          const joined = args.join(' ')
          if (joined.includes('pip --version')) return { status: 1, stdout: '', stderr: '' }
          /* 探测 ensurepip：embed 版必然失败 */
          if (joined.includes('import ensurepip')) {
            return { status: 1, stdout: '', stderr: "ModuleNotFoundError: No module named 'ensurepip'" }
          }
          /* get-pip.py 因缺 distutils 崩掉（老 pip 的特征） */
          if (args.some((a) => a.includes('get-pip.py'))) {
            return { status: 1, stdout: '', stderr: "ModuleNotFoundError: No module named 'distutils'" }
          }
          return { status: 0, stdout: '', stderr: '' }
        },
        fetchText: async () => '# get-pip content',
        writeFile: (p, c) => writeFileSync(p, c, 'utf8')
      })
    ).rejects.toThrow()
    expect(
      ran.some((a) => a.join(' ').includes('-m ensurepip')),
      'ensurepip 不存在时不该真去执行它，那是必然失败的一轮'
    ).toBe(false)
  })

  it('★ isPythonUsable 不能只看 python.exe（半成品会被误判成可用）', () => {
    /*
     * 故障现场：get-pip 失败但 python.exe 已经解压到位。
     * 旧代码只查 python.exe，于是"安装 Python"第二次点击直接返回成功
     *（假成功），界面显示已装好，实际 pip/setuptools/wheel 全缺 ——
     * 之后装 AstrBot 依赖、启动实例全部失败，且看不出真实原因。
     *
     * v1.0.2 拆成两个判据：
     *   isPythonReady  —— 解释器就绪（宽松；既有语义与测试夹具依赖它）
     *   isPythonUsable —— 真能用（解释器 + pip）；凡是"接下来要用 pip"
     *                     的决策点（建实例 / 装 Python）都用它
     */
    const dir = pythonDirFor(root)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'python.exe'), 'fake', 'utf8')
    expect(isPythonReady(root), 'isPythonReady 的语义就是"解释器在不在"').toBe(true)
    expect(isPythonUsable(root), '只有解释器、没有 pip 的半成品不该判成可用').toBe(false)
    /* 补上 pip 之后才算真能用 */
    mkdirSync(join(dir, 'Lib', 'site-packages', 'pip'), { recursive: true })
    expect(isPythonUsable(root)).toBe(true)
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
