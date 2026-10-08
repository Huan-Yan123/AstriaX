import { describe, it, expect, vi } from 'vitest'

/*
 * tray.ts 顶部直接 `import { nativeImage } from 'electron'`（loadIconImage 用它
 * 去找图标），这条引入绕不过注入，所以把 electron 模块整个假掉。
 * 只实现这条测试路径用到的那几个成员。
 */
vi.mock('electron', () => {
  class FakeTray {
    setToolTip(): void {}
    setContextMenu(): void {}
    on(): void {}
  }
  return {
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => true }),
      createFromBuffer: () => ({})
    },
    Tray: FakeTray,
    Menu: { buildFromTemplate: () => ({}) },
    app: { quit: () => undefined },
    dialog: {},
    BrowserWindow: class {}
  }
})

import { initTrayAndCloseFlow } from '../../src/main/tray/tray'
import { buildHandlers } from '../../src/main/ipc'
import { createProcessManager } from '../../src/main/proc/process-manager'

const stubProbe = () => Promise.resolve(true)

/**
 * 关闭策略的契约：
 *
 *   **没配置过 → 弹一次询问；之后一律按记住的选择走。**
 *
 * 这条需求反复过一次，写清楚经过免得以后又改错方向：
 *   1. 早期版本：首次点 ✕ 弹窗问「缩到托盘还是直接退出」
 *   2. 中途一份报告要求「不管点没点 ✕、进没进设置，都默认托盘」，
 *      于是删掉询问，当时这里的测试断言 asked() === 0
 *   3. 现在用户明确要求把询问加回来：
 *      「为什么第一次点 X 关闭软件界面的时候不询问用户是托盘还是真的关闭」
 *
 * 所以现在的契约是：**问，但只问一次**（问完写回配置）。
 * 这样既尊重用户的选择，又不会每次都烦人。
 */
