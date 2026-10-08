import { dirname, join } from 'path'
import { nativeImage } from 'electron'
import { readFileSync, existsSync } from 'fs'

/** 托盘模块（M4）：主进程挂 Tray；点 ✕ 走 closePolicy */
export interface CloseFlow {
  /** 返回 true=「继续关闭」；false=「已隐藏到托盘」 */
  onWindowCloseRequest: () => Promise<boolean>
  /**
   * 真的退出（用户点托盘的「退出」）。
   *
   * 必须单独暴露而不是让调用方直接 app.quit()：窗口的 close 拦截会把
   * quit 拦回来（策略=tray 时），导致托盘「退出」怎么点都退不掉。
   */
  quitForReal: () => void
}

/**
 * 找真图标。
 *
 * dev = 工程 build\icon.png；打包 = <安装目录>\resources\icon.png。
 *
 * 踩过的坑（用户报告「托盘还是没图标」）：
 * 原来只找 `process.cwd()\build\icon.png` 和 `<exe同级>\resources\icon.png`，
 * 而打包后这两个**都不存在**，于是每次都掉到那 32px 的兜底色块 ——
 * 托盘里就是一个看不出是什么的小方块。
 *
 * 而且它**一声不响**（没有任何日志），很难发现是「图标没找到」。
 * 现在把「用了兜底图」这件事报出来，下次一眼就能看出来。
 *
 * 【为什么图标走 extraResources 而不是 files】
 * files 里的东西打进 app.asar，而 nativeImage.createFromPath()
 * **读不了 asar 内部的文件**（路径 existsSync 得到，但拿到的是 empty image）。
 * extraResources 把它放在 asar 外面，用 process.resourcesPath 直接读。
 */
function loadIconImage(onFallback?: (reason: string) => void): import('electron').NativeImage {
  const exeDir = dirname(process.execPath)
  // 打包后 = <安装目录>\resources；extraResources 就落在这里，且在 asar 外面
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  const candidates = [
    // 打包态（首选）：electron-builder.yml 的 extraResources 放成 resources\icon.png
    ...(resourcesPath ? [join(resourcesPath, 'icon.png')] : []),
    // 开发态：工程根目录下的 build\icon.png
    join(process.cwd(), 'build', 'icon.png'),
    // 兼容旧布局 / 便携版
    join(exeDir, 'resources', 'icon.png'),
    join(exeDir, 'build', 'icon.png'),
    join(exeDir, 'icon.png')
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const img = nativeImage.createFromPath(p)
      // 读不了/损坏的文件会得到一个 empty image，不能直接拿去当图标
      if (!img.isEmpty()) return img
    } catch {
      /* 这个路径读不了就试下一个 */
    }
  }
  onFallback?.(`托盘图标没找到，已用兜底色块。找过：${candidates.join(' | ')}`)
  // 兜底：至少是个可见的 32px 实色块（不至于托盘一片空白）
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAHklEQVR42u3NMREAMAgEwPZf7x1mAwMDAwMDAwMDAwPjsk4MW4ADgNhVxgAAAABJRU5ErkJggg==',
    'base64'
  )
  return nativeImage.createFromBuffer(png)
}

