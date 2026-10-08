/*
 * ★★ 设备与依赖信息采集（主人 2026-09-27：「日志系统应该同时收集一次设备信息，
 *    比如系统，依赖，硬件等」）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 为什么这件事值钱
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 在这一步之前，导出包里的 `system-info.txt` 只有 8 行：
 *     版本 / 平台 / 系统 / Electron / Node / Chrome / 数据目录 / 生成时间
 *
 * 而实际排查时我们**反复**需要下面这些，却一个都没有：
 *
 *   · **磁盘余量** —— "下载失败""解压失败""日志写不进去"的头号原因。
 *     用户说"下载总是失败"，我们答不出"你 C 盘还剩多少"。
 *   · **总内存 / 可用内存** —— OOM 杀实例、AstrBot 莫名退出。
 *   · **是否管理员** —— 这台软件**核心行为依赖提权**（NapCat 注入 QQ）。
 *     用户报"NapCat 起不来"，第一句该问的就是"你是管理员跑的吗"，
 *     而 `elevateVerdict` 早就算出来了、就是没写进日志。
 *   · **QQ 版本与安装路径** —— NapCat 是注入进 QQ 的，版本太老必崩。
 *     `qq-check.ts` 检测了、`instance:start` 拒绝了会给理由，
 *     但**成功时的检测结果不落盘**，用户说"时好时坏"我们查不了。
 *   · **代理设置** —— 国内环境下"连不上源"的第二大原因（仅次于没网）。
 *   · **安全软件** —— 杀软拦截是"下载失败/文件被锁"的常见真凶。
 *   · **依赖状态** —— 内置 Python 装没装、装在哪、pip 能不能用、
 *     setuptools/wheel 在不在（这正是"导入 whl 后起不来"的根因）。
 *
 * ## 设计原则
 *
 *   1. **绝不能因为采集失败而让导出失败**：每一项都独立 try/catch，
 *      拿不到就写"(取不到)"。导出包的价值在于"有"，不在于"全"。
 *   2. **绝不能让采集阻塞主进程**：全部走异步子进程（`run` 是 async 的），
 *      每项都有超时。绝不能在这个函数里出现 `spawnSync`。
 *   3. **采集要快**：加起来的窗口预算控制在 2 秒内 ——
 *      导出本身已经够慢了（虽然现在改用 tar 快多了），不能因为加信息又变慢。
 *   4. **敏感信息按需**：代理地址可能含账号密码 → **打码**。
 *      用户名会出现在路径里，那是排查必需的，保留（但会提示用户）。
 */
import { promises as fsp } from 'fs'
import { join } from 'path'

/** 子进程执行器（注入以便单测；生产用 util/async-exec 的 run） */
export type InfoRunner = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number }
) => Promise<{ status: number | null; stdout?: string; stderr?: string }>

export interface DeviceInfoDeps {
  dataRoot: string
  appVersion?: string
  run: InfoRunner
  /** 提权判定结果（'already' | 'relaunched' | 'declined'），由 index.ts 传入 */
  elevateVerdict?: string
  /** QQ 检测结果（已在别处算过就直接给，避免重复探测） */
  qq?: { ok?: boolean; version?: string; path?: string; reason?: string }
  /** 内置 Python 就绪状态 */
  python?: { ready?: boolean; version?: string; exe?: string }
}

/** 把字节数说成人话（GB/MB），读不出来就给 '-' */
function humanBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n < 0) return '-'
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

/**
 * 代理地址打码：只留主机名与端口，**去掉 user:pass@ 与路径**。
 *
 * 为什么必须打码：用户可能配了带认证信息的公司代理，
 * 导出包是要发给别人的（我们），不该顺带把凭据带出来。
 */
export function maskProxy(raw: string | undefined): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  try {
    // http://user:pass@host:port 形式
    const u = new URL(s.includes('://') ? s : `http://${s}`)
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`
  } catch {
    // 解析不了就只保留"看起来像 host:port"的片段，其余打掉
    const m = s.match(/([a-zA-Z0-9.-]+)(:\d+)?/)
    return m ? `${m[1]}${m[2] ?? ''}` : '(已打码)'
  }
}

/** 跑一条命令并返回 stdout（失败/超时都给空串，绝不抛） */
async function tryCmd(
  run: InfoRunner,
  cmd: string,
  args: string[],
  timeoutMs = 4000
): Promise<string> {
  try {
    const r = await run(cmd, args, { timeoutMs })
    return String(r.stdout ?? '').trim()
  } catch {
    return ''
  }
}

/**
 * 磁盘余量：用 PowerShell 的 Get-PSDrive（比 wmic 快且不依赖已废弃组件）。
 *
 * 输出形如：`E 1047218688000`（盘符 + 可用字节）。
 */
async function diskFree(run: InfoRunner, drive: string): Promise<string> {
  const out = await tryCmd(
    run,
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-PSDrive -Name '${drive.replace(/:$/, '')}' -ErrorAction SilentlyContinue).Free`
    ],
    5000
  )
  const n = Number(out)
  return Number.isFinite(n) && n > 0 ? humanBytes(n) : '(取不到)'
}

/**
 * 内存：用系统自带 `systeminfo` 太慢（几秒），改用 PowerShell 的
 * Win32_OperatingSystem（单次 WMI 查询，通常 <500ms）。
 */
async function memoryInfo(run: InfoRunner): Promise<{ total: string; free: string }> {
  const out = await tryCmd(
    run,
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$o=Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue; "$($o.TotalVisibleMemorySize) $($o.FreePhysicalMemory)"'
    ],
    5000
  )
  const [t, f] = out.split(/\s+/).map((x) => Number(x) * 1024) // 单位 KB → 字节
  return {
    total: Number.isFinite(t) && t > 0 ? humanBytes(t) : '(取不到)',
    free: Number.isFinite(f) && f > 0 ? humanBytes(f) : '(取不到)'
  }
}

