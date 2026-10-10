export interface Mirror {
  label: string
  base: string
  mode: 'proxy' | 'files'
  builtin?: boolean
  hideBase?: boolean
  note?: string
  indexUrl?: string
}
export interface MirrorState {
  mirrors: Mirror[]
  pref: { a: string; n: string }
}
export interface VersionItem {
  tag: string
  assetName: string
  sizeMB?: number
  publishedAt?: string
  prerelease?: boolean
  from: string
  base: string
}
export interface RuntimeVersion {
  type: 'a' | 'n'
  tag: string
  from?: string
  installedAt: string
  sizeMB?: number
}
export interface Progress {
  type: 'a' | 'n' | 'python'
  tag: string
  percent: number | null
  gotText: string
  speedText: string
  phase: 'start' | 'downloading' | 'verify' | 'finish' | 'unpack' | 'done' | 'error'
  label?: string
  error?: string
  /**
   * 任务开始时刻（ms epoch），**由主进程带**。
   *
   * 有了它「已用 N 秒」才能跨页面切换算准 —— 否则切走再回来会从 0 重读
   *（主人 2026-09-27 实测：「切换到其他页面回来，计时又刷新了」）。
   */
  startedAt?: number
}

export interface LauncherApi {
  stats?: {
    overview?: () => Promise<{ system?: { totalMemMB: number; freeMemMB: number; totalDiskMB: number; freeDiskMB: number; osVersion?: string; cpuModel?: string; gpuModel?: string } }>
  }
  mirrors?: {
    state?: () => Promise<MirrorState>
    add?: (m: { label: string; base: string; mode: 'proxy' | 'files' }) => Promise<MirrorState>
    remove?: (base: string) => Promise<MirrorState>
    pref?: (p: { a?: string; n?: string }) => Promise<MirrorState>
    test?: () => Promise<
      Array<{ base: string; label: string; ms: number | null; status: string; reason?: string }>
    >
  }
  versions?: { list?: (p: { type: 'a' | 'n'; base?: string; noCache?: boolean }) => Promise<VersionItem[]> }
  runtime?: { install?: (p: { type: 'a' | 'n'; tag: string; base?: string }) => Promise<{ tag: string; from: string }> }
  runtimes?: {
    pickFile?: () => Promise<string | null>
    probeFile?: (file: string) => Promise<ImportProbe>
    importFile?: (p: { type: 'a' | 'n'; file: string; version: string }) => Promise<{ tag?: string; depsOk?: boolean }>
    list?: () => Promise<RuntimeVersion[]>
    /**
     * 删除结果：
     *   usedBy          —— 仍指向该版本的实例名（删不会被拦，只用来提示）
     *   unknownBinding  —— 版本记录损坏、**无法确认**是否引用这个版本的实例名。
     *                      删除会放行，但必须提示用户去修记录（重选一次版本），
     *                      否则那个实例下次启动可能失败。
     */
    remove?: (p: {
      type: 'a' | 'n'
      tag: string
    }) => Promise<{ usedBy?: string[]; unknownBinding?: string[] } | void>
    /**
     * 取消一个正在进行的安装/导入。
     *
     * 主人 2026-09-27：「安装/下载一个加入取消，防止卡住了只能重启软件
     * 来换更快的安装/下载源」。
     *
     * `ok: true` = **已经发出取消信号**（不是"已停止"）——
     * 真正的停止要等 pip/fetch 响应，界面靠后续的 error 事件确认。
     */
    cancel?: (p: { type: 'a' | 'n' | 'python'; tag: string }) => Promise<{ ok: boolean; reason?: string }>
    /**
     * 给某个已装的 AstrBot 版本手动装 pip 库。
     *
     * `tag` 决定装到哪个运行时目录（`runtimes\a\<tag>`）——
     * 该版本的所有实例都能立刻 import 到（依赖本来就是共享的）。
     * 失败时抛出的 Error 里带着 pip 的原始输出尾部。
     */
    installPip?: (p: { tag: string; packageSpec: string }) => Promise<unknown>
  }
  instance?: {
    list?: () => Promise<
      Array<{ id: string; name: string; type: 'a' | 'n'; runtimeTag?: string; status?: string }>
    >
  }
  python?: {
    status?: () => Promise<{ ready: boolean; version: string }>
    install?: () => Promise<{ ready: boolean; version: string }>
  }
  onDownloadProgress?: (cb: (p: Progress) => void) => () => void
  /**
   * 「现在有哪些下载/安装任务在跑」—— 挂载时恢复进度条用。
   *
   * 见 onMounted 里那段说明：进度原来只活在本组件的 ref 里，
   * 切走页面就丢；现在主进程存快照，这里问一次即可恢复。
   */
  downloadSessions?: () => Promise<Progress[]>
}


export interface ImportProbe {
  kind: 'a' | 'n' | null
  version: string
  reason: string
  sizeMB: number
  sha256: string
  sample: string[]
}
