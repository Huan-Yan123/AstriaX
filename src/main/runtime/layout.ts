import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { NAPCAT_DEFAULT_TOKEN } from '../constants'
import { readJsonFile } from '../util/json-file'
import { pythonDirFor, pythonEnvFor } from './python-runtime'

export type LayoutKind = 'astrbot' | 'napcat' | 'unknown'

/** 读我们自己的运行时标记（PyPI 安装的会写这个） */
export function readRuntimeKind(dir: string): 'pypi' | 'node' | undefined {
  const f = join(dir, 'mxbot-runtime.json')
  if (!existsSync(f)) return undefined
  try {
    const j = readJsonFile<{ kind?: string }>(f)
    if (j.kind === 'pypi') return 'pypi'
    if (j.kind === 'node') return 'node'
  } catch {
    /* 标记坏了当没有 */
  }
  return undefined
}

/**
 * 识别运行时目录结构。AstrBot 有两种落地形态：
 * - 源码形态：根目录有 main.py（官方仓库）
 * - PyPI 形态：pip --target 装出来的包目录（有 astrbot 包），带 mxbot-runtime.json 标记
 * NapCat（Shell 版）：根目录有 launcher.bat + napcat.mjs + NapCatWinBootMain.exe
 * 兼容旧下载：Windows.Node 版根目录有 node.exe + index.js
 */
export function detectLayout(dir: string): LayoutKind {
  if (!existsSync(dir)) return 'unknown'
  if (existsSync(join(dir, 'main.py'))) return 'astrbot'
  // Shell 版（现在的正路）：不跑 bat，直接起 NapCatWinBootMain.exe 注入 QQ。
  // 判据用注入器 + napcat.mjs，比看 bat 更贴近真正要用的东西。
  if (existsSync(join(dir, 'NapCatWinBootMain.exe')) && existsSync(join(dir, 'napcat.mjs'))) {
    return 'napcat'
  }
  // 兼容：只有 launcher 脚本的版本
  if (
    (existsSync(join(dir, 'launcher.bat')) || existsSync(join(dir, 'launcher-win10.bat'))) &&
    existsSync(join(dir, 'napcat.mjs'))
  ) {
    return 'napcat'
  }
  // 兼容：Windows.Node 版自带 node.exe
  if (existsSync(join(dir, 'node.exe')) && existsSync(join(dir, 'index.js'))) return 'napcat'
  // 只要见到 napcat.mjs 就认它是 NapCat 运行时 —— 哪怕缺注入器/Hook。
  // 这样报出来的是「缺 NapCatWinBootMain.exe，去下载页重装」（可操作），
  // 而不是笼统的「结构不对」（用户不知道该干什么）。
  if (existsSync(join(dir, 'napcat.mjs'))) return 'napcat'
  // 兼容：某些打包把内容放在子目录
  if (existsSync(join(dir, 'napcat', 'napcat.mjs'))) return 'napcat'
  // PyPI 装出来的 AstrBot：有 astrbot 包 + 我们的标记
  if (existsSync(join(dir, 'astrbot')) && readRuntimeKind(dir) === 'pypi') return 'astrbot'
  return 'unknown'
}

export interface LaunchSpec {
  cmd: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  /** 是否依赖内置 Python（AstrBot 是） */
  useBuiltinPython: boolean
  /** 是否需要管理员权限（NapCat 注入 QQ，必须提权） */
  needsAdmin: boolean
  /** 首启是否需要先装依赖 */
  requiresDeps: boolean
}

/**
 * 生成实例启动命令。
 * AstrBot 一律用内置 Python 3.12（对齐官方 .python-version=3.12），没装就报错，
 * 绝不偷偷用系统解释器——否则用户在别人机器上会遇到"我这能跑他那不能"。
 * NapCat 用自带 node.exe，不碰 Python。
 *
 * 关于 cwd（代码与数据的切分）：
 * 运行时目录在多版本改造后是**同类实例共享**的，而 AstrBot 会把数据写进
 * `<cwd>\data`、NapCat 会把配置写进 `<cwd>\config`。如果 cwd 指向共享运行时目录，
 * 两个实例就会读写同一份配置——账密互相覆盖、重置了不生效、备份也保不到东西。
 * 所以：代码用运行时目录，**cwd 必须是实例自己的目录**，两者分开。
 */
