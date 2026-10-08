import { mkdirSync } from 'fs'
import { join } from 'path'
import { ensureTemplate } from './templates'
import { resolveLatest, TEMPLATE_SOURCES } from './template-source'
import { downloadRuntime } from './runtime-download'
import { mirrorOrderFor } from './mirror-store'
import { makeStage, removeDirAsync } from '../util/workdir'
import { expandArchive } from '../util/async-exec'
import { versionNumOf } from '../runtime/instance-version'

export interface TemplateDownloadResult {
  version: number
  asset: string
  sha256: string
  from: string
}

/**
 * 下载 AstrBot / NapCat 运行时原文件并登记为模板。
 * 源来自用户的镜像源列表（首选源优先，失败自动回退），随后解压 + 写 .mx-ready 标记。
 */
export async function downloadTemplate(deps: {
  type: 'a' | 'n'
  dataRoot: string
  destDir: string
  prefixes?: string[]
  onProgress?: (got: number, total?: number) => void
  onSourceTried?: (base: string, ok: boolean, err?: string) => void
  isCancelled?: () => boolean
}): Promise<TemplateDownloadResult> {
  // 版本清单一律走 GitHub API：用代理型镜像做前缀（首选源排最前），文件型源不参与
  const proxyPrefixes = deps.prefixes ?? mirrorOrderFor(deps.dataRoot, deps.type)
    .filter((m) => m.mode === 'proxy')
    .map((m) => m.base)
  const release = await resolveLatest({
    source: TEMPLATE_SOURCES[deps.type],
    prefixes: proxyPrefixes.length ? proxyPrefixes : ['']
  })

  // 暂存放 data\cache\tmp，不用系统临时目录（别占 C 盘）
  const stage = makeStage(deps.dataRoot, 'tpl')
  const zipPath = join(stage, release.assetName)
  try {
    const dl = await downloadRuntime({
      dataRoot: deps.dataRoot,
      type: deps.type,
      release,
      destFile: zipPath,
      onProgress: deps.onProgress,
      onSourceTried: (m, ok, err) => deps.onSourceTried?.(m.base, ok, err),
      isCancelled: deps.isCancelled
    })

    mkdirSync(deps.destDir, { recursive: true })
    // 异步解压：spawnSync 会把主进程事件循环整段堵死（117MB 的包要十几秒），
    // 表现为「下载完了但界面点不动」。跟 runtime:install 保持一致用异步版。
    //
    // 用 expandArchive 而不是自己拼脚本：路径里的单引号会被正确转义。
    // 早年写的是 `Expand-Archive -LiteralPath '${zipPath}' ...`，
    // 数据根路径里带一个单引号（Windows 合法字符）就会让 PowerShell 报
    // "The string is missing the terminator"，解压失败。
    const expand = await expandArchive(zipPath, deps.destDir, { timeoutMs: 900000 })
    if (expand.status !== 0) {
      throw new Error(`解压失败：${String(expand.stderr).slice(0, 300)}`)
    }

    const verNum = versionNumOf(release.tag)
    ensureTemplate({ src: deps.destDir, version: verNum })
    return { version: verNum, asset: release.assetName, sha256: dl.sha256, from: dl.usedLabel }
  } finally {
    /*
     * 清理暂存**必须异步**。
     *
     * 这里原来是 `rmSync(stage, { recursive: true, force: true })` ——
     * 同步删除会把主进程独占住，而暂存里躺着刚下完的整个安装包
     * （NapCat 29 MB / AstrBot 前端包几万个文件）。表现就是
     * 「装完了，但界面点不动」——跟用户报的「各种互动都卡」同源。
     *
     * removeDirAsync 就是这个项目为这件事准备的（见 util/workdir.ts 的说明，
     * 那里明确写了「大目录必须用这个，别用 rmSync」），只是这处漏改了。
     *
     * 不能再抛出去：finally 里抛错会盖掉真正的安装失败原因
     * （用户会看到一个删除报错，而不是「网络失败」这种有用信息）。
     */
    void removeDirAsync(stage).catch(() => {
      /* 删不掉不影响安装结果，下次启动会清理 cache/tmp */
    })
  }
}
