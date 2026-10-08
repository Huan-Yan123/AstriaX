import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'fs'
import { join } from 'path'
import { createHash, randomBytes } from 'crypto'
import { backupRuntime } from './backup'
import { readJsonFile } from '../util/json-file'
import { removeDirAsync } from '../util/workdir'

export interface UpdateManifest {
  version: number
  sha256: string
  url: string
}

export interface CheckResult {
  hasUpdate: boolean
  manifest?: UpdateManifest
}

export async function checkForUpdate(deps: {
  currentVersion: number
  /** 测试注入；生产=https 拉镜像 manifest */
  fetch: (url: string) => Promise<string>
  mirror?: string
}): Promise<CheckResult> {
  const mirror = deps.mirror ?? 'http://127.0.0.1:0/default-mirror-manifest.json'
  const manifest: UpdateManifest = JSON.parse(await deps.fetch(mirror))
  if (typeof manifest.version !== 'number') return { hasUpdate: false }
  return { hasUpdate: manifest.version > deps.currentVersion, manifest }
}

/**
 * 更新流（注入可见 fetch/extract 便于测试，生产在 registerIpcHandlersReal 里喂真实实现）：
 * 1. manifest 版本必须新
 * 2. 下载资产 + sha256 严格匹配（不匹配直接抛「校验失败」等 HArd-stop）
 * 3. staging 目录落盘并通过 stageDirectory() 产出「可整树覆盖 runtime 的目录」
 * 4. 更新前 backupRuntime 兜底
 * 5. 替换 runtime（原 runtime rename 进 .deleted，staging/runtime rename 上位）
 */
export async function runUpdate(deps: {
  dir: string
  currentTemplateVersion: number
  fetchManifest: () => Promise<string>
  fetchAsset: () => Promise<Buffer>
  stageDirectory: (stage: string) => string
  stamp?: () => string
}): Promise<{ newVersion: number; backupFile: string }> {
  const manifest: UpdateManifest = JSON.parse(await deps.fetchManifest())
  if (!(manifest.version > deps.currentTemplateVersion)) {
    throw new Error('已是最新版本')
  }
  const asset = await deps.fetchAsset()
  const actualSha = createHash('sha256').update(asset).digest('hex')
  if (actualSha !== manifest.sha256.toLowerCase()) {
    throw new Error('校验失败：下载资产的 SHA256 与 manifest 不匹配')
  }

  /*
   * staging：落盘原始资产（供 stageDirectory 使用）
   *
   * ★ 加随机后缀（独立审查抓出的碰撞点）：`Date.now()` 只有毫秒精度，
   *   同一毫秒内两次 `runUpdate`（用户连点更新）会共用这个目录，
   *   而 `mkdirSync(recursive)` 对已存在目录**不报错** ——
   *   于是两个更新互相覆盖 `payload.bin`，装出一个来源混杂的运行时。
   */
  const stage = join(deps.dir, `.update-stage-${Date.now()}-${randomBytes(4).toString('hex')}`)
  mkdirSync(stage, { recursive: true })
  writeFileSync(join(stage, 'payload.bin'), asset)
  const stagedDir = deps.stageDirectory(stage)

  // 更新前备份（老 runtime 兜底可见）
  // backupRuntime 已改异步（内部递归读文件 + gzip，同步版会冻住主进程）
  const bak = await backupRuntime({ dir: deps.dir, templateVersion: deps.currentTemplateVersion, stamp: deps.stamp })

  // 换血：runtime.old → 弃，staging/runtime → runtime
  const rt = join(deps.dir, 'runtime')
  const stagedRt = join(stagedDir, 'runtime')
  let newVersion = manifest.version
  let backupFile = bak.file

  /*
   * ★ `Date.now()` 只能调**一次**，存进变量复用。
   *
   * 子代理审计抓出的真 bug：原来是
   *     renameSync(rt, `${rt}.deleted-${Date.now()}`)      ← 造名字
   *     ...
   *     rmSync(`${rt}.deleted-${Date.now()}`, ...)          ← 又调一次！
   *
   * 两次 `Date.now()` 的毫秒数**几乎必然不同** → 删的是一个
   * **不存在的路径** → `rmSync` 静默失败（force: true 不报错）→
   * 那份被改名成 `.deleted-<旧时间戳>` 的运行时副本**永远清不掉**。
   *
   * 后果：每更新一次就多留一份几百 MB 的旧运行时，
   * 用户磁盘被慢慢吃掉，而且没人知道为什么。
   */
  /*
   * ★ 同样加随机后缀（与上面 stage 同一个理由）。
   *
   * 碰撞时的表现：第二次 `renameSync` 的目标已存在 → 抛错 → 更新中断。
   * 下面那几条注释讨论的是"`Date.now()` 被调两次"（已修），
   * 但"两次更新落在同一毫秒"是**另一个**碰撞源，这里一并堵掉。
   */
  const deadRt = `${rt}.deleted-${Date.now()}-${randomBytes(4).toString('hex')}`
  if (existsSync(rt)) {
    renameSync(rt, deadRt)
  }
  renameSync(stagedRt, rt)
  rmSync(stage, { recursive: true, force: true })
  /*
   * 清掉那份弃用的旧运行时。用上面那个**同一个** deadRt 变量。
   *
   * ★ 用 `removeDirAsync` 而不是 `rmSync`（self-check 的同步阻塞审计抓出）。
   *
   * 一份 NapCat 运行时是**两百多 MB**（`runtime/native/` 里几个大 .node
   * 加起来就 9MB，整个目录 212MB —— 见 e2e 的实测记录）。
   * `rmSync` 删这么多文件会**同步占住主进程**，界面在这期间完全点不动；
   * 而更新正好是用户盯着界面看的时候。
   *
   * `removeDirAsync` 还顺带带上了"顽固目录"的处理（EPERM 时提权重试），
   * 那正是 `runtimes/*.deleted-*` 这类被占用的目录最容易撞上的情况。
   *
   * 即使这次 rename 没发生（原来就没有 runtime），它对不存在的路径
   * 也是安全的（内部按"已删掉"处理）。
   */
  await removeDirAsync(deadRt)

  // 更新当前模板版本标记进 instance 索引
  const manifestFile = join(deps.dir, 'instance.json')
  if (existsSync(manifestFile)) {
    /*
     * 这一步不能因为文件坏掉就抛。
     *
     * 位置很关键：此时运行时**已经换血完成**（上面 rename 过 rt/stagedRt 了），
     * 只剩版本标记没写。如果这里抛异常，调用方看到的是"更新失败"，
     * 但磁盘上的运行时其实已经是新的 —— 版本标记与实际内容不一致，
     * 之后所有基于标记的判断都会错。
     *
     * 所以：解析失败就退化成空对象继续写，别让"换个标记"这种收尾动作
     * 把前面已经成功的事情报成失败。
     */
    let meta: { templateVersion?: number } = {}
    try {
      meta = readJsonFile<{ templateVersion?: number }>(manifestFile)
      if (!meta || typeof meta !== 'object') meta = {}
    } catch {
      meta = {} // 文件坏了也继续，至少把新版本号写上
    }
    meta.templateVersion = newVersion
    writeFileSync(manifestFile, JSON.stringify(meta, null, 2), 'utf8')
  }
  return { newVersion, backupFile }
}