describe('closePolicy（关闭行为：首次询问一次，之后按记住的走）', () => {
  /** 造一个假的 electron 环境，只测关闭流程本身 */
  async function flow(
    readPolicy: () => Promise<'tray' | 'quit' | undefined>,
    opts: { quitCalls?: { n: number }; ask?: 'tray' | 'quit'; onSetPolicy?: (p: 'tray' | 'quit') => void } = {}
  ): Promise<{
    onWindowCloseRequest: () => Promise<boolean>
    quitForReal: () => void
    asked: () => number
    killed: () => number
    hidden: () => number
    allowClose: () => boolean
  }> {
    let asked = 0
    let killed = 0
    let hidden = 0
    const fakeWin = {
      isMinimized: () => false,
      show: () => undefined,
      focus: () => undefined,
      hide: () => {
        hidden++
      }
    } as unknown as import('electron').BrowserWindow & { __allowClose?: boolean }
    const f = await initTrayAndCloseFlow({
      // 只提供流程用到的部分，别真去 import electron
      getApp: async () =>
        ({
          app: {
            quit: () => {
              if (opts.quitCalls) opts.quitCalls.n++
            }
          },
          Tray: class {
            setToolTip(): void {}
            setContextMenu(): void {}
            on(): void {}
          },
          Menu: { buildFromTemplate: () => ({}) },
          nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createFromBuffer: () => ({}) },
          dialog: {},
          BrowserWindow: class {}
        }) as unknown as typeof import('electron'),
      getMainWindow: () => fakeWin,
      readClosePolicy: readPolicy,
      setClosePolicy: async (p) => {
        opts.onSetPolicy?.(p)
      },
      askClosePolicy: async () => {
        asked++
        return opts.ask ?? 'tray'
      },
      killAll: () => {
        killed++
      }
    })
    return {
      onWindowCloseRequest: f.onWindowCloseRequest,
      quitForReal: f.quitForReal,
      asked: () => asked,
      killed: () => killed,
      hidden: () => hidden,
      allowClose: () => fakeWin.__allowClose === true
    }
  }

  it('没配置过（undefined）→ **弹一次**询问，选了托盘就缩到托盘', async () => {
    const t = await flow(async () => undefined)
    const cont = await t.onWindowCloseRequest()
    expect(cont, '返回 false = 已隐藏到托盘，不继续关闭').toBe(false)
    expect(t.asked(), '第一次点 ✕ 必须问用户一次').toBe(1)
    expect(t.hidden()).toBe(1)
    expect(t.killed()).toBe(0)
  })

  it('没配置过 + 用户选「退出」→ 停掉全部实例并真的关掉', async () => {
    const t = await flow(async () => undefined, { ask: 'quit' })
    const cont = await t.onWindowCloseRequest()
    expect(cont, '选了退出 → 返回 true = 继续关闭').toBe(true)
    expect(t.asked(), '同样只问一次').toBe(1)
    expect(t.killed(), '退出前必须把实例停掉').toBe(1)
  })

  it('已经问过（配置存在）→ 不再重复询问，直接按记住的走', async () => {
    // 「只问一次」的核心：选完写回配置，之后绝不能再弹
    const t = await flow(async () => 'tray')
    await t.onWindowCloseRequest()
    await t.onWindowCloseRequest()
    expect(t.asked(), '第二次、第三次都不该再问').toBe(0)
  })

  it('询问结果必须写回配置，否则「只问一次」不成立', async () => {
    let saved: 'tray' | 'quit' | undefined
    const t = await flow(async () => undefined, {
      ask: 'quit',
      onSetPolicy: (p) => {
        saved = p
      }
    })
    await t.onWindowCloseRequest()
    expect(saved, '用户的选择要持久化，下次启动才知道不用再问').toBe('quit')
  })

  it('配置成 tray → 缩到托盘', async () => {
    const t = await flow(async () => 'tray')
    expect(await t.onWindowCloseRequest()).toBe(false)
    expect(t.asked()).toBe(0)
    expect(t.hidden()).toBe(1)
  })

  it('配置成 quit → 停掉全部实例并真的退出', async () => {
    const t = await flow(async () => 'quit')
    expect(await t.onWindowCloseRequest(), '返回 true = 继续关闭').toBe(true)
    expect(t.killed(), '退出前必须把实例停掉').toBe(1)
  })

  it('默认配置里**不写** closePolicy —— 否则「首次询问」永远不会触发', async () => {
    const h = buildHandlers({ probe: stubProbe, processManager: createProcessManager() })
    /*
     * 这条断言背后的坑：config:set 会把 DEFAULTS 铺开写进配置。
     * 所以只要 DEFAULTS 里有 closePolicy:'tray'，用户**随便改点什么**
     * （哪怕只是端口）都会被填成 'tray'，关闭流程就再也看不到 undefined，
     * 「问一次」的分支变成死代码 —— 看起来实现了，其实从不触发。
     */
    await h['config:set']({ dataRoot: 'E:\\somewhere' })
    const cfg = (await h['config:get']()) as { closePolicy?: string }
    expect(cfg.closePolicy, '必须保持 undefined，等用户自己选一次').toBeUndefined()
  })

  it('用户选过之后才有 closePolicy', async () => {
    const h = buildHandlers({ probe: stubProbe, processManager: createProcessManager() })
    await h['config:set']({ dataRoot: 'E:\\somewhere' })
    await h['config:set']({ closePolicy: 'tray' })
    expect(((await h['config:get']()) as { closePolicy?: string }).closePolicy).toBe('tray')
  })

  it('用户改成 quit 后能持久化，后续仍可改回 tray', async () => {
    const h = buildHandlers({ probe: stubProbe, processManager: createProcessManager() })
    await h['config:set']({ dataRoot: 'E:\\somewhere', closePolicy: 'quit' })
    expect(((await h['config:get']()) as { closePolicy: string }).closePolicy).toBe('quit')
    await h['config:set']({ closePolicy: 'tray' })
    expect(((await h['config:get']()) as { closePolicy: string }).closePolicy).toBe('tray')
  })
})

/**
 * 用户报告：「托盘点关闭无法关闭进程」。
 *
 * 根因：托盘菜单原来直接调 app.quit()，而 app.quit() 会先触发窗口的
 * 'close' 事件 —— 那个 handler 去问关闭策略，策略是 tray 时它
 * preventDefault() 并把窗口藏起来，**于是 quit 被取消了**。
 * 结果是「退出」菜单项怎么点都退不掉，程序永远留在托盘里。
 *
 * 修法：走 quitForReal()，先把窗口标成允许关闭，再停实例，最后 quit。
 */
