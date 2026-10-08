/*
 * @vitest-environment node
 *
 * 这个文件**真的要联网**（探测官方源 / 下载真实资产 / 跑真进程装包）。
 * vitest.config.ts 全局是 happy-dom，而 happy-dom 的 fetch 会做同源检查、
 * 且不认 Access-Control-Allow-Origin —— 于是这些用例会以
 * "Cross-Origin Request Blocked" 失败，而生产里根本没这个问题
 *（主进程走 Node fetch，不受同源策略约束）。
 *
 * 所以显式声明 node 环境：**需要真实网络的测试就该跑在 node 环境**。
 */
// 真实全链路：内置 Python → PyPI 装 AstrBot → 识别 → import 成功
//
// 这个文件盯的是「AstrBot 到底能不能跑起来」，全部用真进程验证，不 mock。
// 它替我们抓到过三个真 bug（见下面各处注释），每一个都足以让 AstrBot 完全起不来。
import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { createRuntimeStore } from '../../src/main/update/runtime-store'
import { listAstrbotPypiVersions } from '../../src/main/update/version-catalog'
import {
  PYTHON_SOURCES,
  pythonDirFor,
  pythonExeFor,
  enableEmbedSite,
  ensurePip,
  ensureSiteCustomize
} from '../../src/main/runtime/python-runtime'
import { detectLayout, resolveLaunchSpec, readRuntimeKind } from '../../src/main/runtime/layout'
import { cleanStage, makeStage, pipEnvFor } from '../../src/main/util/workdir'

// 暂存放 E 盘项目的 data\cache\tmp 下，不用系统临时目录（别占 C 盘）
const root = makeStage(join(process.cwd(), 'data'), 'pypi-e2e')
const pyDir = pythonDirFor(root)
const pyExe = pythonExeFor(root)

/*
 * 复用已经在 data 下装好的 Python + AstrBot。
 *
 * 为什么：这个 e2e 的真实 pip 安装实测要 250 秒（200+ 个依赖），
 * 而它的价值是「证明这条链路真的通」，不是「每次都重下一遍 PyPI」。
 * 复用之后同样能验证包能加载、入口对不对、pywin32 接不接得上。
 * 本机没装过时自动退回完整流程（那时仍会真装）。
 */
const REAL_ROOT = join(process.cwd(), 'data')
const REAL_PY = pythonExeFor(REAL_ROOT)
const REAL_SITE = join(REAL_ROOT, 'runtimes', 'a', 'v4.28.0')
const canReuse = existsSync(REAL_PY) && existsSync(join(REAL_SITE, 'astrbot', '__init__.py'))

