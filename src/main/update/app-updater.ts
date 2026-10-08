/*
 * 应用内自更新（electron-updater 接入）—— 指导书第六章 P3。
 *
 * ## 为什么是"薄封装 + 依赖注入"
 *
 * electron-updater 的真实实现一 `import` 就会碰 `electron`
 *（它内部读 app 的路径、读 app-update.yml）。单测跑在纯 node 下，
 * 顶层 import 直接炸 —— 本项目为此踩过坑（见 ipc.ts 里关于 app 的注释）。
 * 所以这里把它做成**注入进来的对象**：生产注入真的 autoUpdater，
 * 单测注入假对象，逻辑（事件映射、监听器清理、错误回落）照样能验。
 *
 * ## ★ 两条硬约束（主人的明确要求，写死在代码里，不是注释承诺）
 *
 *   1. `autoDownload = false`      —— 下载必须由用户点，不许偷偷占带宽
 *   2. `autoInstallOnAppQuit = false` —— **绝不**在退出时静默安装
 *
 * 主人原话：「更新只能是用户运行更新版本的安装包」。
 * 而 electron-updater 最省事的那条路（`quitAndInstall()`：下载完，
 * 退出时静默跑安装器）**正好违反这条**。所以我们只用它的
 * **检查 + 增量下载**（blockmap 差分：更新时通常只下几 MB，而不是每次 80MB），
 * 安装那一步仍然把安装包交给用户、由用户双击/点「现在安装」跑起来。
 *
 * 这两行如果被人改成 true，就等于把用户明确否掉的行为偷偷装回去了 ——
 * 所以配套单测专门断言它们保持 false（见 tests/unit/app-updater.spec.ts）。
 */
import { copyFile, mkdir } from 'fs/promises'
import { join } from 'path'

/** 我们用到的那部分 autoUpdater 接口（便于注入假对象） */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: string, cb: (...args: unknown[]) => void): void
  removeListener?(event: string, cb: (...args: unknown[]) => void): void
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
}

export interface AppUpdaterDeps {
  log: (level: 'INFO' | 'WARN' | 'ERROR', channel: string, msg: string, detail?: string) => void
  /** 是否打包态：开发态没有 app-update.yml，检查会报错，直接跳过 */
  isPackaged: boolean
  /** 下载进度回调（映射成界面用的形状） */
  onProgress?: (p: { percent: number; got: number; total?: number }) => void
  /** 用户的下载目录（下载完把安装包拷到这里，用户双击即可） */
  downloadDir: () => Promise<string>
  updater: UpdaterLike
}

export interface AppUpdater {
  /**
   * 检查更新。
   *
   * 返回 `{hasUpdate, version?}`；开发态或出错时返回 hasUpdate:false
   *（调用方会回落到"自己拉 latest.json"的老路径）。
   */
  check(): Promise<{ hasUpdate: boolean; version?: string; reason?: string }>
  /**
   * 下载更新（增量）。
   *
   * 返回**拷贝到用户下载目录后的路径** —— 界面本来就只认这个
   *（"保存在：<路径>，双击即可完成更新"），所以渲染层一行都不用改。
   */
  download(): Promise<{ file: string }>
}

/** electron-updater 的 'update-downloaded' 事件给我们的信息（只用我们需要的字段） */
interface DownloadedInfo {
  downloadedFile?: string
  version?: string
}

export function createAppUpdater(deps: AppUpdaterDeps): AppUpdater {
  const { updater } = deps

  /*
   * 硬约束：见文件头。设在这里（而不是只在某个分支里设）——
   * 只要构造了 appUpdater，这两条就一定成立。
   */
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false

  /**
   * 临时事件订阅。
   *
   * ## 为什么必须自己管订阅的清理
   *
   * electron-updater 的 `on()` 是**累加**的：每调一次 download() 就多一个
   * 监听器。用户反复点"下载"（或第一次失败重试）会攒下一串回调，
   * 表现为"进度回调被调用 N 次"（界面进度乱跳）、以及内存里挂着
   * 已经无用的闭包。
   * 本项目在别处也踩过同类问题（DownloadPage 的 stall 时钟、进度延时清理），
   * 所以这里统一"订阅 → 用完立刻退订"。
   */
  function once<T>(event: string, map: (...args: unknown[]) => T | undefined): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const handler = (...args: unknown[]): void => {
        updater.removeListener?.(event, handler)
        updater.removeListener?.('error', onErr)
        try {
          resolve(map(...args) as T)
        } catch (e) {
          reject(e)
        }
      }
      const onErr = (...args: unknown[]): void => {
        updater.removeListener?.(event, handler)
        updater.removeListener?.('error', onErr)
        const msg = args[0] instanceof Error ? args[0].message : String(args[0])
        reject(new Error(msg))
      }
      updater.on(event, handler)
      updater.on('error', onErr)
    })
  }

  return {
    async check() {
      if (!deps.isPackaged) {
        // 开发态没有 app-update.yml：直接说"不检查"，让调用方走老路径
        return { hasUpdate: false, reason: 'dev' }
      }
      try {
        const res = (await updater.checkForUpdates()) as
          | { updateInfo?: { version?: string } }
          | null
        const version = res?.updateInfo?.version
        return version ? { hasUpdate: true, version } : { hasUpdate: false }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        deps.log('WARN', 'app', `electron-updater 检查更新失败（将回落到手写检查）：${msg}`)
        return { hasUpdate: false, reason: msg }
      }
    },

    async download() {
      // 进度：electron-updater 给的字段与我们要的形状基本一致，直接转发
      const onProg = (...args: unknown[]): void => {
        const p = args[0] as { percent?: number; transferred?: number; total?: number } | undefined
        if (!p) return
        deps.onProgress?.({
          percent: Math.round(p.percent ?? 0),
          got: p.transferred ?? 0,
          total: p.total
        })
      }
      updater.on('download-progress', onProg)
      try {
        const downloaded = once<DownloadedInfo>('update-downloaded', (...args) => {
          const info = (args[0] ?? {}) as DownloadedInfo
          return { downloadedFile: info.downloadedFile, version: info.version }
        })
        // 启动下载（不 await 它的返回值：完成信号来自 update-downloaded 事件）
        void updater.downloadUpdate().catch((e: unknown) => {
          deps.log('ERROR', 'app', `electron-updater 下载失败：${e instanceof Error ? e.message : String(e)}`)
        })
        const info = await downloaded

        if (!info.downloadedFile) {
          throw new Error('electron-updater 报告下载完成，但没给文件路径')
        }
        /*
         * 把安装包**拷到用户的下载目录**再返回。
         *
         * 为什么不直接返回 electron-updater 的缓存路径：
         *   · 那个路径藏在 `%LOCALAPPDATA%\<app>-updater\pending\`，
         *     界面上写给用户看会像天书，而且随缓存清理会消失；
         *   · 界面现有的文案是"保存在：<路径>，双击即可完成更新" ——
         *     拷到下载目录正好对上这句承诺。
         * 缓存里那份**保留**：下次增量下载要靠它算差分块。
         */
        const dir = await deps.downloadDir()
        await mkdir(dir, { recursive: true })
        const base = info.downloadedFile.split(/[\\/]/).pop() ?? 'AstriaX-Setup.exe'
        const dest = join(dir, base)
        await copyFile(info.downloadedFile, dest)
        deps.log('INFO', 'app', `更新包已下载（electron-updater 增量）→ ${dest}`)
        return { file: dest }
      } finally {
        updater.removeListener?.('download-progress', onProg)
      }
    }
  }
}
