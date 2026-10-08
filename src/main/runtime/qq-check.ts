import { existsSync, readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { readJsonFile } from '../util/json-file'

/**
 * QQ 版本检测。
 *
 * 为什么必须有：NapCat 不是独立跑的服务，它是**注入到已安装的 QQ 客户端里**运行的。
 * 证据在 NapCat 包自带的 launcher.bat 里：它从注册表读 QQ 路径，然后
 *   NapCatWinBootMain.exe <QQ.exe> NapCatWinBootHook.dll
 * 所以没装 QQ、或 QQ 版本太老，NapCat 一定起不来（表现为端口不通、WebUI 空白）。
 *
 * 版本从哪读（与 napcat.mjs 的 rQ / nQ 函数保持一致）：
 *   1. <QQ目录>\versions\config.json 的 curVersion，形如 "9.9.31-49738"
 *   2. 回落到 <QQ目录>\versions\<版本>\resources\app\package.json 的 buildVersion
 * 比较的是**破折号后的构建号**（49738），不是 9.9.31。
 * NapCat 内部就是用自己的 requireMinNTQQBuild() 比这个数。
 */

/** NapCat 内置签名特征表里出现的最低构建号，低于它必不支持 */
export const MIN_QQ_BUILD = 40768

/** QQ 官网下载页 */
export const QQ_DOWNLOAD_URL = 'https://im.qq.com/pcqq/index.shtml'

/** 常见安装位置（注册表读不到时兜底，比如绿色版） */
export const QQ_FALLBACK_DIRS = [
  'C:\\Program Files\\Tencent\\QQNT',
  'C:\\Program Files (x86)\\Tencent\\QQNT',
  'D:\\QQ',
  'E:\\QQ'
]

/**
 * QQ 在注册表里直接记录安装目录的键。
 * NapCatQQ-Desktop 用的就是这个（比从 UninstallString 推目录更直接）：
 *   HKLM\SOFTWARE\WOW6432Node\Tencent\QQNT → Install = "E:\QQ"
 */
export const QQ_INSTALL_REGISTRY_KEYS = [
  'HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\QQNT',
  'HKLM\\SOFTWARE\\Tencent\\QQNT'
]

/** QQ 在注册表里的卸载项（和 NapCat 的 launcher.bat 读的是同一个键） */
export const QQ_REGISTRY_KEYS = [
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ'
]

/**
 * 从注册表卸载项拼出 QQ 候选目录。
 * 与 NapCat 的 launcher.bat 完全同源：
 *   reg query "HKLM\SOFTWARE\WOW6432Node\...\Uninstall\QQ" /v "UninstallString"
 *   → "E:\QQ\Uninstall.exe" → 去掉文件名就是安装目录
 * 传进来的 readKey 应当是异步查好之后的取值函数（同步读注册表会卡主进程几秒）。
 */
export function qqCandidatesFromRegistry(
  readKey: (key: string, name: string) => string | undefined
): string[] {
  const out: string[] = []
  for (const k of QQ_REGISTRY_KEYS) {
    const v = readKey(k, 'UninstallString')
    if (!v) continue
    const exe = v.replace(/^"|"$/g, '').trim()
    if (exe) out.push(dirname(exe))
  }
  return out
}

/** 从 reg query 的输出里解析出 UninstallString 的值 */
export function parseUninstallString(stdout: string): string | undefined {
  const m = /UninstallString\s+REG_SZ\s+(.+)/i.exec(stdout)
  if (!m) return undefined
  const v = m[1].trim().replace(/^"|"$/g, '')
  return v || undefined
}

/** QQ 安装位置（目录 + 可执行文件），给 NapCat 注入用 */
export interface QQInstall {
  /** QQ 安装根目录，如 E:\QQ */
  dir: string
  /** QQ.exe 绝对路径 */
  exe: string
}

/**
 * 从注册表解析 QQ 安装目录 + QQ.exe。
 *
 * 两条来源，按可靠性排序：
 *   1. HKLM\SOFTWARE\WOW6432Node\Tencent\QQNT → Install（NapCatQQ-Desktop 用的就是它，
 *      直接就是安装目录，不用推导）
 *   2. 卸载项 UninstallString → 去掉引号取目录（NapCat 官方 launcher.bat 用的方式）
 * 都拿不到时回落到常见安装位置。
 *
 * 读注册表要起进程，所以做成「传一个查询函数进来」的纯函数，方便测试；
 * 真正的 reg.exe 调用在调用方。
 */
export function qqInstallFromRegistry(
  readValue: (key: string, value: string) => string | undefined
): QQInstall | undefined {
  // 1. Tencent\QQNT 的 Install 值最直接
  for (const key of QQ_INSTALL_REGISTRY_KEYS) {
    const raw = readValue(key, 'Install')
    if (!raw) continue
    const dir = raw.trim().replace(/^"|"$/g, '')
    if (dir && existsSync(join(dir, 'QQ.exe'))) return { dir, exe: join(dir, 'QQ.exe') }
  }
  // 2. 卸载项里推目录
  for (const key of QQ_REGISTRY_KEYS) {
    const raw = readValue(key, 'UninstallString')
    if (!raw) continue
    const dir = parseUninstallString(raw)
    if (dir && existsSync(join(dir, 'QQ.exe'))) return { dir, exe: join(dir, 'QQ.exe') }
  }
  // 3. 常见位置
  for (const dir of QQ_FALLBACK_DIRS) {
    if (existsSync(join(dir, 'QQ.exe'))) return { dir, exe: join(dir, 'QQ.exe') }
  }
  return undefined
}

export interface QQInfo {
  /** 装了且版本够 */
  ok: boolean
  /** 是否检测到 QQ 安装 */
  installed: boolean
  /** "9.9.31-49738" 这种完整版本串 */
  version?: string
  /** 构建号（用来比门槛的那个数） */
  build?: number
  /** QQ.exe 绝对路径 */
  exe?: string
  /** 版本满足要求时的最低构建号 */
  minBuild: number
  /** 不满足时的中文原因，可直接展示 */
  reason?: string
}

/**
 * 从一个候选 QQ 目录里读版本；读不到返回 undefined。
 *
 * 逻辑照抄 NapCat 自己（napcat.mjs 里 rQ / nQ / getQQBuildStr 三个函数），
 * 这样我们对「QQ 是哪个版本」的理解和真正要跑的 NapCat 完全一致 —— 它读不出来的
 * 我们也读不出来，它认的我们也认，不会出现「我们说版本够、NapCat 说不够」。
 *
 * NapCat 的做法：
 *   1. rQ(QQ.exe)  = <QQ目录>\versions\config.json（"快速更新"模式的标记文件）
 *   2. nQ(QQ.exe, curVersion) = <QQ目录>\versions\<curVersion>\resources\app\package.json
 *      找不到时回落到 <QQ目录>\resources\app\versions\<curVersion>\package.json
 *   3. getQQBuildStr() = config.curVersion.split("-")[1] ?? packageInfo.buildVersion
 *
 * 注意比的是**破折号后面的构建号**（"9.9.31-49738" → 49738），不是 9.9.31。
 *
 * 我们比 NapCat 多一步：它的 curVersion 来自 config.json 所以只有一个候选，
 * 我们得扫目录找，于是多个版本目录时取**构建号最大**的那个 ——
 * 否则旧版本目录会让我们误判成「版本太低」。
 */
export function readQQVersion(qqDir: string): { version: string; build: number } | undefined {
  // 1. 首选 versions\config.json（QQ 快速更新模式写的就是它）
  const cfg = join(qqDir, 'versions', 'config.json')
  if (existsSync(cfg)) {
    try {
      const j = readJsonFile<{
        curVersion?: string
        buildId?: string
      }>(cfg)
      const v = j.curVersion
      if (v) {
        // NapCat: curVersion.split("-")[1] ?? packageInfo.buildVersion
        const fromCur = Number(v.split('-')[1])
        if (Number.isFinite(fromCur) && fromCur > 0) return { version: v, build: fromCur }
        // 没破折号（老格式或纯版本号）→ 去找该版本的 package.json 拿 buildVersion
        const info = readPackageInfo(qqDir, v)
        if (info) return { version: v, build: info.build }
        const fromId = Number(j.buildId)
        if (Number.isFinite(fromId) && fromId > 0) return { version: v, build: fromId }
      }
    } catch {
      /* 坏了就走目录扫描 */
    }
  }

  // 2. 扫版本目录找 package.json。
  //    两个位置都扫（NapCat 的 nQ 会在这两处之间回落）：
  //      versions\<ver>\resources\app\package.json
  //      resources\app\versions\<ver>\package.json
  let best: { version: string; build: number } | undefined
  for (const name of listVersionDirs(qqDir)) {
    const info = readPackageInfo(qqDir, name)
    if (!info) continue
    // 多版本取构建号最大的，别被旧目录骗了
    if (!best || info.build > best.build) best = { version: info.version, build: info.build }
  }
  return best
}

/** 列出两个可能的版本目录名（合并去重，坏目录跳过） */
function listVersionDirs(qqDir: string): string[] {
  const out = new Set<string>()
  for (const dir of [
    join(qqDir, 'versions'),
    join(qqDir, 'resources', 'app', 'versions')
  ]) {
    if (!existsSync(dir)) continue
    try {
      for (const name of readdirSync(dir)) {
        // 只收看起来像版本号的目录名，跳过 config.json 之类的文件
        if (/^\d/.test(name)) out.add(name)
      }
    } catch {
      /* 读不了就当这个位置没有 */
    }
  }
  return [...out]
}

/**
 * 读某个版本目录下的 package.json。
 * 两条路径都要试，顺序和 NapCat 的 nQ 一致：
 *   versions\<ver>\resources\app\package.json
 *   resources\app\versions\<ver>\package.json      ← 回落
 */
function readPackageInfo(qqDir: string, ver: string): { version: string; build: number } | undefined {
  const paths = [
    join(qqDir, 'versions', ver, 'resources', 'app', 'package.json'),
    join(qqDir, 'resources', 'app', 'versions', ver, 'package.json')
  ]
  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      const j = readJsonFile<{ version?: string; buildVersion?: string }>(p)
      const build = Number(j.buildVersion)
      if (Number.isFinite(build) && build > 0) return { version: j.version ?? ver, build }
    } catch {
      /* 跳过坏文件，继续试下一条路径 */
    }
  }
  return undefined
}

