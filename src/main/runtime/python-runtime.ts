import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { get as httpsGet } from 'https'
import { get as httpGet } from 'http'

/** 不受 CORS 约束的取文本（主进程专用；重定向跟随） */
export function nodeGetText(url: string, depth = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    if (depth > 5) {
      reject(new Error('重定向过多'))
      return
    }
    const getter = url.startsWith('https:') ? httpsGet : httpGet
    const req = getter(url, { headers: { 'User-Agent': 'AstriaX' } }, (res) => {
      const code = res.statusCode ?? 0
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume()
        resolve(nodeGetText(new URL(res.headers.location, url).toString(), depth + 1))
        return
      }
      if (code !== 200) {
        res.resume()
        reject(new Error(`HTTP ${code}`))
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(60000, () => {
      req.destroy(new Error('请求超时'))
    })
  })
}

/** 内置 Python 版本：与 AstrBot 的 .python-version 对齐 */
export const PYTHON_VERSION = '3.12.10'

/** 下载源顺序：官方在前，国内镜像兜底（python.org 在国内经常拉不动） */
export const PYTHON_SOURCES = [
  `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`,
  `https://mirrors.huaweicloud.com/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`,
  `https://mirrors.aliyun.com/python-release/windows/python-${PYTHON_VERSION}-embed-amd64.zip`,
  `https://npmmirror.com/mirrors/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`
]

export const GET_PIP_URLS = ['https://bootstrap.pypa.io/get-pip.py', 'https://mirrors.aliyun.com/pypi/get-pip.py']

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
  // get-pip.py 用 Node https 取：主进程里 fetch 受 CSP/CORS 影响（渲染层同款环境），https 模块不受限
  const fetcher = deps.fetchText ?? ((url: string) => nodeGetText(url))

  /**
   * 用 ensurepip 兜底铺 pip（见 looksLikeMissingDistutils 的说明）。
   *
   * 为什么放在"get-pip 失败之后"而不是一上来就用它：
   * ensurepip 自带的 pip 版本**比较旧**（Python 3.12 的 ensurepip 给的是
   * pip 24.0 左右），而 get-pip.py 会装**当前最新**的 pip。
   * 优先拿新的，只在它跑不通时才退回旧的。
   */
  const tryEnsurePip = async (): Promise<boolean> => {
    deps.onNote?.('改用 ensurepip 铺 pip（embed 版缺 distutils 时的兜底）')
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
  for (const url of GET_PIP_URLS) {
    try {
      deps.onNote?.(`下载 pip 引导脚本（${new URL(url).host}）`)
      const content = await fetcher(url)
      const file = join(deps.dir, 'get-pip.py')
      write(file, content)
      const r = await deps.runPython([file, '--no-warn-script-location'], { signal: deps.signal })
      if (r.status !== 0) {
        /*
         * ★ embed 版缺 distutils 是**可预期的**情况（见函数上方那段），
         *   不是"源坏了"——所以不要换下一个 get-pip 源重试（会白等一轮超时），
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
