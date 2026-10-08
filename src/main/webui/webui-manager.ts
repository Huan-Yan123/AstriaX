import type { BrowserWindow } from 'electron'

export interface ViewHandle {
  loadURL: (url: string) => Promise<void>
  setBounds: (b: { x: number; y: number; width: number; height: number }) => void
  /** 缩放网页内容而不改变 WebUI 视图的外框尺寸。 */
  setZoomFactor?: (factor: number) => void
  destroy: () => void
  /**
   * 是否在视觉上显示（**可选** —— 测试注入的假 view 可以不实现）。
   *
   * 存在的理由见下面 open() 里那段长注释：多个 WebUI 视图会**互相堆叠**，
   * 需要能"只让当前这个可见"。
   */
  setVisible?: (v: boolean) => void
}

export interface WebUiDeps {
  /** 测试注入；生产= new WebContentsView */
  createView: (url: string) => ViewHandle
  attach: (view: ViewHandle, id: string) => void
  detach: (id: string) => void
  destroy?: (view: ViewHandle) => void
  /** 当前窗口布局位的边界（标题栏/侧栏之外的内容区） */
  boundsOf: () => { x: number; y: number; width: number; height: number }
  /** 页面加载上限，避免网络服务失效时 IPC 永久挂起 */
  loadTimeoutMs?: number
}

export interface WebUiManager {
  open: (id: string, url: string) => Promise<void>
  close: (id: string) => void
  /** 窗口 resize 后跟随重排 */
  resize: () => void
  list: () => string[]
  /** 当前**正在显示**的那个实例 id（没有则为 undefined） */
  visible: () => string | undefined
}

