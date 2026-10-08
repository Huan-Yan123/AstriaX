import { ipcRenderer } from 'electron'

// 渲染层可用 API 一览（任务 6 逐步补全 handler，这里只做通道转发）
export const api = {
  ping: () => ipcRenderer.invoke('app:ping'),
  windowCtl: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close')
  },
  paths: {
    defaults: () => ipcRenderer.invoke('paths:defaults')
  },
  instance: {
    list: () => ipcRenderer.invoke('instance:list'),
    create: (p: unknown) => ipcRenderer.invoke('instance:create', p),
    start: (id: string) => ipcRenderer.invoke('instance:start', id),
    stop: (id: string) => ipcRenderer.invoke('instance:stop', id),
    remove: (id: string) => ipcRenderer.invoke('instance:remove', id),
    creds: (id: string) => ipcRenderer.invoke('instance:creds', id),
    resetCreds: (id: string) => ipcRenderer.invoke('instance:resetCreds', id),
    log: (id: string) => ipcRenderer.invoke('instance:log', id),
    backup: (id: string) => ipcRenderer.invoke('backup:make', id),
    /**
     * 切换运行时版本（高版本覆盖低版本，保留数据与配置）。
     * 主进程只改实例的 tag 指针，实例数据/配置天然保留。
     */
    setRuntime: (p: { id: string; tag: string; type: 'a' | 'n' }) =>
      ipcRenderer.invoke('instance:setRuntime', p),
    /*
     * 「手动更新」：把实例升到该类运行时的最新版。
     *
     * ## 关于 instance:update 这个通道名的历史
     *
     * 这里原来有条注释写着「update(id) 删掉了：主进程的 instance:update
     * 已被 setRuntime 取代，通道不存在」。那是**旧**的 update ——
     * 它当时做的是"老的模板模型"下的更新，确实被 setRuntime 取代了。
     *
     * 现在这个同名通道是**新用途**（用户的新需求）：
     * AstrBot 的 WebUI 一键更新被官方主动禁用了（它检测到自己是被
     * `pip install --target` 装出来的，会报
     * "You are running AstrBot via CLI, please use pip or uv tool upgrade"），
     * 所以"更新"这件事必须由启动器来做。
     *
     * 与 setRuntime 的区别：
     *   · setRuntime   = 切到**本地已装好**的某个版本（瞬时，可自动停实例）
     *   · instance:update = 先**装**最新版（pip 要几分钟），再切指针；
     *                        要求实例处于停止状态（用户明确要求）
     */
    update: (id: string) => ipcRenderer.invoke('instance:update', { id })
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (p: unknown) => ipcRenderer.invoke('config:set', p),
    moveDataDir: (target: string) => ipcRenderer.invoke('config:moveDataRoot', target),
    /*
     * 搬家状态查询（设置页轮询）。
     * 关掉设置页**不会**取消主进程里的复制（刻意如此）——
     * 所以重进设置页时必须能重新看到"还在搬、搬了多久"，
     * 否则用户以为搬完了，甚至再点一次（两份复制交错写坏目标）。
     */
    moving: () => ipcRenderer.invoke('config:moving')
  },
  dialog: {
    pickDataDir: () => ipcRenderer.invoke('dialog:pickDataDir')
  },
  stats: {
    overview: () => ipcRenderer.invoke('stats:overview')
  },
  webui: {
    open: (id: string) => ipcRenderer.invoke('webui:open', id),
    close: (id: string) => ipcRenderer.invoke('webui:close', id),
    list: () => ipcRenderer.invoke('webui:list'),
    /**
     * 当前**正在显示**的是哪个实例的 WebUI。
     *
     * 主进程同一时刻只显示一个（修"点 AstrBot 却看到 NapCat"的视图堆叠 bug），
     * 界面必须能问出"现在到底在看谁" —— 否则顶部工具条会写着 A、屏幕上却是 B。
     */
    visible: () => ipcRenderer.invoke('webui:visible'),
    /** 用户在 WebUI 里按 Esc / Ctrl+W 退出时通知界面刷新按钮状态 */
    onClosed: (cb: () => void) => {
      const h = (): void => cb()
      ipcRenderer.on('webui:closed', h)
      return () => ipcRenderer.removeListener('webui:closed', h)
    }
  },
  logs: {
    exportZip: () => ipcRenderer.invoke('logs:export'),
    /*
     * 「现在有导出任务在跑吗」—— 设置弹窗**重新打开时**用它恢复
     * 「正在打包…」的按钮状态。
     *
     * 主人 2026-09-27 实测：导出没完就关掉设置、再点进去，
     * 按钮又显示"导出日志"（其实还在打包）—— 因为那个状态原来只活在
     * 组件的 ref 里，组件一卸载就没了。
     */
    exportBusy: () => ipcRenderer.invoke('logs:exportBusy')
  },
  /*
   * 「现在有哪些下载/安装任务在跑」—— 下载页**挂载时**问一次，
   * 把进度条恢复出来。
   *
   * 主人 2026-09-27 实测：「我从下载页切换到其他页面再回来，
   * 顶部的下载进度就消失了，直到更新进度才重新显示更新了进度的那个」
   * —— 与上面 exportBusy 同一个病：状态只活在组件里。
   */
  downloadSessions: () => ipcRenderer.invoke('download:sessions'),
  /**
   * 在资源管理器里定位一个文件（打开所在文件夹并选中它）。
   * 目前用于「更新包下载完之后直接跳过去」——比让用户自己翻目录友好。
   */
  shell: {
    showItem: (p: string) => ipcRenderer.invoke('shell:showItem', p)
  },
  /** 操作审计日志：每个 IPC 操作都被自动记录，这里给用户看 */
  audit: {
    /** 有日志的日期列表（新到旧） */
    days: () => ipcRenderer.invoke('audit:days'),
    /** 读某一天（缺省=今天）的原始日志文本 */
    read: (date?: string) => ipcRenderer.invoke('audit:read', date)
  },
  templates: {
    status: () => ipcRenderer.invoke('templates:status'),
    download: (type: 'a' | 'n') => ipcRenderer.invoke('templates:download', type)
  },
  versions: {
    list: (p: unknown) => ipcRenderer.invoke('versions:list', p),
    /** 启动时静默预热缓存（后台跑，不挡界面） */
    prewarm: () => ipcRenderer.invoke('versions:prewarm')
  },
  runtime: {
    install: (p: unknown) => ipcRenderer.invoke('runtime:install', p)
  },
  runtimes: {
    list: () => ipcRenderer.invoke('runtimes:list'),
    remove: (p: unknown) => ipcRenderer.invoke('runtimes:remove', p),
    /** 手动导入：弹文件选择框，返回路径或 null */
    pickFile: () => ipcRenderer.invoke('runtimes:pickFile'),
    /** 手动导入：只探测识别（类型/版本/哈希），不安装 */
    probeFile: (file: string) => ipcRenderer.invoke('runtimes:probeFile', file),
    /** 手动导入：确认后安装 */
    importFile: (p: unknown) => ipcRenderer.invoke('runtimes:importFile', p),
    /*
     * 取消一个正在进行的安装/导入。
     *
     * 主人 2026-09-27：「安装/下载一个加入取消，防止卡住了只能重启软件
     * 来换更快的安装/下载源」。
     *
     * 按 `<type>:<tag>` 定位 —— 与互锁共用键空间，
     * 不会出现"取消了 A 却把 B 停了"。
     */
    cancel: (p: { type: 'a' | 'n'; tag: string }) => ipcRenderer.invoke('runtimes:cancel', p),
    /*
     * 给某个 **AstrBot 运行时版本**手动装 pip 库（主人 2026-10-08）。
     *
     * 为什么要让用户选 tag：一个用户可能同时装着 v4.28.0 和 v4.27.0，
     * 两个版本的依赖是**各自独立**的（我们按版本分目录）。
     * 装错版本的表现是"装了但那个实例还是 import 不到"，很难自查。
     *
     * 库装到 `runtimes\a\<tag>\` —— 与 AstrBot 自己的依赖同一层，
     * 所以该版本的**所有实例**立刻都能 import 到（依赖本来就是共享的）。
     */
    installPip: (p: { tag: string; packageSpec: string }) =>
      ipcRenderer.invoke('runtime:installPip', p)
  },
  python: {
    status: () => ipcRenderer.invoke('python:status'),
    install: () => ipcRenderer.invoke('python:install')
  },
  /** 订阅下载进度（返回取消订阅函数） */
  onDownloadProgress: (cb: (p: unknown) => void) => {
    const handler = (_e: unknown, p: unknown): void => cb(p)
    ipcRenderer.on('download:progress', handler)
    return () => ipcRenderer.removeListener('download:progress', handler)
  },
  mirrors: {
    test: () => ipcRenderer.invoke('mirrors:test'),
    state: () => ipcRenderer.invoke('mirrors:state'),
    add: (m: unknown) => ipcRenderer.invoke('mirrors:add', m),
    remove: (base: string) => ipcRenderer.invoke('mirrors:remove', base),
    pref: (patch: unknown) => ipcRenderer.invoke('mirrors:pref', patch)
  },
  /*
   * AstrBot 的 **Python 源**（pip 索引）—— 与上面的 GitHub 代理源完全分开。
   *
   * 主人 2026-09-26：「astrbot 的换个版本应该是从 astrbot 的 py 源里用户
   * 自己选」+「astrbot 从 GitHub 源剥离，单独做一个 python 源」。
   *
   * ★ 这里曾经缺了整整一层绑定（第二轮复审抓出）：`pysrc:*` 四个 handler
   *   在主进程全实现了，但 preload 没暴露、渲染层也就永远调不到 ——
   *   结果是「pip 源永远等于默认源，用户改不了」，需求只落地了一半。
   */
  pysrc: {
    /** 取源列表 + 当前生效的那个 */
    state: () => ipcRenderer.invoke('pysrc:state'),
    /** 测速与可用性（与 mirrors.test 对称，界面显示"可用 xxx ms"） */
    test: () => ipcRenderer.invoke('pysrc:test'),
    /** 切换首选源（传 label 或 indexUrl；空串 = 回到默认） */
    pref: (label: string) => ipcRenderer.invoke('pysrc:pref', label),
    /** 加一个自定义 pip 索引 */
    add: (s: unknown) => ipcRenderer.invoke('pysrc:add', s),
    /** 删掉一个自定义源 */
    remove: (indexUrl: string) => ipcRenderer.invoke('pysrc:remove', indexUrl)
  },
  backups: {
    list: () => ipcRenderer.invoke('backup:list'),
    del: (file: string) => ipcRenderer.invoke('backup:del', file),
    restore: (args: unknown) => ipcRenderer.invoke('backup:restore', args),
    /** 在资源管理器里打开备份文件夹 */
    openFolder: (folder: string) => ipcRenderer.invoke('backup:openFolder', folder),
    /**
     * 覆盖更新时安装器自动打的整库数据备份。
     *
     * 和上面几个是**两回事**：上面是"某个实例的运行时备份"（用户手动点、
     * 可回滚），这里是"整套用户数据的快照"（安装器在覆盖更新前自动打的、
     * 只供查看和手工取用）。分区显示，避免用户把它们混为一谈。
     */
    updateList: () => ipcRenderer.invoke('backup:updateList')
  },
  app: {

    /* autostartStatus / setAutostart 已随「开机自启」功能整体移除（用户要求去掉） */
    /** QQ 环境检测：NapCat 注入 QQ 运行，没装/版本低要先引导用户去官网 */
    qqStatus: () => ipcRenderer.invoke('qq:status'),
    /** 用系统默认浏览器打开外部链接（QQ 官网下载页） */
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
    /* ---- 启动器自身更新（不是 AstrBot/NapCat 的运行时版本） ---- */
    /** 当前启动器版本号 */
    version: () => ipcRenderer.invoke('app:version'),
    /*
     * 上次是否异常退出（指导书 3.2）。
     * 渲染层启动时问一次：真崩过就提示用户"导出诊断日志"，
     * 否则用户永远不知道要去哪儿找证据。
     */
    lastCrash: () => ipcRenderer.invoke('app:lastCrash'),
    /** 检查更新；force=true 是用户手动点的，忽略「一天一次」 */
    checkUpdate: (p?: { force?: boolean }) => ipcRenderer.invoke('app:checkUpdate', p),
    /** 下载全量包到系统默认下载目录，返回落盘路径（不自动安装） */
    downloadUpdate: (p: { url: string; version: string; sha256?: string }) =>
      ipcRenderer.invoke('app:downloadUpdate', p),
    /** 跳过此版本（下个版本仍会提示） */
    skipVersion: (v: string) => ipcRenderer.invoke('app:skipVersion', v),
    /** 下载进度 */
    onUpdateProgress: (cb: (p: { percent: number; got: number; total?: number }) => void) => {
      const handler = (_e: unknown, p: { percent: number; got: number; total?: number }): void => cb(p)
      ipcRenderer.on('update:progress', handler)
      return () => ipcRenderer.removeListener('update:progress', handler)
    }
  },
  /** 主进程问「关窗口怎么办」时回调；用 answerClose 回话 */
  onAskClose: (cb: () => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('close:ask', handler)
    return () => ipcRenderer.removeListener('close:ask', handler)
  },
  answerClose: (v: 'tray' | 'quit') => ipcRenderer.send('close:answer', v)
}
