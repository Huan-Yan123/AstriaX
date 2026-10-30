import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { systemFetch } from '../update/network'
/* 解压 pip wheel 复用既有入口（内部处理了 PowerShell 引号转义） */
import { expandArchive } from '../util/async-exec'

/** 不受 CORS 约束的取文本（主进程专用；重定向跟随） */
export async function nodeGetText(url: string): Promise<string> {
  const r = await systemFetch(url, {
    headers: { 'User-Agent': 'AstriaX' },
    signal: AbortSignal.timeout(60000)
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return await r.text()
}

/**
 * 不受 CORS 约束的取二进制（主进程专用；重定向跟随）。
 *
 * 与 nodeGetText 同一套重定向/超时处理，区别只是**不按 utf8 解码** ——
 * wheel/zip 这类二进制按 utf8 读会损坏。
 */
export async function nodeGetBuffer(url: string): Promise<Buffer> {
  const r = await systemFetch(url, {
    headers: { 'User-Agent': 'AstriaX' },
    signal: AbortSignal.timeout(60000)
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

/** 内置 Python 版本：与 AstrBot 的 .python-version 对齐 */
export const PYTHON_VERSION = '3.12.10'

/**
 * 下载源顺序：**国内镜像在前，官方兜底**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 为什么把官方源挪到最后（用户反馈：「下载 Python 本体慢得要死」）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 原来是官方 `python.org` 排第一，国内镜像只是"兜底"。
 * 而下载逻辑是**逐个试、失败才切下一个** —— 所以国内用户实际在
 * 干等官方源慢吞吞地拉完（它不报错，只是慢，连"失败切换"都不会触发）。
 *
 * ## 实测数据（2026-10-18，拉 512KB 测真实吞吐，非 HEAD 延迟）
 *
 *   官方 python.org   14279 ms / 512KB = 0.04 MB/s   → 10.6MB 要约 265 秒
 *   华为云               95 ms / 512KB = 5.26 MB/s   → 10.6MB 约 2 秒
 *   npmmirror           156 ms / 512KB = 3.21 MB/s   → 约 3 秒
 *   阿里云              899 ms / 512KB = 0.56 MB/s   → 约 19 秒
 *
 * 两者相差 **130 倍**。这就是"慢得要死"的全部原因。
 *
 * ## 必须按**吞吐**排序，不能按 HEAD 延迟
 *
 * 实测踩到的坑：阿里云的 HEAD 响应最快（198ms），但真实下载吞吐
 * 只有 0.56 MB/s；而华为云 HEAD 是 246ms（略慢），吞吐却有 5.26 MB/s。
 * 只测响应头会得出**错误的优先级**，所以顺序按实拉数据来排。
 *
 * ## 全部为 https，官方源保留在最后
 *
 * 官方源不删：海外用户、或三个镜像同时不可用时，它仍是最终保障。
 * 前面三个都失败才会轮到它，所以放最后不影响可用性。
 */
export const PYTHON_SOURCES = [
  /* 5.26 MB/s —— 实测最快 */
  `https://mirrors.huaweicloud.com/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`,
  /* 3.21 MB/s */
  `https://npmmirror.com/mirrors/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`,
  /* 0.56 MB/s */
  `https://mirrors.aliyun.com/python-release/windows/python-${PYTHON_VERSION}-embed-amd64.zip`,
  /* 0.04 MB/s —— 官方兜底 */
  `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`
]

/**
 * get-pip.py 的下载源。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 为什么只剩官方一个源（2026-10-18 实测，v1.0.2 修复）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 原来第二个源是 `mirrors.aliyun.com/pypi/get-pip.py`，**它是有毒的**：
 * 那份是 2021 年的静态副本（1,908,226 字节，比官方小 322KB），
 * 内嵌 pip < 21.3，启动时要 `import distutils` —— 而 Python 3.12
 * 已按 PEP 632 **移除**该模块，于是它必然崩：
 *
 *     ModuleNotFoundError: No module named 'distutils'
 *
 * 后果（真实用户故障）：pip 装不上 → AstrBot 依赖全失败 →
 * 启动实例报 `No module named 'click'`。
 *
 * 对照实验（embed Python 3.12.10，A/B 两份脚本各自跑一遍）：
 *   阿里云那份 → 退出码 1，distutils 缺失，pip 不可用
 *   官方那份   → 退出码 0，装上 pip 26.2.1 ✓
 *
 * 另外实测：国内镜像**基本都不提供 get-pip.py**
 *（腾讯云/华为云/中科大 404，清华 403），所以没有可替代的国内源。
 *
 * ⚠ 官方源在国内很慢（实测单次下载 59.7 秒，接近 60 秒超时线），
 *   所以它**不再是首选** —— 首选是下面的「pip wheel 直装」，
 *   官方 get-pip 只作为最后的兜底。
 */
export const GET_PIP_URLS = ['https://bootstrap.pypa.io/get-pip.py']

/**
 * ══════════════════════════════════════════════════════════════════════════
 * pip wheel 直装 —— v1.0.2 起的**首选** pip 引导方式
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 为什么要有这条路
 *
 * get-pip.py 这条路有三个先天问题（全部实测确认）：
 *   1. 官方源在国内慢（59.7 秒），常撞超时
 *   2. 唯一的国内替代（阿里云）内嵌老 pip，在 3.12 上必然崩溃
 *   3. 它的兜底 `-m ensurepip` 在 embed 版上**根本不存在**
 *
 * 而 pip 本身就是个纯 Python 包 —— 直接下载它的 wheel、
 * 解压进 `Lib/site-packages` 就能用，**完全绕开**
 * get-pip / ensurepip / distutils 这三样东西。
 *
 * ## 实测效果（同一台机器、同一个 embed Python 3.12.10）
 *
 *   get-pip.py（官方）     59,700 ms，且依赖 distutils 能否可用
 *   pip wheel 直装          2,368 ms，不依赖任何东西
 *                              → 装上 pip 26.2.1，`pip install requests` 成功
 *
 * ## 为什么用索引页而不是固定 URL
 *
 * wheel 的直链里带 hash 路径（`/packages/f3/6e/…`），会随版本变，
 * 写死必失效。所以先取 simple 索引 HTML，再用正则挑出**版本最高**的
 * `py3-none-any` wheel —— 这是 PyPI 索引的标准格式，各镜像都一致。
 *
 * 三个源按"实测可达性"排：阿里云索引 242ms 可用，其余为兜底。
 */
export const PIP_WHEEL_INDEXES = [
  'https://mirrors.aliyun.com/pypi/web/simple/pip/',
  'https://mirrors.cloud.tencent.com/pypi/simple/pip/',
  'https://pypi.org/simple/pip/'
]

/**
 * 从 simple 索引 HTML 里挑出**版本最高**的 pip wheel 直链。
 *
 * 只认 `py3-none-any`（纯 Python，跨平台），排除 py2 / 平台专属的。
 * 返回绝对 URL；找不到返回 null。
 */
export function pickLatestPipWheel(html: string, baseUrl: string): string | null {
  const re = /href="([^"]*?pip-([0-9][0-9.]*?)-py3-none-any\.whl[^"]*)"/g
  let bestVer: number[] | null = null
  let bestUrl: string | null = null
  for (const m of html.matchAll(re)) {
    const ver = m[2].split('.').map((n) => Number(n) || 0)
    if (!bestVer || compareVersion(ver, bestVer) > 0) {
      const href = m[1].split('#')[0]
      bestVer = ver
      bestUrl = /^https?:/i.test(href) ? href : new URL(href, baseUrl).toString()
    }
  }
  return bestUrl
}

/** 版本号数组比较：a > b 返回正数 */
function compareVersion(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** 内置解释器目录：<dataRoot>/runtime/python */
export function pythonDirFor(dataRoot: string): string {
  return join(dataRoot, 'runtime', 'python')
}

export function pythonExeFor(dataRoot: string): string {
  return join(pythonDirFor(dataRoot), 'python.exe')
}

/**
 * embed 版默认带 `#import site`（注释掉），不打开就没法用 pip 装的包。
 * 打开它 + 保证 `.` 在搜索路径里。
 */
export function enableEmbedSite(dir: string): void {
  const candidates = ['python312._pth', 'python311._pth', 'python310._pth', 'python313._pth']
  for (const name of candidates) {
    const p = join(dir, name)
    if (!existsSync(p)) continue
    const raw = readFileSync(p, 'utf8')
    let next = raw.replace(/^#\s*import\s+site\s*$/m, 'import site')
    if (!/^import site\s*$/m.test(next)) next += '\nimport site\n'
    if (!/^\.$/m.test(next)) next = `.\n${next}`
    if (next !== raw) writeFileSync(p, next, 'utf8')
    return
  }
}

/**
 * 嵌入式 Python 的坑，一次说清（全部有实机报错为证）。
 *
 * 坑 1：包目录。
 * 只要目录里有 `._pth`，解释器就进**隔离模式**，**完全忽略 PYTHONPATH**
 * （实测：设了 PYTHONPATH 依然 ModuleNotFoundError）。
 * 而 AstrBot 是 pip --target 装进各版本目录的，必须让解释器认识那个目录。
 *
 * 坑 2：pywin32 在 `--target` 下是残缺的。
 * `pip install --target` **不会执行 post-install**，于是 pywin32 的
 * `pywin32.pth` 永远不会被解释器处理（`.pth` 只在 site-packages 里才生效）。
 * 那个 .pth 里做的三件事全都没人做：
 *     win32
 *     win32\lib
 *     pythonwin
 *     import pywin32_bootstrap
 * 缺了它们，AstrBot 启动到一半会炸：
 *     ModuleNotFoundError: No module named 'pywintypes'
 * 这个报错极具误导性 —— 包明明在，只是路径和 DLL 没接上，非常难自查。
 *
 * 修法就是在这里把上面四件事手工补上（实测顺序很重要）：
 *   - `<site>` 必须进 sys.path：`pywin32_system32` 是没有 __init__.py 的
 *     命名空间包，只有父目录在 path 上才 import 得到；
 *   - `<site>\win32` 进 path：`_win32sysloader.pyd` 在这里；
 *   - `<site>\win32\lib` 进 path：`pywintypes.py` / `pywin32_bootstrap.py` 在这里；
 *   - 最后跑 `import pywin32_bootstrap`，它负责把 pywin32_system32 里那两个
 *     DLL 目录注册进 Windows 的 DLL 搜索路径（os.add_dll_directory）。
 *
 * 用环境变量 MXBOT_SITE 而不是写死路径 —— 多开时每个实例指不同的版本目录。
 */
export function ensureSiteCustomize(dir: string): void {
  const sitePkg = join(dir, 'Lib', 'site-packages')
  mkdirSync(sitePkg, { recursive: true })
  const file = join(sitePkg, 'sitecustomize.py')
  const body = [
    '# 由 MX 机器人启动器生成：让内嵌 Python 找到 --target 装出来的包。',
    '# embed 版带 ._pth 时 PYTHONPATH 会被忽略，只能靠这里手动插 sys.path。',
    'import os, sys',
    '',
    '_p = os.environ.get("MXBOT_SITE")',
    'if _p and _p not in sys.path:',
    '    sys.path.insert(0, _p)',
    '',
    '# pywin32 在 --target 模式下不会跑 post-install，它的 .pth 永远不会生效。',
    '# 这里手工补上那个 .pth 本该做的事情，否则 AstrBot 会以',
    '# "No module named pywintypes" 启动失败（包在，只是路没接上）。',
    'if _p:',
    '    _sub = ("win32", os.path.join("win32", "lib"), "pythonwin")',
    '    for _s in _sub:',
    '        _d = os.path.join(_p, _s)',
    '        if os.path.isdir(_d) and _d not in sys.path:',
    '            sys.path.append(_d)',
    '    try:',
    '        import pywin32_bootstrap  # noqa: F401',
    '    except ImportError:',
    '        pass',
    ''
  ].join('\n')
  // 幂等：内容一致就不重复写
  if (existsSync(file)) {
    try {
      if (readFileSync(file, 'utf8') === body) return
    } catch {
      /* 读不了就重写 */
    }
  }
  writeFileSync(file, body, 'utf8')
}

export interface RunResult {
  status: number | null
  stdout?: string
  stderr?: string
}

/** 允许同步或异步执行器：真实环境跑异步（不堵主进程），测试里塞同步假实现 */
export type PythonRunner = (
  args: string[],
  opts?: { signal?: AbortSignal }
) => RunResult | Promise<RunResult>

/**
 * 判断这次失败是不是"embed 版没有 distutils"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 主人 2026-10-08 实测报错（内置 Python 装不上 pip）
 * ══════════════════════════════════════════════════════════════════════════
 *
 *     File "...get-pip.py", line 18, in <module>
 *       from pip._internal.cli.main import main as pip_entry_point
 *     File "...pip/_internal/cli/autocompletion.py", line 9, in <module>
 *     File "...pip/_internal/cli/main_parser.py", line 7, in <module>
 *     File "...pip/_internal/cli/cmdoptions.py", line 18, in <module>
 *   ModuleNotFoundError: No module named 'distutils'
 *
 * ## 根因
 *
 * Python **3.12 起官方把 distutils 从标准库里移除了**（PEP 632），
 * 而 Windows 的 **embed 版**连 `Lib/distutils` 这个目录都不带 ——
 * 它是"最小可运行"包，只保证解释器本身能跑。
 *
 * 偏偏 pip 的引导脚本（get-pip.py 里内嵌的那份 pip）在**导入阶段**就
 * 依赖 distutils（`cmdoptions.py` 那一条链），于是：
 *   解释器没问题 → get-pip.py 能启动 → 一 import pip 就炸 → pip 装不上
 *
 * 讽刺的是这个错发生在"装 pip"这一步，而 distutils 要靠 setuptools 提供 ——
 * 所以修法是**先用别的方式装上 setuptools**，它自带 distutils 的替代实现。
 *
 * ## 为什么用 ensurepip 而不是直接 pip install setuptools
 *
 * 此刻机器上**还没有 pip**（这正是要解决的问题），所以不能用 pip。
 * 但 Python 标准库自带 `ensurepip` 模块 —— 它用内嵌的 wheel 直接铺 pip，
 * **完全不碰 distutils**：
 *
 *     python -m ensurepip --upgrade
 *
 * 而 ensurepip 铺下来的 pip 是**较老但可用**的版本，能跑
 * `pip install setuptools` 把 distutils 补上，之后一切正常。
 *
 * 所以顺序是：get-pip 失败 → ensurepip 铺一个能用的 pip → 装 setuptools
 * → 再用新 pip。
 */
export function looksLikeMissingDistutils(text: string): boolean {
  return /No module named '?distutils'?/i.test(text)
}

/** 确保内置 Python 有可用的 pip（幂等：有就跳过，不重复下载） */
export async function ensurePip(deps: {
  dir: string
  probe?: () => boolean
  runPython: PythonRunner
  fetchText?: (url: string) => Promise<string>
  writeFile?: (path: string, content: string) => void
  /** 取二进制（wheel 用）。缺省走 nodeGetBuffer */
  fetchBinary?: (url: string) => Promise<Buffer>
  /** 写二进制（wheel 用）。缺省直接 writeFileSync */
  writeBinary?: (path: string, buf: Buffer) => void
  /** 解压 zip（wheel 用）。缺省走 async-exec 的 expandArchive */
  extract?: (zip: string, dest: string) => Promise<{ status: number | null }>
  onNote?: (msg: string) => void
  /** 取消信号：用户在界面上点「取消」时中断 pip 引导（否则点了没反应） */
  signal?: AbortSignal
}): Promise<void> {
  const hasPip = deps.probe
    ? deps.probe()
    : ((await deps.runPython(['-m', 'pip', '--version'], { signal: deps.signal })).status ?? 1) === 0
  if (hasPip) {
    deps.onNote?.('pip 已就绪')
    await ensureBuildTools(deps)
    return
  }

  const write = deps.writeFile ?? ((p: string, c: string) => writeFileSync(p, c, 'utf8'))
  const writeBin = deps.writeBinary ?? ((p: string, b: Buffer) => writeFileSync(p, b))
  // 取 get-pip.py / pip wheel 统一走 systemFetch（Electron net.fetch）：主进程无 CORS 限制，且跟随系统代理
  const fetcher = deps.fetchText ?? ((url: string) => nodeGetText(url))
  const fetcherBin = deps.fetchBinary ?? ((url: string) => nodeGetBuffer(url))
  const extractZip =
    deps.extract ?? ((zip: string, dest: string) => expandArchive(zip, dest, { signal: deps.signal }))

  /**
   * ★ 首选：直接解压 pip wheel 到 site-packages（v1.0.2 新增）。
   *
   * ## 为什么它是首选而不是 get-pip.py
   *
   * pip 本身就是纯 Python 包，wheel 解压进 `Lib/site-packages` 即可用。
   * 这条路**完全绕开** get-pip / ensurepip / distutils 三个脆弱点：
   *
   *   实测（embed Python 3.12.10，同一台机器）：
   *     get-pip.py（官方）   59,700 ms，且依赖 distutils 可用
   *     pip wheel 直装        2,368 ms，零依赖 → pip 26.2.1 可用
   *
   * ## 为什么先抓索引页再取 wheel
   *
   * wheel 直链带 hash 路径（`/packages/f3/6e/…`），写死必失效。
   * simple 索引 HTML 是 PyPI 标准格式，各镜像一致，正则挑版本最高的即可。
   */
  const installPipFromWheel = async (): Promise<boolean> => {
    const sitePackages = join(deps.dir, 'Lib', 'site-packages')
    for (const index of PIP_WHEEL_INDEXES) {
      try {
        deps.onNote?.(`获取 pip wheel 列表（${new URL(index).host}）`)
        const html = await fetcher(index)
        const wheelUrl = pickLatestPipWheel(html, index)
        if (!wheelUrl) continue
        deps.onNote?.('下载 pip wheel')
        const buf = await fetcherBin(wheelUrl)
        /*
         * ★ 必须存成 .zip 扩展名。
         *   wheel 本身就是 zip，但 Windows 的 Expand-Archive **只认 .zip**，
         *   传 .whl 会直接报「不是支持的存档文件格式」（实测踩过）。
         */
        const zipPath = join(deps.dir, 'pip-wheel.zip')
        writeBin(zipPath, buf)
        mkdirSync(sitePackages, { recursive: true })
        const ex = await extractZip(zipPath, sitePackages)
        if (ex.status !== 0) continue
        const check = await deps.runPython(['-m', 'pip', '--version'], { signal: deps.signal })
        if (check.status === 0) return true
      } catch {
        /* 这个索引不可用，换下一个 */
      }
    }
    return false
  }

  /**
   * 次选：用 ensurepip 铺 pip（见 looksLikeMissingDistutils 的说明）。
   *
   * ⚠ **必须先探测**：Windows embed 包不包含 ensurepip
   *（官方只保留最小运行时，省略了 ensurepip / tkinter / IDLE）。
   * 直接跑 `-m ensurepip` 必然失败还白等一轮 ——
   * 实测报 `ModuleNotFoundError: No module named 'ensurepip'`。
   */
  const tryEnsurePip = async (): Promise<boolean> => {
    const probe = await deps.runPython(['-c', 'import ensurepip'], { signal: deps.signal })
    if (probe.status !== 0) {
      deps.onNote?.('此 Python 不带 ensurepip（embed 版特性），跳过该兜底')
      return false
    }
    deps.onNote?.('改用 ensurepip 铺 pip（缺 distutils 时的兜底）')
    const r = await deps.runPython(['-m', 'ensurepip', '--upgrade'], { signal: deps.signal })
    if (r.status !== 0) return false
    /*
     * ★ 铺完立刻补 setuptools —— 它提供 distutils 的替代实现，
     *   不补的话"用 pip 装东西"依然会踩同一个坑（AstrBot 依赖里有源码包）。
     */
    deps.onNote?.('补装 setuptools（提供 distutils）')
    await deps.runPython(['-m', 'pip', 'install', '--no-warn-script-location', 'setuptools'], {
      signal: deps.signal
    })
    const check = await deps.runPython(['-m', 'pip', '--version'], { signal: deps.signal })
    return check.status === 0
  }

  let lastErr: unknown

  /* ── 第 1 顺位：pip wheel 直装 ────────────────────────────────────── */
  try {
    if (await installPipFromWheel()) {
      deps.onNote?.('pip 安装完成（wheel 直装）')
      await ensureBuildTools(deps)
      return
    }
  } catch (e) {
    lastErr = e
  }

  /* ── 第 2 顺位：get-pip.py（官方源，国内慢，仅作兜底）────────────── */
  for (const url of GET_PIP_URLS) {
    try {
      deps.onNote?.(`下载 pip 引导脚本（${new URL(url).host}）`)
      const content = await fetcher(url)
      const file = join(deps.dir, 'get-pip.py')
      write(file, content)
      const r = await deps.runPython([file, '--no-warn-script-location'], { signal: deps.signal })
      if (r.status !== 0) {
        /*
         * ★ 缺 distutils 是**可预期的**（Python 3.12 已移除该模块），
         *   不是"源坏了"——所以不要换下一个源重试（会白等一轮超时），
         *   直接走 ensurepip 兜底。
         */
        if (looksLikeMissingDistutils(`${r.stderr ?? ''}${r.stdout ?? ''}`)) {
          if (await tryEnsurePip()) {
            deps.onNote?.('pip 安装完成（经 ensurepip 兜底）')
            await ensureBuildTools(deps)
            return
          }
        }
        throw new Error(`执行 get-pip.py 失败：${r.stderr ?? ''}`)
      }
      const check = await deps.runPython(['-m', 'pip', '--version'], { signal: deps.signal })
      if (check.status !== 0) throw new Error('pip 安装后仍不可用')
      deps.onNote?.('pip 安装完成')
      await ensureBuildTools(deps)
      return
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`pip 安装失败：${String(lastErr)}`)
}

/*
 * pip 的镜像参数**不再硬编码**（主人 2026-09-26：AstrBot 单独做一个 Python 源）。
 *
 * 原来这里是：
 *     export const PIP_MIRROR_ARGS = ['-i', 'https://pypi.tuna.tsinghua.edu.cn/simple']
 * 问题有两个：
 *
 *   1. **界面显示与真实行为不一致**：下载页让用户给 AstrBot"选源"，
 *      而 pip 永远走这个写死的清华源 —— 用户选什么根本不影响安装。
 *
 *   2. **实测清华源已 403**（scripts/test-python-sources.py，2026-09-26）：
 *      索引 / 元数据 / 下载三项全部 403 Forbidden。
 *      继续用它意味着**所有 pip 安装都要先白等一次失败**才回落。
 *
 * 现在 pip 的参数由 `pythonSourceToPipArgs(源)` 现算（见 update/python-source.ts），
 * 调用方从用户选的源拿 indexUrl。这里只保留一个**默认值**以防万一。
 */
import { DEFAULT_PYTHON_SOURCE, pythonSourceToPipArgs } from '../update/python-source'

/** 默认 pip 源参数（调用方没给源时用；正常情况下都应由用户选的源决定） */
export const PIP_MIRROR_ARGS = pythonSourceToPipArgs(DEFAULT_PYTHON_SOURCE)

/**
 * 补构建工具：embed 版 Python 只有 pip，没有 setuptools/wheel。
 * AstrBot 依赖树里有源码包（sdist），缺 setuptools 会直接报
 * BackendUnavailable: Cannot import 'setuptools.build_meta'，装不下去。
 */
export async function ensureBuildTools(deps: {
  runPython: PythonRunner
  probe?: () => boolean
  onNote?: (msg: string) => void
  /** pip 源参数（跟随用户选择的 Python 源）；不传用默认源 */
  pipArgs?: string[]
  /** 取消信号：用户在界面上点「取消」时中断这一步（几十秒的长活） */
  signal?: AbortSignal
}): Promise<void> {
  const has = deps.probe
    ? deps.probe()
    : ((await deps.runPython(['-c', 'import setuptools, wheel'], { signal: deps.signal })).status ?? 1) === 0
  if (has) return
  deps.onNote?.('补构建工具 setuptools / wheel')
  /*
   * 源由调用方传入（跟随用户在「Python 源」里的选择）。
   *
   * 不传就走 PIP_MIRROR_ARGS（默认 = 内置第一个源，实测是 PyPI 官方）。
   * 注意：**绝不能**再硬编码清华源 —— 那个已实测 403，
   * 会让这一步每次都白等一轮失败（原来是写死的，属于"界面选什么都不影响"）。
   */
  const r = await deps.runPython([
    '-m',
    'pip',
    'install',
    '--no-warn-script-location',
    '--disable-pip-version-check',
    ...(deps.pipArgs ?? PIP_MIRROR_ARGS),
    'setuptools',
    'wheel'
  ], { signal: deps.signal })
  if (r.status !== 0) {
    // 装不上时不中断：后面装 AstrBot 时会给出更具体的报错
    deps.onNote?.(`构建工具安装未成功：${(r.stderr ?? '').slice(-160)}`)
  }
}

/** 给子进程用的环境变量：所有 python 调用都走内置解释器 */
export function pythonEnvFor(deps: { dataRoot: string; extra?: Record<string, string> }): Record<string, string> {
  const dir = pythonDirFor(deps.dataRoot)
  const exe = pythonExeFor(deps.dataRoot)
  const env: Record<string, string> = {
    ...(deps.extra ?? {}),
    MX_PYTHON: exe,
    PYTHONHOME: dir,
    PATH: `${dir};${deps.extra?.PATH ?? process.env.PATH ?? ''}`,
    /*
     * 强制 Python 的 stdio 走 UTF-8。
     *
     * 不设的后果（实测）：中文 Windows 的控制台默认 GBK，AstrBot 启动时
     * 想打一行带 ✨ 的欢迎语，直接炸：
     *   UnicodeEncodeError: 'gbk' codec can't encode character '\u2728'
     * 那不是普通的日志报错 —— 被炸掉的那一行里**正好有初始账号密码**
     * （Initial username / Initial password），用户就此拿不到凭据，登不上面板。
     * 而且它还会往 stderr 吐一大段 logging error，看着像崩了。
     *
     * 设 UTF-8 之后：Python 输出 UTF-8 字节，我们的日志管道本来也按 UTF-8 存，
     * 中文和 emoji 都能原样落到日志里。
     */
    PYTHONIOENCODING: 'utf-8',
    // 顺带让 Windows 下的文件系统调用也用 UTF-8 名称（AstrBot 会写中文文件名）
    PYTHONUTF8: '1'
  }
  // 不继承外部 PYTHONPATH：避免把系统解释器的包串进来
  delete env.PYTHONPATH
  return env
}

/** 找到可用的 python：内置优先，其次系统（返回 null 表示要提示用户下载） */
export function findPython(deps: {
  dataRoot: string
  systemPython?: string
  exists?: (p: string) => boolean
}): { exe: string; source: 'builtin' | 'system' } | null {
  const exists = deps.exists ?? existsSync
  const builtin = pythonExeFor(deps.dataRoot)
  if (exists(builtin)) return { exe: builtin, source: 'builtin' }
  // 系统解释器由调用方探测得到，存在性已由探测保证
  if (deps.systemPython) return { exe: deps.systemPython, source: 'system' }
  return null
}