export function resolveLaunchSpec(deps: {
  type: 'a' | 'n'
  dir: string
  /** 实例目录：AstrBot 的数据落这里（与共享的代码目录分开） */
  instanceDir?: string
  /**
   * NapCat 专用：已检测到的 QQ.exe 绝对路径（注入目标）。
   * 由 qq-check 从注册表解析出来（和 NapCat 官方 bat 同一个来源）。
   */
  qqExe?: string
  /** NapCat 专用：QQ 号（快速登录 + 数据文件命名，多开隔离靠它） */
  qqAccount?: string
  /**
   * NapCat 专用：要写进 webui.json 的 WebUI Token。
   *
   * **留空 = 不要覆盖**（让 NapCat 用实例配置文件里已有的 token）。
   * 只有首次启动（实例还没有 token）或用户显式点了「重置 Token」时才传值。
   * 详见下方 setenv 处的说明 —— 无条件传值会把用户改过的 token 冲掉。
   */
  webuiToken?: string
  pythonExe?: string
  port: number
  dataRoot?: string
}): LaunchSpec {
  const kind = detectLayout(deps.dir)
  // 数据目录：有实例目录就用实例目录（正常路径），没有才退回运行时目录（兼容旧调用）
  const workDir = deps.instanceDir ?? deps.dir

  if (deps.type === 'a') {
    if (kind !== 'astrbot') {
      throw new Error(`AstrBot 运行时结构不对（${deps.dir}），重新下载这个版本`)
    }
    if (!deps.pythonExe) {
      throw new Error('还没内置 Python 3.12——去「下载」页把 Python 装好再启动 AstrBot')
    }
    const pythonEnv = deps.dataRoot
      ? pythonEnvFor({ dataRoot: deps.dataRoot })
      : { MX_PYTHON: deps.pythonExe, PYTHONHOME: join(deps.pythonExe, '..') }
    // AstrBot 不同入口/版本对 --port 的处理曾有差异；环境变量是
    // Dashboard 运行时读取的端口来源，同时保留 CLI 参数兼容旧版本。
    const env = { ...pythonEnv, DASHBOARD_PORT: String(deps.port) }
    const isPypi = readRuntimeKind(deps.dir) === 'pypi' || !existsSync(join(deps.dir, 'main.py'))
    /*
     * PyPI 形态的入口是 **`astrbot.cli`，而且必须带 `run` 子命令**。
     *
     * 这里踩过一个死坑：原来写的是 `python -m astrbot --port N`，
     * 实机报错 `No module named astrbot.__main__; 'astrbot' is a package and
     * cannot be directly executed` —— 因为 astrbot 包根目录**没有 __main__.py**。
     *
     * 真实入口在 wheel 的 entry_points.txt 里写得很清楚：
     *   [console_scripts]
     *   astrbot = astrbot.cli.__main__:cli
     * 而 cli 是个 click group，`--port` 挂在 `run` 子命令上（astrbot/cli/cmd_run.py），
     * 不是顶层选项。所以正确写法是 `-m astrbot.cli run --port N`。
     *
     * 另一个必须满足的前提：`get_astrbot_root()` 返回的是 **Path.cwd()**，
     * 且 `check_astrbot_root()` 要求该目录里存在 `.astrbot` 标记，
     * 否则直接拒绝启动。所以 cwd（workDir）必须是实例目录，
     * 且实例目录里要有 `.astrbot` —— 由 ipc 的启动流程负责创建。
     * 这也正好是多开隔离的基础：每个实例一个 cwd，各有各的 data/ 和 lock。
     */
    return {
      cmd: deps.pythonExe,
      // 源码形态要把入口指到运行时目录里的 main.py（cwd 已不是它了）
      args: isPypi
        ? ['-m', 'astrbot.cli', 'run', '--port', String(deps.port)]
        : [join(deps.dir, 'main.py'), '--port', String(deps.port)],
      cwd: workDir,
      env: isPypi ? { ...env, MXBOT_SITE: deps.dir, PYTHONPATH: deps.dir } : env,
      useBuiltinPython: true,
      needsAdmin: false,
      requiresDeps: existsSync(join(deps.dir, 'requirements.txt'))
    }
  }

  if (kind !== 'napcat') {
    throw new Error(`NapCat 运行时结构不对（${deps.dir} 里没有 napcat.mjs），去「下载」页重新装这个版本`)
  }

  /*
   * NapCat Shell 版：**直接起 NapCatWinBootMain.exe**，不经过官方 launcher.bat。
   *
   * 这是照 NapCatQQ-Desktop（能正常多开、且不弹黑框的同类项目）的做法来的。
   * 它的启动参数和环境变量是：
   *   program = <napcat目录>\NapCatWinBootMain.exe
   *   args    = [ QQ.exe, NapCatWinBootHook.dll, <QQ号> ]
   *   env     = NAPCAT_PATCH_PACKAGE / NAPCAT_LOAD_PATH / NAPCAT_INJECT_PATH
   *             NAPCAT_LAUNCHER_PATH / NAPCAT_MAIN_PATH
   *   cwd     = <napcat目录>
   *
   * 为什么不跑 bat —— 我们在这上面连栽两次：
   *
   * 1. **丢控制权**：bat 开头有 `net session` 自检，不是管理员就 `runas` 重开自己。
   *    被 runas 拉起的是**另一个提权进程**，我们 spawn 的那个立刻退出 ——
   *    子进程句柄、stdout/stderr、taskkill /T 的进程树全失效，
   *    用户点「停止」根本停不掉真正在跑的那个 NapCat。
   *    （让启动器整体提权能绕过这段，但那是治标；直接不跑 bat 才是治本。）
   *
   * 2. **弹黑框**：bat 里同步调用 NapCatWinBootMain.exe，而它是 CUI 程序
   *    （PE Subsystem = 3，会自己开控制台）。现场抓到的窗口标题是
   *      Select "E:\...\NapCatWinBootMain.exe" "E:\QQ\QQ.exe" "E:\...\NapCatWinBootHook.dll"
   *    开头那个 Select 就是 Windows 控制台「标记模式」的标题。
   *    直接起它 + windowsHide，整条链就没有可见控制台了。
   *
   * 第三个参数是 QQ 号：NapCat 用它做快速登录，并按 QQ 号命名数据文件
   * （onebot11_<QQ号>.json）——这也是多开隔离的关键。不传就走扫码登录。
   *
   * 数据隔离仍用官方的 NAPCAT_WORKDIR（napcat.mjs 的 WR 类读它）：
   * config / logs / plugins / cache 全落到实例目录，static 仍读运行时。
   */
  const injector = join(deps.dir, 'NapCatWinBootMain.exe')
  const hook = join(deps.dir, 'NapCatWinBootHook.dll')
  const mainMjs = join(deps.dir, 'napcat.mjs')
  const patchPkg = join(deps.dir, 'qqnt.json')
  const loadPath = join(deps.dir, 'loadNapCat.js')

  // 兼容旧的 Windows.Node 版（自带 node.exe，但同样依赖 QQ 的运行时，已不再下载）
  const legacyNode = join(deps.dir, 'node.exe')
  if (!existsSync(injector) && existsSync(legacyNode) && existsSync(join(deps.dir, 'index.js'))) {
    return {
      cmd: legacyNode,
      args: ['./index.js'],
      cwd: deps.dir,
      env: { NAPCAT_FORCE_NODE_PROCESS: '1' },
      useBuiltinPython: false,
      needsAdmin: true,
      requiresDeps: false
    }
  }

  if (!existsSync(injector)) {
    throw new Error(`NapCat 缺 NapCatWinBootMain.exe（${deps.dir}），这个版本不完整，去「下载」页重装`)
  }
  if (!existsSync(hook)) {
    throw new Error(`NapCat 缺 NapCatWinBootHook.dll（${deps.dir}），这个版本不完整，去「下载」页重装`)
  }
  if (!existsSync(mainMjs)) {
    throw new Error(`NapCat 缺 napcat.mjs（${deps.dir}），这个版本不完整，去「下载」页重装`)
  }
  if (!existsSync(patchPkg)) {
    throw new Error(`NapCat 缺 qqnt.json（${deps.dir}），这个版本不完整，去「下载」页重装`)
  }
  if (!deps.qqExe) {
    throw new Error('还没找到 QQ.exe——NapCat 是注入 QQ 运行的，先装好 QQ（≥40768）再启动')
  }

  // bat 每次启动都会重写 loadNapCat.js；我们不跑 bat，就得自己保证它存在且内容正确
  // （内容与官方 bat 生成的完全一致：一行动态 import 指向本目录的 napcat.mjs）
  writeLoadNapCatScript(loadPath, mainMjs)

  const args = [deps.qqExe, hook]
  // 第三个参数：QQ 号（快速登录）。没有就只给两个，NapCat 会走扫码。
  if (deps.qqAccount && /^\d{5,12}$/.test(deps.qqAccount)) args.push(deps.qqAccount)

  return {
    cmd: injector,
    args,
    // 必须留在运行时目录：qqnt.json / loadNapCat.js / napcat.mjs 都是相对它定位的
    cwd: deps.dir,
    env: {
      // 官方 bat 里设的那五个（NapCat 靠它们找配置文件、入口脚本、Hook 和注入器）
      NAPCAT_PATCH_PACKAGE: patchPkg,
      NAPCAT_LOAD_PATH: loadPath,
      NAPCAT_INJECT_PATH: hook,
      NAPCAT_LAUNCHER_PATH: injector,
      NAPCAT_MAIN_PATH: mainMjs,
      // 数据隔离：把 config/logs/plugins/cache 重定向到实例目录
      // （napcat.mjs 的 WR 类读它；不设就落到运行时目录，同类实例会互相覆盖）
      ...(deps.instanceDir ? { NAPCAT_WORKDIR: deps.instanceDir } : {}),
      // WebUI 端口：NapCat 用这个环境变量覆盖配置里的值（默认 6099）。
      // 不传的话所有实例都挤在 6099，第二个实例必然起不来。
      NAPCAT_WEBUI_PREFERRED_PORT: String(deps.port),
      /*
       * WebUI Token：**只转发调用方给的，没有就不注入**。
       *
       * 演化：
       *   ① 最早无条件写 `NAPCAT_WEBUI_SECRET_KEY: NAPCAT_DEFAULT_TOKEN`，
       *      而 NapCat 每次启动都会拿这个环境变量写回 webui.json ——
       *      用户在 WebUI 里改过的 token 每次启动都被冲回 114514
       *      （用户反馈「napcat 的 token 没办法查看」「自动覆盖 napcat 的 token」）
       *   ② 上一版：没有 token 时塞默认值（修好了"每次覆盖"，但首次仍强塞）
       *   ③ 现在（主人 2026-09-27：「首次启动不需要强制设置 token」）：
       *      **只在调用方明确给了才注入**。调用方（ipc.ts 的 launchSpecFor）
       *      现在只回传用户已有的 token —— 首次启动是 undefined，即**不注入**。
       *
       * 所以这里不做任何兜底：`deps.webuiToken` 为空就整条不传，
       * 让 NapCat 用它自己的默认值/自己生成。我们只负责"不去动它"。
       */
      ...(deps.webuiToken ? { NAPCAT_WEBUI_SECRET_KEY: deps.webuiToken } : {})
    },
    useBuiltinPython: false,
    // 注入 QQ 需要管理员（官方 bat 里也是先 net session 检查再 runas）
    needsAdmin: true,
    requiresDeps: false
  }
}