/** 用指定解释器跑一段 python，返回退出码与输出 */
function runAt(exe: string, args: string[], timeout: number, extraEnv: Record<string, string> = {}) {
  const r = spawnSync(exe, args, {
    encoding: 'utf8',
    timeout,
    env: pipEnvFor(root, { ...process.env, PYTHONHOME: join(exe, '..'), ...extraEnv })
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** 用 stage 里的解释器跑（完整安装路径用） */
const runPy = (args: string[], timeout = 1800000, extraEnv: Record<string, string> = {}) =>
  runAt(pyExe, args, timeout, extraEnv)

/**
 * 核心断言：给定一套「解释器 + AstrBot 包目录」，验证它真能跑。
 *
 * 抽成函数是为了让「复用已装好的」和「现场真装一遍」两条路径
 * 走**完全相同**的断言 —— 否则两条路会慢慢分叉，复用的那条变成摆设。
 */
function verifyChain(deps: {
  exe: string
  site: string
  pyDir: string
  port: number
  /** 报错信息里用来区分是哪条路径 */
  tag: string
}): void {
  const store = createRuntimeStore({ dataRoot: root })

  // 1) 结构识别
  expect(readRuntimeKind(deps.site), `${deps.tag}: 应有 pypi 标记`).toBe('pypi')
  expect(detectLayout(deps.site), `${deps.tag}: 应识别为 astrbot`).toBe('astrbot')

  // 2) 启动命令
  const spec = resolveLaunchSpec({
    type: 'a',
    dir: deps.site,
    pythonExe: deps.exe,
    port: deps.port,
    dataRoot: root
  })
  expect(spec.cmd).toBe(deps.exe)
  /*
   * 必须是 `-m astrbot.cli run`。曾经写的是 `-m astrbot`，实机报错：
   *   No module named astrbot.__main__; 'astrbot' is a package and
   *   cannot be directly executed
   * astrbot 包根没有 __main__.py。真实入口在 wheel 的 entry_points.txt：
   *   astrbot = astrbot.cli.__main__:cli
   * 而 --port 是 cli 里 run 子命令的选项（astrbot/cli/cmd_run.py）。
   */
  expect(spec.args.slice(0, 3), `${deps.tag}: 入口必须是 astrbot.cli run`).toEqual([
    '-m',
    'astrbot.cli',
    'run'
  ])
  expect(spec.args).toContain(String(deps.port))

  // 3) 真能 import（证明这套依赖在这台机器上跑得起来）
  ensureSiteCustomize(deps.pyDir)
  const imp = runAt(deps.exe, ['-c', 'import astrbot; print("OK", astrbot.__version__)'], 300000, {
    MXBOT_SITE: deps.site
  })
  console.log(`[${deps.tag}] import:`, imp.stdout.trim().split('\n').slice(-1)[0])
  expect(imp.status, `${deps.tag}: import astrbot 失败\n${imp.stderr.slice(-500)}`).toBe(0)
  expect(imp.stdout).toContain('OK')

  /*
   * 4) pywin32 的坑。
   * `pip install --target` 不会执行 post-install，pywin32 的 `pywin32.pth`
   * 永远不会被解释器处理（.pth 只在 site-packages 里生效）。
   * 那个 .pth 本该做的三件事全都没人做：win32 / win32\lib / pythonwin 进 sys.path，
   * 再 `import pywin32_bootstrap` 注册 DLL 目录。缺了它，AstrBot 启动到一半炸：
   *   ModuleNotFoundError: No module named 'pywintypes'
   * 包明明在，只是路没接上 —— 这个报错极具误导性，必须钉住。
   */
  const win = runAt(deps.exe, ['-c', 'import pywintypes, win32api; print("PYWIN32_OK")'], 180000, {
    MXBOT_SITE: deps.site
  })
  console.log(`[${deps.tag}] pywin32:`, win.stdout.trim().split('\n').slice(-1)[0])
  expect(win.status, `${deps.tag}: pywin32 加载失败\n${win.stderr.slice(-500)}`).toBe(0)
  expect(win.stdout).toContain('PYWIN32_OK')

  /*
   * 5) 反向确认：不设 MXBOT_SITE 时确实找不到 —— 这就是「实例启动失败」的根因。
   * 之前启动器没注入它（或没写 sitecustomize），实例会以 ModuleNotFoundError 挂掉。
   */
  const bad = runAt(deps.exe, ['-c', 'import astrbot'], 120000, { MXBOT_SITE: '', PYTHONPATH: '' })
  expect(bad.status).not.toBe(0)
  expect(bad.stderr).toContain('ModuleNotFoundError')

  void store
}

describe('AstrBot 走 PyPI 真实安装', () => {
  it('完整链路：装 Python → 读 PyPI 版本 → pip 装 AstrBot → 识别 → import', async () => {
    if (canReuse) {
      console.log('[复用] 本机已有 Python + AstrBot，跳过下载安装，直接验证链路')
      verifyChain({ exe: REAL_PY, site: REAL_SITE, pyDir: REAL_ROOT, port: 6100, tag: '复用' })
      return
    }

    // 1) 内置 Python
    const zip = join(root, 'py.zip')
    let ok = false
    for (const url of PYTHON_SOURCES) {
      try {
        const r = await fetch(url)
        if (!r.ok) continue
        writeFileSync(zip, Buffer.from(await r.arrayBuffer()))
        ok = true
        break
      } catch {
        /* 换源 */
      }
    }
    expect(ok, 'Python 下载失败').toBe(true)
    expect(
      spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${pyDir}' -Force`],
        { timeout: 300000 }
      ).status
    ).toBe(0)
    enableEmbedSite(pyDir)
    // 关键：embed 版带 ._pth 会忽略 PYTHONPATH，必须注入 sitecustomize 才能认 --target 的包
    ensureSiteCustomize(pyDir)
    await ensurePip({ dir: pyDir, runPython: (a) => runPy(a, 600000) })
    expect(runPy(['-c', 'import sys;print(sys.version_info[:2])'], 60000).stdout).toContain('(3, 12)')

    // 2) PyPI 版本清单里有 4.28.0
    const list = await listAstrbotPypiVersions({ includePrerelease: true })
    console.log('PyPI 版本数:', list.length, '最新几个:', list.slice(0, 3).map((v) => v.tag).join(', '))
    expect(list.some((v) => v.tag === 'v4.28.0')).toBe(true)

    // 3) pip 装进版本目录（真实下载依赖）
    const store = createRuntimeStore({ dataRoot: root })
    const dest = store.dirFor('a', 'v4.28.0')
    const pip = runPy(
      [
        '-m',
        'pip',
        'install',
        '--no-warn-script-location',
        '--disable-pip-version-check',
        '--target',
        dest,
        'astrbot==4.28.0',
        /*
         * ★ 这里原来硬编码的是**清华源**：
         *     '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'
         *
         * 而清华源**已实测 403**（项目里为此专门把 PIP_MIRROR_ARGS 删掉了，
         * 改成"跟随用户在界面上选的那个源"，见 python-runtime.ts 的说明）。
         * 这条集成测试却还留着那个旧源，于是 pip 报：
         *     ERROR: Could not find a version that satisfies the requirement
         *            astrbot==4.28.0 (from versions: none)
         *
         * 注意 `from versions: none` 这个措辞 —— 它**不是**"没这个版本"
         *（4.28.0 在 PyPI 上确实存在，已核实），而是"索引上什么都查不到"，
         * 也就是源本身不可用。这跟网络无关，别误判成"被测代码坏了"。
         *
         * 改用 PyPI 官方：与生产默认（DEFAULT_PYTHON_SOURCE 的第一个）一致，
         * 集成测试就该跑在**用户默认会遇到的那条路**上。
         */
        '-i',
        'https://pypi.org/simple/'
      ],
      1800000
    )
    if (pip.status !== 0) console.log('pip 失败尾部:', pip.stderr.slice(-900))
    expect(pip.status, 'pip install 失败').toBe(0)
    expect(existsSync(join(dest, 'astrbot'))).toBe(true)
    writeFileSync(
      join(dest, 'mxbot-runtime.json'),
      JSON.stringify({ tag: 'v4.28.0', kind: 'pypi', entry: 'astrbot' }),
      'utf8'
    )
    store.register({ type: 'a', tag: 'v4.28.0', from: 'PyPI 官方' })
    console.log('已安装到:', dest)

    verifyChain({ exe: pyExe, site: dest, pyDir, port: 6101, tag: '现场安装' })
  }, 2400000)
})

afterAll(() => cleanStage(root))