export function createWebUiManager(deps: WebUiDeps): WebUiManager {
  const open = new Map<string, ViewHandle>()
  const loaded = new Set<string>()
  const attached = new Set<string>()
  const pending = new Map<string, Promise<void>>()
  /**
   * 当前**可见**的那个实例 id。
   *
   * ══════════════════════════════════════════════════════════════════════════
   * ★★ 这个变量的存在是为了修一个真实 bug（用户 2026-09-26 反馈）★★
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 用户原话：「在 0.1.4 打开 AstrBot 的网页时，却跳转到了 NapCat 的网页
   *（而且不是同一个 NapCat），两者端口并不一致（AstrBot 6100、NapCat 6200），
   *  卸载重下后还是这样」。
   *
   * ## 根因：多个 WebContentsView **互相堆叠**
   *
   * 每个实例打开 WebUI 都会 `new WebContentsView()` 并 `addChildView` ——
   * 而所有视图拿到的 bounds **完全相同**（x=0, y=78, 全宽全高，见 ipc.ts 的 boundsOf）。
   * 于是它们不是"并排"，而是**一层盖一层**：Electron 里后 addChildView 的在最上层。
   *
   * 具体到用户的场景：
   *   1. 先打开 NapCat 的 WebUI（6200）→ 视图 A 铺满内容区
   *   2. 再打开 AstrBot 的 WebUI（6100）→ 视图 B 也铺满，**盖在 A 上**
   *   3. 此时点"收起"关掉 B（或从卡片上收起 AstrBot）→ 剩下的 A 露出来
   *      → 用户明明在看 AstrBot 的位置，屏幕上却是 **NapCat 的页面**
   * 而"不是同一个 NapCat、端口对不上"正是因为他原本开着的那个 NapCat
   * 是另一个实例 —— 视觉上完全对得起来。
   *
   * "卸载重装也一样"也印证了这是**逻辑问题**，不是残留状态：
   * 只要有"同时开着两个实例的 WebUI"这个操作，就必然复现。
   *
   * ## 修法：同一时刻只保留一个视图
   *
   * 界面本身也只需要看一个（顶部工具条上写着"当前是谁的 WebUI"）。
   * 所以：
   *   · 打开某个实例 → 先销毁其它实例视图，再加载并显示目标页面
   *   · 关闭当前实例 → 销毁视图并显示启动器
   *
   * 不保留隐藏视图：某些系统/窗口状态下旧子视图会重新露出，
   * 造成用户打开 AstrBot 却看到 NapCat。重新加载的代价小于显示错实例。
   */
  let visibleId: string | undefined
  let desiredId: string | undefined

  /** 只让 id 那个可见，其余隐藏（id 为空则全部隐藏） */
  function showOnly(id: string | undefined): void {
    const targetId = id && loaded.has(id) && open.has(id) ? id : undefined
    for (const [key, v] of open) {
      try {
        v.setVisible?.(key === targetId)
      } catch {
        /* 测试用的假 view 可能没实现；生产实现失败也不该让打开动作失败 */
      }
    }
    visibleId = targetId
  }

  /** 销毁旧实例的网页，避免 Electron 子视图层级/显隐状态导致旧页面重新露出。 */
  function destroyView(id: string): void {
    const view = open.get(id)
    if (!view) return
    open.delete(id)
    loaded.delete(id)
    if (attached.delete(id)) deps.detach(id)
    try {
      if (deps.destroy) deps.destroy(view)
      else view.destroy()
    } catch {
      // 已销毁的 pending view 可能再次进入清理路径。
    }
  }

  return {
    async open(id: string, url: string) {
      // 用户最后一次选择优先。更慢的旧加载不能在之后盖过新选择。
      desiredId = id
      // WebUI 视图各自占满窗口；保留隐藏页面会让旧 NapCat 在新页面
      // 关闭或加载失败时重新显露。切换时销毁旧视图，保证只有目标页面存在。
      for (const otherId of [...open.keys()]) {
        if (otherId !== id) destroyView(otherId)
      }
      const existing = open.get(id)
      if (existing) {
        /*
         * 已经开着 —— **也要把它切到最前**（修 stack 堆叠的关键一步）。
         *
         * 第一版这里是裸的 `return`：用户点一个早就开着的实例时，
         * 什么都不发生，屏幕上还是**之前那个盖在上面的**视图 ——
         * 正是"点 AstrBot 却看到 NapCat"的又一条复现路径。
         */
        const inFlight = pending.get(id)
        if (inFlight) {
          await inFlight
          if (desiredId === id && loaded.has(id)) showOnly(id)
        } else {
          showOnly(id)
        }
        return
      }
      const view = deps.createView(url)
      open.set(id, view)
      view.setBounds(deps.boundsOf())
      /*
       * 新视图先隐藏，等**加载完成**再显示 —— 与下面"先加载后挂载"的
       * 体感优化同一个道理（避免先糊一块白板）。
       */
      try {
        view.setVisible?.(false)
      } catch {
        /* 同上 */
      }
      /*
       * 顺序很关键：**先加载，加载完再显示**。
       *
       * 踩过的坑（用户报告「进出 WebUI 的时候也是卡半天才进出」）：
       * 原来是 attach → loadURL，也就是先把一个**还没加载的空视图**
       * 盖到界面上，然后才去加载页面。用户看到的是：
       *   点「WebUI」→ 界面立刻被一大块白板糊住 → 白板持续好几秒
       *   → 内容终于出来
       * 那几秒的「白板」就是卡顿感的来源。
       *
       * 反过来的话，界面保持原样直到页面加载完成，再一次性换过去 ——
       * 同样的加载时间，体感完全不同。
       *
       * 失败时要把已经登记的视图清掉，否则这个 id 会永远「打开着」，
       * 用户再点一次会被告知已经在开了（而其实什么都没显示）。
       */
      const task = (async () => {
        try {
          const timeoutMs = Math.max(1000, deps.loadTimeoutMs ?? 20_000)
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              view.loadURL(url),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`WebUI 加载超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs)
              })
            ])
          } finally {
            if (timer) clearTimeout(timer)
          }
          // close() may have destroyed this view while loadURL was pending.
          if (open.get(id) !== view) return
          // 保持视图外框不变，通过轻微缩放让控制台首屏容纳更多内容。
          // 缩放只作用于嵌入的 WebUI，不影响 AstriaX 自身界面。
          view.setZoomFactor?.(0.75)
          loaded.add(id)
          deps.attach(view, id)
          attached.add(id)
          if (desiredId === id) showOnly(id)
        } catch (e) {
          if (open.get(id) === view) {
            open.delete(id)
            loaded.delete(id)
            try {
              if (deps.destroy) deps.destroy(view)
              else view.destroy()
            } catch {
              /* 清理失败不该盖住真正的加载错误 */
            }
          }
          if (desiredId === id) desiredId = visibleId
          throw e
        }
      })()
      pending.set(id, task)
      try {
        await task
      } catch (e) {
        throw e
      } finally {
        if (pending.get(id) === task) pending.delete(id)
      }
    },

    close(id: string) {
      const view = open.get(id)
      if (!view) return
      destroyView(id)
      if (visibleId === id) visibleId = undefined
      if (desiredId === id) desiredId = undefined
    },

    resize() {
      const b = deps.boundsOf()
      for (const view of open.values()) view.setBounds(b)
    },

    list: () => [...open.keys()],

    visible: () => visibleId
  }
}

/** 生产侧：Electron WebContentsView 版 view 工厂 + 挂载器（主进程内同步可用） */
export function createElectronWebUi(win: BrowserWindow, onEscape?: () => void) {
  // require 而非顶层 import：本文件也被纯 Node 测试加载
  // eslint 侧允许 TypeScript 的 createRequire 方案
  const { createRequire } = require('module') as { createRequire: (p: string) => NodeRequire }
  const nodeRequire = createRequire(__filename)
  const { WebContentsView } = nodeRequire('electron') as typeof import('electron')

  return {
    createView: (url: string): ViewHandle => {
      const view = new WebContentsView()
      win.contentView.addChildView(view)
      // 逃生通道：WebUI 页面本身可能白屏/卡死，界面上的按钮也可能被盖住，
      // 所以直接在这个视图里挂快捷键——Esc 或 Ctrl+W 一定能把视图关掉。
      if (onEscape) {
        view.webContents.on('before-input-event', (_e, input) => {
          if (input.type !== 'keyDown') return
          const key = (input.key ?? '').toLowerCase()
          if (key === 'escape' || (input.control && key === 'w')) {
            onEscape()
          }
        })
      }
      const handle: ViewHandle = {
        loadURL: async (u) => {
          await view.webContents.loadURL(u)
        },
        setBounds: (b) => view.setBounds(b),
        setZoomFactor: (factor) => view.webContents.setZoomFactor(factor),
        /*
         * ★ 显隐控制（修"点 AstrBot 却看到 NapCat"的关键）
         *
         * `WebContentsView.setVisible(false)` 让视图**不参与绘制**，
         * 但**保留 webContents**（页面状态、登录态都在）——
         * 所以两个实例之间来回切不会每次都重新加载。
         *
         * 为什么不用 removeChildView：那会把它从窗口摘下来，
         * 再显示时要么重新 add（顺序又乱了）要么重新加载。
         */
        setVisible: (v: boolean) => {
          view.setVisible(v)
        },
        destroy: () => {
          win.contentView.removeChildView(view)
          view.webContents.close()
        }
      }
      void url
      return handle
    }
  }
}