/**
 * 写 loadNapCat.js —— QQ 的加载入口脚本。
 *
 * 内容与官方 launcher 脚本生成的完全一致（一行动态 import）：
 *   (async () => {await import("file:///...napcat.mjs")})()
 * 官方 bat 每次启动都会 `echo ... > loadNapCat.js` 重写它，所以我们不跑 bat 就得自己写。
 *
 * 路径要转成 file:// URI 且用正斜杠（Windows 反斜杠在 URL 里会被当转义）。
 * 文件已经存在且内容相同时不重写，避免每次启动都动磁盘（也便于排查）。
 */
export function writeLoadNapCatScript(loadPath: string, mainMjs: string): void {
  const uri = `file:///${mainMjs.replace(/\\/g, '/')}`
  const content = `(async () => {await import("${uri}")})()\r\n`
  try {
    if (existsSync(loadPath) && readFileSync(loadPath, 'utf8') === content) return
    writeFileSync(loadPath, content, 'utf8')
  } catch {
    // 写不进去也别让启动整个失败：NapCat 自己也可能生成它
  }
}

/** 内置 Python 是否就绪（决定卡片上能否启动 AstrBot） */
export function isPythonReady(dataRoot: string): boolean {
  return existsSync(join(pythonDirFor(dataRoot), 'python.exe'))
}