describe('托盘「退出」必须真的退得掉', () => {
  it('quitForReal：先允许关闭、再停实例、最后才 quit', async () => {
    /*
     * 顺序很关键：
     *   - 不先设 __allowClose，窗口的 close 拦截会把 quit 拦回来
     *   - killAll 必须在 quit 之前，否则事件循环开始拆了，子进程来不及收
     * 这里用一个「谁先被调」的序列把它钉死。
     */
    const order: string[] = []
    const quitCalls = { n: 0 }
    const t = await flowWithOrder(order, quitCalls)

    t.quitForReal()

    expect(quitCalls.n, 'app.quit() 必须被调用（否则进程留在托盘不消失）').toBe(1)
    expect(order, '必须按「允许关闭 → 停实例 → quit」的顺序').toEqual(['allow', 'kill', 'quit'])
  })

  it('对照：不设 __allowClose 时，窗口 close 拦截会把关闭挡回去（复刻旧 bug）', async () => {
    /*
     * 这条是上面那条的**反面**，用来证明「为什么不直接 app.quit()」。
     *
     * 策略=tray 时，窗口关闭请求会被拦下（返回 false = 不继续关闭）。
     * 也就是说 app.quit() 走到窗口那一步就会被挡回来 ——
     * 这正是用户遇到的「点了退出没反应」。
     */
    const t = await (async () => {
      // 复用同一个 helper，但这里只看 onWindowCloseRequest 的返回值
      return flowRow(async () => 'tray')
    })()
    expect(await t.onWindowCloseRequest(), 'false = 关闭被拦下了（旧 bug 的机制）').toBe(false)
  })
})

/** 带调用顺序记录的 flow */
async function flowWithOrder(
  order: string[],
  quitCalls: { n: number }
): Promise<{ quitForReal: () => void }> {
  const fakeWin = {
    isMinimized: () => false,
    show: () => undefined,
    focus: () => undefined,
    hide: () => undefined,
    set __allowClose(v: boolean) {
      if (v) order.push('allow')
    },
    get __allowClose(): boolean {
      return true
    }
  } as unknown as import('electron').BrowserWindow & { __allowClose?: boolean }

  const f = await initTrayAndCloseFlow({
    getApp: async () =>
      ({
        app: {
          quit: () => {
            order.push('quit')
            quitCalls.n++
          }
        },
        Tray: class {
          setToolTip(): void {}
          setContextMenu(): void {}
          on(): void {}
        },
        Menu: { buildFromTemplate: () => ({}) },
        nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createFromBuffer: () => ({}) },
        dialog: {},
        BrowserWindow: class {}
      }) as unknown as typeof import('electron'),
    getMainWindow: () => fakeWin,
    readClosePolicy: async () => 'tray',
    setClosePolicy: async () => undefined,
    askClosePolicy: async () => 'tray',
    killAll: () => order.push('kill')
  })
  return { quitForReal: f.quitForReal }
}

/** 只要 onWindowCloseRequest 的最小 flow（对照用） */
async function flowRow(readPolicy: () => Promise<'tray' | 'quit' | undefined>): Promise<{
  onWindowCloseRequest: () => Promise<boolean>
}> {
  const fakeWin = {
    isMinimized: () => false,
    show: () => undefined,
    focus: () => undefined,
    hide: () => undefined
  } as unknown as import('electron').BrowserWindow
  const f = await initTrayAndCloseFlow({
    getApp: async () =>
      ({
        app: { quit: () => undefined },
        Tray: class {
          setToolTip(): void {}
          setContextMenu(): void {}
          on(): void {}
        },
        Menu: { buildFromTemplate: () => ({}) },
        nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createFromBuffer: () => ({}) },
        dialog: {},
        BrowserWindow: class {}
      }) as unknown as typeof import('electron'),
    getMainWindow: () => fakeWin,
    readClosePolicy: readPolicy,
    setClosePolicy: async () => undefined,
    askClosePolicy: async () => 'tray',
    killAll: () => undefined
  })
  return { onWindowCloseRequest: f.onWindowCloseRequest }
}