export async function initTrayAndCloseFlow(deps: {
  getApp: () => Promise<typeof import('electron')>
  getMainWindow: () => import('electron').BrowserWindow | undefined
  /** 读当前 closePolicy */
  readClosePolicy: () => Promise<'tray' | 'quit' | undefined>,
  /** 记住用户选择（首次确认后 & 设置页改动） */
  setClosePolicy: (p: 'tray' | 'quit') => Promise<void>
  /** 首次点 ✕ 时问用户：交给渲染层的自研弹窗，返回用户选择 */
  askClosePolicy: () => Promise<'tray' | 'quit'>
  /** 白名单杀全部实例 */
  killAll: () => void
  /** 图标没找到时的回调（用于记日志，别让「用了兜底图」这件事无声无息） */
  onIconFallback?: (reason: string) => void
}): Promise<CloseFlow> {
  const { app, Tray, Menu } = await deps.getApp()

  const icon = loadIconImage((why) => deps.onIconFallback?.(why))
  let tray: import('electron').Tray | undefined
  /** 从托盘把主窗口叫回来（双击图标 / 菜单都走它） */
  const showMain = (): void => {
    const w = deps.getMainWindow()
    if (!w) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  }
  const ensureTray = (): void => {
    if (tray) return
    tray = new Tray(icon)
    tray.setToolTip('AstriaX —— 实例在后台运行中')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: showMain },
      { label: '退出（停止全部实例）', click: quitForReal }
    ]))
    // 双击托盘图标直接回主界面（Windows 上最自然的操作）
    tray.on('double-click', showMain)
  }

  /**
   * 真的退出（托盘菜单用）。
   *
   * 踩过的坑（用户报告「托盘点关闭无法关闭进程」）：
   * 原来这里只有一句 `app.quit()`。而 app.quit() 会先触发窗口的 'close'
   * 事件，那个 handler 又去问「关闭策略」—— 策略是 tray 时它会
   * `e.preventDefault()` 并把窗口藏起来，**于是 quit 被取消了**，
   * 程序一直留在托盘里，用户点多少次「退出」都没用。
   *
   * 现在先把窗口标记成「允许关闭」，再停实例、再退。
   * 顺序也很重要：killAll 必须在 quit 之前，否则事件循环开始拆了，
   * 子进程可能来不及收。
   */
  const quitForReal = (): void => {
    const w = deps.getMainWindow() as (import('electron').BrowserWindow & { __allowClose?: boolean }) | undefined
    if (w) w.__allowClose = true
    try {
      deps.killAll()
    } catch {
      /* 停实例失败也必须能退出，否则用户被彻底卡住 */
    }
    app.quit()
  }

  /**
   * 问用户首次关闭策略，**带超时与异常兜底**。
   *
   * 返回 `undefined` = 没问出来（超时 / 渲染层没准备好 / 询问通道出错）——
   * 与"用户明确选了 tray"是**不同**的语义，所以不在这里替代成 'tray'：
   * 调用方据此决定"这次先按托盘走"但**不落盘**（下次点 ✕ 还会再问）。
   *
   * ## 为什么必须超时
   *
   * `deps.askClosePolicy()` 是走渲染层弹窗实现的（主进程发 IPC、等答复）。
   * 渲染层还没加载完 / 正在崩溃重启 / 弹窗被并发覆盖时，那个 Promise
   * **永不结算**。而它上面那句 `e.preventDefault()` 已经执行了 ——
   * 窗口既不缩托盘也关不掉，用户只能去任务管理器杀进程。
   */
  const askWithFallback = async (): Promise<'tray' | 'quit' | undefined> => {
    try {
      return await Promise.race([
        deps.askClosePolicy(),
        /*
         * 超时兜底：5 秒。
         *
         * 正常操作（看到弹窗、读完、点一下）约 2-4 秒，5 秒够用；
         * 再长的话"点 ✕ 没反应"的观感就太明显了。
         */
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000))
      ])
    } catch {
      /* 询问通道本身出错（渲染层崩了 / IPC 异常）：同样走兜底，不抛出去 */
      return undefined
    }
  }

  return {
    onWindowCloseRequest: async () => {
      /*
       * 关闭行为：**没配置过就先问一次**，之后一直按记住的选择走。
       *
       * 用户要求（原话）：「为什么第一次点 X 关闭软件界面的时候不询问用户
       * 是托盘还是真的关闭」。
       *
       * 这里有个反复：更早的一份报告里写的是「不管点没点 X、进没进设置，
       * 都默认托盘」，所以当时把首次询问删掉了。现在用户明确要问，就加回来 ——
       * 而且只问一次（问完记住），不会每次都烦人。
       *
       * 为什么问而不是直接托盘：点 ✕ 时实例可能还在后台跑，
       * 直接缩托盘会让用户以为软件关了（其实还在跑）；
       * 直接退出又会把机器人全杀掉。这个选择交给用户，一次就好。
       *
       * `?? 'tray'` 这个兜底仍然保留，但只在**询问本身失败/超时**时生效
       * （那时保持安全行为：缩到托盘，不杀实例）。
       */
      const policy = await deps.readClosePolicy()
      if (!policy) {
        /*
         * ★ 从没选过 → 弹一次问用户。
         *
         * ══════════════════════════════════════════════════════════════════════
         * 必须加**超时 + try/catch**（子代理审计抓出：注释承诺了但代码没有）
         * ══════════════════════════════════════════════════════════════════════
         *
         * 上面注释写着「`?? 'tray'` 这个兜底仍然保留，但只在**询问本身失败/
         * 超时**时生效」—— 而原代码是一句裸的 `await deps.askClosePolicy()`，
         * **既没有 try/catch 也没有超时竞速**。于是：
         *
         *   · 渲染层还没加载完 / 正好在崩溃重启中 → 那个 Promise 永不结算
         *     → 这个函数永不返回 → 窗口已经被 preventDefault（不缩托盘），
         *       **也关不掉** —— 用户只能去任务管理器杀进程
         *   · 询问 reject（比如渲染层弹窗被并发覆盖，见 App.vue 的单槽位问题）
         *     → 未处理的 rejection，同样卡死
         *
         * ## 修法
         *
         * 5 秒超时 + catch，超时/失败一律**按 tray 处理**（安全的那一边：
         * 缩到托盘，不杀实例）。用户还能再点一次 ✕ 重新选择，
         * 而"卡住关不掉"是没法自救的。
         *
         * 为什么是 5 秒：用户看到弹窗、读完、点一下大约 2-4 秒；
         * 5 秒足够正常操作，又不至于让"关不掉"的观感持续太久。
         */
        const picked = await askWithFallback()
        if (picked) await deps.setClosePolicy(picked)
        /*
         * 超时/失败时 `picked` 为 undefined → **不当作用户选过了**（不写配置），
         * 这样下次点 ✕ 还会再问一次 —— 而不是把一次超时当成"他选了托盘"。
         */
        const decided = picked ?? 'tray'
        if (decided === 'quit') {
          deps.killAll()
          return true
        }
        const w = deps.getMainWindow()
        if (w) {
          w.hide()
          ensureTray()
        }
        return false
      }

      if (policy === 'quit') {
        deps.killAll()
        return true
      }
      const win = deps.getMainWindow()
      if (win) {
        win.hide()
        ensureTray()
      }
      return false
    },

    quitForReal
  }
}