/**
 * 检测 QQ 是否满足 NapCat 要求。
 * 找不到 QQ 或版本过低都会给出可直接展示的中文 reason（界面据此弹窗、附官网链接）。
 */
export function checkQQ(deps: { candidates: string[]; minBuild?: number }): QQInfo {
  const minBuild = deps.minBuild ?? MIN_QQ_BUILD
  // 先扫一遍，记住「见过但不够格」的最好情况。
  // 不能碰到第一个过低就直接返回：一台机器上可能同时存在新旧两个 QQ 安装目录，
  // 先扫到旧的就报错会误判——必须继续找有没有合格的。
  let seenTooLow: QQInfo | undefined
  let seenBroken: QQInfo | undefined

  for (const dir of deps.candidates) {
    if (!dir || !existsSync(dir)) continue
    const exe = join(dir, 'QQ.exe')
    const hasExe = existsSync(exe)
    const ver = readQQVersion(dir)
    if (!ver) {
      if (hasExe && !seenBroken) {
        seenBroken = {
          ok: false,
          installed: true,
          exe,
          minBuild,
          reason: `读不出 QQ 的版本信息（${dir}）——建议重装一遍 QQ`
        }
      }
      continue
    }
    if (ver.build < minBuild) {
      // 记下最低要求没满足的这个，但继续找
      if (!seenTooLow || (seenTooLow.build ?? 0) < ver.build) {
        seenTooLow = {
          ok: false,
          installed: true,
          version: ver.version,
          build: ver.build,
          exe: hasExe ? exe : undefined,
          minBuild,
          reason: `QQ 版本太低（当前 ${ver.version}，构建号 ${ver.build}），NapCat 需要 ${minBuild} 以上——把 QQ 更新到最新版再试`
        }
      }
      continue
    }
    return { ok: true, installed: true, version: ver.version, build: ver.build, exe, minBuild }
  }

  // 有装但版本不够 → 说版本；只是读不出来 → 说读不出来；都没有 → 说没装
  if (seenTooLow) return seenTooLow
  if (seenBroken) return seenBroken
  return {
    ok: false,
    installed: false,
    minBuild,
    reason:
      '未安装 QQ——NapCat 是把机器人注入 QQ 里运行的，得先装好 QQ 并登录一次。' +
      '注意：怀旧版 QQ 不支持，需要新版 QQNT'
  }
}