/** 显卡：只读取名称，不采集驱动路径或序列号。 */
async function gpuInfo(run: InfoRunner): Promise<string> {
  const out = await tryCmd(
    run,
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join "; "'
    ],
    5000
  )
  return out || '(取不到)'
}


const AV_PROCESS_HINTS = [
  'MsMpEng', // Windows Defender
  '360tray',
  '360sd',
  'ZhuDongFangYu', // 360 主动防御
  'QQPCTray',
  'HipsTray', // 火绒
  'HipsDaemon',
  'huorong',
  'kxetray', // 金山
  'BaiduSd',
  'AliWangWang' // 阿里旺旺（常驻进程，用于判断用户环境）
]

/** 探测在跑的安全软件（一次 tasklist 全量查，比逐个查快） */
async function runningSecurity(run: InfoRunner): Promise<string[]> {
  const out = await tryCmd(run, 'tasklist', ['/FO', 'CSV', '/NH'], 5000)
  if (!out) return []
  const found = new Set<string>()
  for (const hint of AV_PROCESS_HINTS) {
    if (new RegExp(`"${hint}[^"]*\\.exe"`, 'i').test(out)) found.add(hint)
  }
  return [...found]
}

/**
 * 采集完整的设备与依赖信息。
 *
 * 返回一段多行文本，直接写进 `system-info.txt`。
 */
export async function collectDeviceInfo(deps: DeviceInfoDeps): Promise<string> {
  const t0 = Date.now()
  const dataDrive = (deps.dataRoot.match(/^([A-Za-z]:)/)?.[1] ?? 'C:').toUpperCase()

  /*
   * 所有采集**并行**发起（彼此独立），最后按顺序拼装 ——
   * 串行的话每项 1-5 秒，加起来能到十几秒，用户会觉得"导出又变慢了"。
   */
  const [diskData, diskSystem, mem, gpu, sec, netConn] = await Promise.all([
    diskFree(deps.run, dataDrive),
    diskFree(deps.run, 'C:'),
    memoryInfo(deps.run),
    gpuInfo(deps.run),
    runningSecurity(deps.run),
    /* 有网才能下载；这里只统计已建立的连接数，作为"网络是否通"的弱证据 */
    tryCmd(
      deps.run,
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Measure-Object).Count'
      ],
      5000
    )
  ])

  /* 内置 Python 的关键依赖是否就位（"导入 whl 后起不来"的根因区） */
  const pyDeps: string[] = []
  if (deps.python?.ready) {
    const sitePkgs = join(deps.dataRoot, 'runtime', 'python', 'Lib', 'site-packages')
    for (const name of ['pip', 'setuptools', 'wheel']) {
      try {
        await fsp.access(join(sitePkgs, name))
        pyDeps.push(`${name}=有`)
      } catch {
        pyDeps.push(`${name}=缺`)
      }
    }
  }

  const lines: string[] = [
    '═══ AstriaX 诊断信息 ═══',
    '',
    '【软件】',
    `AstriaX 版本: ${deps.appVersion ?? '(未知)'}`,
    `Electron: ${process.versions.electron ?? '(非 Electron)'}`,
    `Node: ${process.versions.node}`,
    `Chrome: ${process.versions.chrome ?? '(无)'}`,
    `数据目录: ${deps.dataRoot}`,
    `提权状态: ${deps.elevateVerdict ?? '(未知)'}`,
    '',
    '【系统】',
    `平台: ${process.platform} ${process.arch}`,
    `系统版本: ${process.getSystemVersion?.() ?? ''}`,
    ...(() => {
      try {
        // release() 需要 os 模块；放这里避免顶部再引一次
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const os = require('os') as typeof import('os')
        return [`主机名: ${os.hostname()}`, `CPU: ${os.cpus()?.[0]?.model ?? '(未知)'} × ${os.cpus()?.length ?? 0}`]
      } catch {
        return ['主机名: (取不到)', 'CPU: (取不到)']
      }
    })(),
    '',
    '【硬件】',
     `显卡: ${gpu}`,
    `总内存: ${mem.total}`,
    `可用内存: ${mem.free}`,
    `数据盘余量(${dataDrive}): ${diskData}`,
    `系统盘余量(C:): ${diskSystem}`,
    '',
    '【依赖】',
    `内置 Python: ${deps.python?.ready ? `已装 ${deps.python.version ?? ''}` : '未装'}`,
    ...(deps.python?.exe ? [`Python 路径: ${deps.python.exe}`] : []),
    ...(pyDeps.length ? [`Python 关键包: ${pyDeps.join(' ')}`] : []),
    '',
    '【环境】',
    `QQ: ${deps.qq ? `${deps.qq.ok ? '可用' : '不可用'} ${deps.qq.version ?? ''} ${deps.qq.reason ?? ''}`.trim() : '未检测'}`,
    ...(deps.qq?.path ? [`QQ 路径: ${deps.qq.path}`] : []),
    `代理(HTTP_PROXY): ${maskProxy(process.env.HTTP_PROXY ?? process.env.http_proxy) || '未设置'}`,
    `代理(HTTPS_PROXY): ${maskProxy(process.env.HTTPS_PROXY ?? process.env.https_proxy) || '未设置'}`,
    `在跑的安全软件: ${sec.length ? sec.join('、') : '(未检测到常见的)'}`,
    `已建立 TCP 连接数: ${netConn || '(取不到)'}`,
    '',
    `生成时间: ${new Date().toISOString()}`,
    `采集耗时: ${Date.now() - t0}ms`
  ]

  return lines.join('\n')
}
