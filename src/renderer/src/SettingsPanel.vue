<script setup lang="ts">
import settingsMascot from './assets/mascot-settings.png'
import { ref, onMounted, onBeforeUnmount } from 'vue'

const emit = defineEmits<{ close: []; moved: [] }>()

/*
 * 本组件用到的窗口桥。
 *
 * 项目里没有全局 `Window` 声明，每个组件各自 declare 自己用到的那几个方法
 * （App.vue 也是这么做的）。所以这里声明的是**本文件实际会调的那些**，
 * 不是全部 preload API。
 */
declare const window: {
  launcher?: {
    config?: {
      get: () => Promise<Record<string, unknown>>
      set: (p: unknown) => Promise<void>
      /**
       * 迁移数据目录。返回**搬失败的项**（空数组 = 全部搬好）。
       * 主进程侧早就把失败收集好返回了，这里必须消费它 ——
       * 不然用户看到的是「迁移成功」，而新根其实是残缺的。
       */
      moveDataDir?: (
        target: string
      ) => Promise<{ movedCount: number; failed: Array<{ item: string; reason: string }> }>
    }
    /** 目录选择框在 dialog 下（不在 config 下），取消返回 null */
    dialog?: { pickDataDir?: () => Promise<string | null> }
    logs?: { exportZip?: () => Promise<string> }
  }
}

const dataRoot = ref('')
const exporting = ref(false)
const exportedPath = ref('')
const exportErr = ref('')
const closePolicy = ref<'tray' | 'quit' | undefined>(undefined)

/**
 * 官方群 —— **全项目唯一的反馈渠道**（主人 2026-10-08）。
 *
 * ## 为什么去掉了个人 QQ
 *
 * 原来这里是"私聊 QQ + 官方群"并列，主人要求去掉个人号。理由是对的：
 *   · **不会因为一个人不在线而失效** —— 群里总有人能搭把手
 *   · **门槛更低** —— 很多人不愿意私聊陌生人，群里问一句压力小得多
 *   · **答案能被后来的人搜到** —— 私聊的解答只有两个人看得到
 *
 * 与 `App.vue` / `stores/dialog.ts` / `DownloadPage.vue` 里那份是同一个号：
 * 报错弹窗捕捉"当下就卡住了"，设置页兜住"事后想找人问问"。
 * 渲染层没有共享常量的地方，所以各写一份 —— 测试会校验它们一致。
 */
const OFFICIAL_GROUP = '1077554004'

/*
 * 迁移数据目录。
 *
 * 主进程侧的 `config:moveDataRoot` 一直是完整的（停实例 → 复制家当 → 写指针），
 * 但**渲染层从来没有入口** —— 设置页只把目录当只读文本显示。
 * 于是这个功能在实际使用中根本摸不到（审计发现的"断头路"）。
 *
 * 这里补上按钮，并且**必须把 failed[] 显示出来**：
 * 迁移时若有文件被占用没复制过去（最典型的是 NapCat 注入的 QQ 占着
 * runtimes 里的 .pyd/.db-wal），主进程会如实回报，而用户在新根启动实例
 * 会莫名其妙失败 —— 不显示的话他永远想不到是迁移漏了。
 */
const moving = ref(false)
const moveErr = ref('')
const moveNote = ref('')
const moveFailed = ref<Array<{ item: string; reason: string }>>([])
/** 主进程里"正在搬家"的开始时刻（0 = 没在搬）；用于重进设置页时恢复显示 */
const moveStartedAt = ref(0)
/** 已搬秒数（每 500ms 由轮询更新，让用户看到"真的在动"而不是卡住） */
const moveElapsedSec = ref(0)

/**
 * ★ 轮询主进程的搬家状态（修「关掉设置页就看不见、还能再点一次」）
 *
 * 主人实测的坑：点了搬家 → 没等完就关掉设置页 → 再点进来，
 * 界面上又是"可以搬"的样子 —— 而主进程里的复制其实还在跑。
 * 界面的"进行中"状态不能存在组件变量里，必须问主进程（进程级真相）。
 *
 * 为什么用轮询而不是事件推送：搬家是低频、长时（分钟级）的操作，
 * 500ms 轮询的开销可忽略，而它天然免疫"关闭页面期间错过的推送"——
 * 这正是这个 bug 的本质（错过一次性事件）。简单可靠 > 花哨。
 */
let movePoll: ReturnType<typeof setInterval> | undefined
async function pollMoving(): Promise<void> {
  try {
    const s = await window.launcher?.config?.moving?.()
    const active = Boolean(s?.active)
    // 已在进行中就保持按钮禁用；同时算"搬了多久"给用户看进度感
    moving.value = active
    moveStartedAt.value = active ? Number(s?.startedAt ?? 0) : 0
    moveElapsedSec.value = active && moveStartedAt.value
      ? Math.max(0, Math.round((Date.now() - moveStartedAt.value) / 1000))
      : 0
    if (!active && moveStartedAt.value === 0) moveElapsedSec.value = 0

    /*
     * ★ 上次搬家的**结果**也来自主进程（审计抓出的真问题）
     *
     * 原来失败清单只存在本组件的 ref 里，而搬家成功后本组件会被父组件
     * 立刻卸载（emit('moved') → settingsOpen=false，v-if 直接销毁）——
     * 于是"有 N 项没搬过去"这句话根本没机会显示，用户重进也看不到，
     * 只剩日志里一条 WARN。而失败项正是最需要被看见的（那些实例
     * 在新根可能起不来）。
     *
     * 现在结果托管在主进程，这里在"没在搬"且本次会话还没显示过时补上。
     */
    const last = s?.last
    if (!active && last && last.at !== lastShownRelocateAt) {
      lastShownRelocateAt = last.at
      if (last.failed?.length) {
        moveFailed.value = last.failed
        moveNote.value = `上次搬家有 ${last.failed.length} 项没能搬过去（下面都列出来了）`
      }
    }
  } catch {
    /* 查询失败不动界面：这是状态提示，不是关键路径 */
  }
}
/** 已经展示过的"上次搬家结果"时间戳（避免每 500ms 重复覆盖用户刚点的提示） */
let lastShownRelocateAt = 0
onMounted(() => {
  /*
   * 进来先问一次（恢复"还在搬"的显示），再持续轮询。
   * 只有真在搬时才需要高频；不过 500ms 一次 IPC 的成本低于
   * "状态不同步导致用户重开一次搬家"的代价，所以常开。
   */
  void pollMoving()
  movePoll = setInterval(() => void pollMoving(), 500)
})
onBeforeUnmount(() => {
  if (movePoll) clearInterval(movePoll)
  movePoll = undefined
})

async function moveDataDir(): Promise<void> {
  moveErr.value = ''
  moveNote.value = ''
  moveFailed.value = []
  /*
   * 前提检查：主进程里已有搬家在跑时直接拦住并说明 ——
   * 并行两份复制会把同一个目标写成"半新半旧"的混合体，
   * 是最不能容忍的一类损坏（粘贴数据时尤其）。
   */
  if (moving.value) {
    moveErr.value = '上一次搬家还在进行中哦，等它搬完再试呀。'
    return
  }
  let target: string | null = null
  try {
    target = (await window.launcher?.dialog?.pickDataDir?.()) ?? null
  } catch (e) {
    moveErr.value = `目录选择框打不开呢：${e instanceof Error ? e.message : String(e)}`
    return
  }
  if (!target) return // 用户取消了

  moving.value = true
  try {
    const r = await window.launcher?.config?.moveDataDir?.(target)
    dataRoot.value = target
    const failed = r?.failed ?? []
    moveFailed.value = failed
    if (failed.length) {
      // 有漏项：如实说，别报「成功」
      moveNote.value = `数据目录已经切到新位置啦，不过有 ${failed.length} 项没能搬过去（下面都列出来了）`
    } else {
      moveNote.value = '数据目录搬完啦，原来那个目录可以自己删掉哦~'
    }
    // 让 App 刷新实例列表（路径变了）
    emit('moved')
  } catch (e) {
    moveErr.value = `迁移没能完成呢：${e instanceof Error ? e.message : String(e)}`
  } finally {
    moving.value = false
    // 立刻回读一次主进程状态：以免"刚结束但还没轮到下一次轮询"的窗口里
    // 按钮又显示成可点（真正的权威是主进程的 relocateActive）
    void pollMoving()
  }
}

/*
 * 启动器自身更新。
 *
 * 用户要求：设置里显示当前版本 + 检查更新；有新版就提示，点更新从服务器
 * 下全量包存到系统默认下载目录。**从服务器取版本失败时显示「最新版」**
 * （用户明确这么要求的 —— 失败就当最新，不打扰）。用户也可以跳过此版本，
 * 跳过后要等到**下一个**版本才再弹窗。
 *
 * 注意和「运行时版本」（AstrBot / NapCat 的版本）不是一回事：
 * 那个是下载页在管，这里是启动器自己的版本。两者别混。
 */
const currentVersion = ref('')
const checking = ref(false)
const updMsg = ref('')
const updErr = ref(false)
const updPct = ref(0)
const downloading = ref(false)
const skipNote = ref('')
/** 下载完的安装包路径（用来点「打开所在文件夹」） */
const savedPath = ref('')
const updInfo = ref<{
  hasUpdate: boolean
  version?: string
  url?: string
  sizeMB?: number
  sha256?: string
  notes?: string
} | null>(null)

interface UpdApi {
  app?: {
    version?: () => Promise<string>
    checkUpdate?: (opts?: { force?: boolean }) => Promise<{
      hasUpdate: boolean
      latestVersion?: string
      version?: string
      url?: string
      sizeMB?: number
      sha256?: string
      notes?: string
      checkedAt?: number
      throttled?: boolean
    }>
    downloadUpdate?: (p: {
      url: string
      version: string
      sha256?: string
      sizeMB?: number
    }) => Promise<string>
    skipVersion?: (v: string) => Promise<void>
    onUpdateProgress?: (cb: (p: { percent: number }) => void) => () => void
  }
  shell?: {
    openPath?: (p: string) => Promise<unknown>
    showItem?: (p: string) => Promise<unknown>
  }
}

const updApi = (): UpdApi => (window.launcher as unknown as UpdApi) ?? {}

async function checkUpdate(force = false): Promise<void> {
  checking.value = true
  updMsg.value = ''
  updErr.value = false
  skipNote.value = ''
  try {
    /*
     * 手动点「检查更新」必须**强制**，不走 24 小时节流。
     *
     * 踩过的坑（审计实跑确认）：主进程 app:checkUpdate 有节流 ——
     * 24 小时内重复调用直接返回 `hasUpdate:false, throttled:true`。
     * 而启动时的静默检查会先把节流时间戳写掉，于是用户当天在设置页
     * 点「检查更新」，**永远显示「已是最新版本」，哪怕真有新版**。
     * 那颗按钮实际上是个摆设。
     *
     * 节流的意义是「别让软件自己反复联网」，不该拦用户主动点的这一次。
     */
    const r = await updApi().app?.checkUpdate?.(force ? { force: true } : undefined)
    /*
     * 字段名必须和主进程返回的一致。
     *
     * 踩过的坑：主进程 checkAppUpdate 返回的是 `latestVersion`，
     * 而这里原来读的是 `r.version` —— 永远 undefined，
     * 于是检查成功也只会显示「发现新版本 undefined」。
     * 两个名字都认一下，免得以后再改一边又对不上。
     */
    const latest = (r?.latestVersion ?? (r as { version?: string } | undefined)?.version) ?? ''
    updInfo.value = r
      ? {
          hasUpdate: r.hasUpdate,
          version: latest,
          url: r.url,
          sizeMB: r.sizeMB,
          // sha256 / notes 一并带下去：前者用于下载校验，后者是更新说明
          sha256: r.sha256,
          notes: r.notes
        }
      : { hasUpdate: false }
    if (r?.hasUpdate && latest) {
      updMsg.value = `发现新版本 ${latest}${r.sizeMB ? `（${r.sizeMB} MB）` : ''} 呀`
    } else {
      updMsg.value = '已是最新版本啦'
    }
  } catch {
    /*
     * 用户要求：从服务器取版本失败就显示「最新版」。
     *
     * 而且**不能把原始报错显示出来**（用户原话：
     * 「不是说了检查失败就显示最新版吗，为什么还要显示报错，
     * 报错不应该显示出来」）。
     *
     * 原来这里虽然把 updErr 置成了 false（不标红），但仍然拼了一句
     * `（检查更新失败：${e.message}）` 渲染出去 —— 那句在实机上就是
     *   Error invoking remote method 'app:checkUpdate':
     *   ReferenceError: app is not defined
     * 对用户纯属噪音：既看不懂，也不知道该做什么。
     *
     * 所以这里**彻底不显示**任何失败信息，也不记 skipNote。
     * 失败与「确实是最新」在界面上就是一个样子 —— 这正是用户要的语义：
     * 网络不通/服务器挂了不该在设置界面制造焦虑。
     * （真要排查的话日志里有，不必摆在用户脸上。）
     */
    updInfo.value = { hasUpdate: false }
    updErr.value = false
    updMsg.value = '已是最新版本啦'
  } finally {
    checking.value = false
  }
}

async function doUpdate(): Promise<void> {
  const info = updInfo.value
  /*
   * ★ 缺 url/version 时**必须说出来**，不能静默 return
   *   （主人 2026-09-27：「点下载怎么没反应」）
   *
   * 原来这里是一句光秃秃的 `return` —— 缺字段就什么都不做、也不报错。
   * 而**真的会发生**缺字段：主进程曾经有一条路径（electron-updater）
   * 只回 `{ hasUpdate: true, latestVersion }`，**不带 url**，
   * 于是用户看到一个"发现新版本"的提示，点「下载更新」**毫无反应**，
   * 连个错误都没有 —— 那是最让人恼火的一类失败。
   *
   * 主进程那条路径已经修掉了（现在只有 latest.json 一个来源，永远带 url），
   * 但这里仍要保留兜底提示：**任何"点了没反应"都是缺陷**，
   * 哪怕将来又引入了别的来源。
   */
  if (!info?.url || !info.version) {
    updErr.value = true
    updMsg.value = '这条更新信息不完整，暂时下不了 —— 过一会儿再点「检查更新」试试'
    return
  }
  downloading.value = true
  updPct.value = 0
  updMsg.value = ''
  try {
    // 进度订阅（主进程推 update:progress）
    const off = updApi().app?.onUpdateProgress?.((p) => {
      updPct.value = Math.max(0, Math.min(100, Math.round(p.percent)))
    })
    try {
      /*
       * sha256 必须传下去。
       *
       * 踩过的坑（审计发现）：主进程 downloadUpdate 会拿 `expectSha256` 校验，
       * 而这里（和 App.vue 的静默下载）都只传了 {url, version} —— 于是
       * **下载完成的东西永远不会被校验**。服务器换了包、网络中间截断、
       * 或者发布时传错文件，用户拿到的都是「下载成功」的坏安装包，
       * 双击才失败，而且看不出为什么。
       *
       * 清单里本来就有 sha256，顺手带上就够了。没有的话主进程也不强求
       * （老清单可能没有这个字段），所以是可选传。
       */
      const saved = await updApi().app?.downloadUpdate?.({
        url: info.url,
        version: info.version,
        sha256: info.sha256,
        sizeMB: info.sizeMB
      })
      savedPath.value = saved ?? ''
      updMsg.value = saved ? '下载好啦' : '下载好啦'
      updInfo.value = { hasUpdate: false }
    } finally {
      off?.()
    }
  } catch (e) {
    updErr.value = true
    updMsg.value = `下载更新失败了呀：${e instanceof Error ? e.message : String(e)}`
  } finally {
    downloading.value = false
  }
}

/**
 * 打开安装包所在位置（或直接打开那个文件）。
 *
 * 原来下载完只把路径当纯文本渲染（「已下载到：C:\...」），用户得自己
 * 一层层翻到目录里去找 —— 尤其是便携版装在 D 盘某个深层目录时很烦。
 * 主进程已经有 shell.openPath / showItemInFolder 的能力（app:openPath），
 * 这里接上就行。
 */
async function openSaved(): Promise<void> {
  const p = savedPath.value
  if (!p) return
  try {
    // 优先「在文件夹里显示并选中」——比单纯打开目录更直观
    await updApi().shell?.showItem?.(p)
  } catch {
    try {
      await updApi().shell?.openPath?.(p)
    } catch {
      /* 打不开就算了，路径本身还显示在界面上，用户可以手抄 */
    }
  }
}

async function skipVersion(): Promise<void> {
  const v = updInfo.value?.version
  if (!v) return
  await updApi().app?.skipVersion?.(v)
  updInfo.value = { hasUpdate: false }
  updMsg.value = `已经跳过 ${v} 啦，下个版本发布时会再提醒你`
}

onMounted(async () => {
  const cfg = (await window.launcher?.config?.get()) ?? {}
  dataRoot.value = (cfg.dataRoot as string) ?? ''
  closePolicy.value = cfg.closePolicy as 'tray' | 'quit' | undefined
  try {
    currentVersion.value = (await updApi().app?.version?.()) ?? '未知'
  } catch {
    currentVersion.value = '未知'
  }
})

async function setPolicy(p: 'tray' | 'quit'): Promise<void> {
  closePolicy.value = p
  await window.launcher?.config?.set({ closePolicy: p })
}

/* ══════════════════════════════════════════════════════════════════════════
 * ★ Python 源的加载与切换逻辑已**从这里移除**（主人 2026-09-27）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 原先设置页有一个「AstrBot 的 Python 源」选择器，后来按主人要求
 * 「为什么打开设置里有选择 astrbot 镜像源的」把它撤了 ——
 * 源的选择**统一归到「下载」页**（AstrBot 下载 / NapCat 下载两个分区）。
 *
 * 逻辑本身（loadPySources / setPySource / pySources / pyActive / pySrcErr）
 * 一并删掉，而不是留着不用的代码：
 *   · 留着会被下次改动的人误以为"设置页还能选源"，从而改错地方
 *   · 更重要的是它会在 onMounted 里发一次**没人看的 IPC**
 *
 * 后端的 `pysrc:*` 四个通道**一个都没删**（下载页在用）。
 */

async function exportLogs(): Promise<void> {
  exporting.value = true
  exportErr.value = ''
  try {
    exportedPath.value = (await window.launcher?.logs?.exportZip()) ?? ''
  } catch (e) {
    exportErr.value = String(e instanceof Error ? e.message : e)
  } finally {
    exporting.value = false
  }
}

/*
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 重新打开设置时，**恢复"正在打包…"的真实状态**
 *   （主人 2026-09-27 实测：「导出日志没导出完的时候关闭设置弹窗，
 *     再点进去就又可以导出日志了，明明上次的就没导出完整」）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `exporting` 是**这个组件的 ref** —— 弹窗一关组件卸载、它归零，
 * 重开时又是 false，按钮显示"导出日志"且可点。
 * **界面在骗人**：主进程其实还在打包（它有防重入，第二次会拿到同一个 Promise）。
 *
 * 修法：状态归主进程。挂载时问一次 `logs:exportBusy`，
 * 据此把按钮恢复成"正在打包…"。
 *
 * 打包结束后还要**自动刷新**（否则用户得再关开一次才看到结果）：
 * 主进程那边没有进度推送通道，所以这里用轻量轮询 ——
 * 只在"已知在打包"时才轮询，结束就停（不会常开）。
 */
let busyPoll: ReturnType<typeof setInterval> | undefined

function stopBusyPoll(): void {
  if (busyPoll) {
    clearInterval(busyPoll)
    busyPoll = undefined
  }
}

onMounted(() => {
  void (async () => {
    try {
      const busy = (await window.launcher?.logs?.exportBusy?.()) ?? false
      if (!busy) return
      /*
       * 主进程说"在打包" → 恢复按钮状态，并轮询到它结束。
       *
       * 为什么轮询而不是等事件：导出日志是个**低频**操作，
       * 为它加一条 IPC 推送通道（还要处理订阅/退订）成本更高。
       * 而这里只在"确实在打包"的窗口期内轮询（1 秒一次），
       * 打包完就停 —— 不留常开定时器。
       */
      exporting.value = true
      stopBusyPoll()
      busyPoll = setInterval(() => {
        void (async () => {
          try {
            const still = (await window.launcher?.logs?.exportBusy?.()) ?? false
            if (!still) {
              exporting.value = false
              stopBusyPoll()
            }
          } catch {
            /* 查询失败就当结束（别把按钮永久锁住） */
            exporting.value = false
            stopBusyPoll()
          }
        })()
      }, 1000)
    } catch {
      /* 查询失败无所谓：按钮按"没在打包"显示，用户再点一次也无害 */
    }
  })()
})

onBeforeUnmount(stopBusyPoll)
</script>

<template>
  <Teleport to="body">
    <Transition name="setmask">
      <div class="mask" @click.self="emit('close')">
        <Transition name="setpop" appear>
          <div class="panel">
            <img class="settings-mascot" :src="settingsMascot" alt="" aria-hidden="true" />
            <header>
              <h2>设置</h2>
              <button class="x" @click="emit('close')">✕</button>
            </header>

            <div class="grid">
      <section class="card">
        <div class="logrow">
          <b>数据目录</b>
          <button class="pick sm" :disabled="moving" @click="moveDataDir">
            {{ moving ? '搬家中…' : '搬到别处去' }}
          </button>
        </div>
        <p class="path">{{ dataRoot || '（未设置）' }}</p>
        <!--
          ★ 搬家进行中的横幅（主人实测：关掉设置页再进来就"看不见在搬了"）
          状态来自主进程（config:moving），所以关掉页面/切页/重进都能看到。
          顺带显示"已经搬了 N 秒"—— 长复制最怕"看不出在动"。
        -->
        <p v-if="moving" class="hint moving">
          正在搬家哦，已经搬了 {{ moveElapsedSec }} 秒 —— 复制期间**先别关软件**（关掉设置页没关系，它会在后台继续搬）。
        </p>
        <p class="hint">
          搬家会把实例、运行时、日志等等**全部**家当复制到新位置，原来的目录会留着（确认没问题之后可以自己删）。
        </p>
        <p v-if="moveNote" class="hint">{{ moveNote }}</p>
        <p v-if="moveErr" class="hint err">{{ moveErr }}</p>
        <!-- 没搬过去的项必须列出来：用户在新根启动实例失败时，这条就是答案 -->
        <ul v-if="moveFailed.length" class="faillist">
          <li v-for="(f, i) in moveFailed" :key="i">
            <b>{{ f.item }}</b> —— {{ f.reason }}
          </li>
        </ul>
      </section>

      <section class="card">
        <div class="logrow">
          <b>当前版本</b>
          <!-- 手动点必须强制刷新：否则会被启动时的 24h 节流吞掉，永远显示「已是最新」 -->
          <button class="pick sm" :disabled="checking" @click="checkUpdate(true)">
            {{ checking ? '看看有没有新的…' : '检查更新' }}
          </button>
        </div>
        <p class="path">AstriaX {{ currentVersion }}</p>
        <!--
          更新状态。
          注意「取版本失败」的表现：用户明确要求**失败就显示「最新版」**
          （见 checkUpdate 里的处理），所以这里的 updErr 只用于「下载」阶段的报错，
          不会把检查失败渲染成红色错误。
        -->
        <p v-if="updMsg" class="hint" :class="{ err: updErr }">{{ updMsg }}</p>
        <!-- 下载完的安装包：给出路径 + 一键打开所在文件夹 -->
        <p v-if="savedPath" class="hint">
          已经下载好啦：<span class="pathinline">{{ savedPath }}</span>
          <button class="linkbtn" @click="openSaved">打开它所在的文件夹</button>
        </p>
        <!-- 更新说明（服务器 latest.json 的 notes） -->
        <p v-if="updInfo?.hasUpdate && updInfo.notes" class="notes">{{ updInfo.notes }}</p>
        <div v-if="updInfo?.hasUpdate" class="updrow">
          <button class="pick primary sm" :disabled="downloading" @click="doUpdate">
            {{ downloading ? `下载中 ${updPct}%` : '下载更新' }}
          </button>
          <button class="pick sm" :disabled="downloading" @click="skipVersion">跳过这个版本</button>
        </div>
        <!-- 真的卡在 0% 时给一句话，别让用户对着不动的按钮发呆 -->
        <p v-if="downloading && updPct === 0" class="hint">
          正在连下载服务器呢…网络慢的话这一步会等一小会儿
        </p>
        <p v-if="skipNote" class="hint">{{ skipNote }}</p>
      </section>

      <!--
        ★ AstrBot 的「Python 源」（主人 2026-09-26 的需求）
        「astrbot 的换个版本应该是从 astrbot 的 py 源里用户自己选」
        「astrbot 从 GitHub 源剥离，单独做一个 python 源来安装 astrbot」

        主进程那四个 pysrc:* handler 早就实现了，但**界面一直没有入口** ——
        于是 pip 源永远是默认的 PyPI 官方、用户改不了（第二轮复审抓出的
        "只落地了一半"）。这里补上选择器。

        两个刻意的设计：
          · 每项都显示**实测备注**（哪些能列版本、哪些只能加速）——
            用户不该为了选源去猜
          · 说明里写清「装用这个源，列版本仍问 PyPI 官方」——
            因为国内镜像**没有** /pypi/{pkg}/json 接口（实测 404）
      -->
      <!--
        ★ 这里原来有一个「AstrBot 的 Python 源」选择器 —— **已移除**
          （主人 2026-09-27：「为什么打开设置里有选择 astrbot 镜像源的」）

        移除理由：源的选择**全部归到「下载」页分类里**（AstrBot 下载 / NapCat 下载），
        设置页再放一份就有两个问题：
          · 同一个设置两个入口，改了一处另一处不刷新
          · 设置页本该放"软件偏好"（关闭行为、日志、更新），
            而"用哪个源下载"是**下载这件事的一部分**，放在下载页最直观

        后端能力（pysrc:state / pref / add / remove / test）一个都没删，
        下载页照常用。
      -->

      <section class="card">
        <b>关闭行为</b>
        <!-- 原来这里有一行「点右上角 ✕ 时：」——属于指路式废话，按用户要求去掉 -->
        <div class="radios" role="radiogroup" aria-label="关闭行为">
          <label class="radio" :class="{ on: closePolicy === 'tray' }">
            <input type="radio" name="closepolicy" value="tray" :checked="closePolicy === 'tray'" @change="setPolicy('tray')" />
            <span class="dot" aria-hidden="true" />
            <span class="rtext">
              <em>缩回托盘</em>
              <small>窗口关掉，实例继续跑哦</small>
            </span>
          </label>
          <label class="radio" :class="{ on: closePolicy === 'quit' }">
            <input type="radio" name="closepolicy" value="quit" :checked="closePolicy === 'quit'" @change="setPolicy('quit')" />
            <span class="dot" aria-hidden="true" />
            <span class="rtext">
              <em>直接退出</em>
              <small>退出前会把所有实例停掉呢</small>
            </span>
          </label>
        </div>
      </section>

      <section class="card wide">
        <div class="logrow">
          <b>日志</b>
          <button class="pick primary sm" :disabled="exporting" @click="exportLogs">{{ exporting ? '正在打包…' : '导出日志' }}</button>
        </div>
        <p v-if="exportedPath" class="hint strong">已经生成啦：{{ exportedPath }}</p>
        <p v-if="exportErr" class="hint strong err">{{ exportErr }}</p>
        <!--
          这里原来还有一个「操作记录」（操作审计）区块，用户要求去掉整个功能。
          审计数据本身还在写（排查问题有用），只是界面上不再提供查看入口。
        -->
      </section>

      <!--
        ★ 问题反馈的联系方式（主人 2026-09-27 起，2026-10-08 收敛为只有群）

        主人原话（10-08）：「去掉这个，去掉全部个人 QQ 号，必要的地方替换成群号」
        「更换成更群号之后，关联的文案也要优化」

        为什么放在「日志」卡片**正下方**：
          · 用户点「导出日志」之后的下一步动作就是——把日志发出去。
            这里正好回答"发到哪"
          · 不放在最顶部：那是"软件偏好"区，联系方式和偏好无关，
            放上去会显得像广告
          · 报错弹窗里也已经附了（见 App.vue 的 FEEDBACK_LINE），
            两处呼应：弹窗捕捉"当下出问题"，设置页兜住"事后想找人"

        ## 文案为什么这么写（不只是把号换掉）

        原来是「加这个 QQ 找我」—— 主语是"我"，收件人是单个人。
        换成群之后那句话就不成立了（群里不是一个"我"在答），
        所以整段重写成群的语境：

          · 不说"找我"，说"问一下" —— 群里是互相帮忙，不是找客服
          · 明说"群里可能有人遇到过" —— 这是群相对私聊**唯一的优势**，
            要讲出来用户才知道该不该来
          · 保留"带上导出的日志" —— 这条与渠道无关，永远是定位问题的关键
          · 不说"官方"二字堆在正文里（标题栏已经标了），省得读着像广告
      -->
      <section class="card">
        <div class="logrow">
          <b>问题反馈群</b>
          <span class="qqnum">{{ OFFICIAL_GROUP }}</span>
        </div>
        <p class="hint">
          用着有问题、或者哪里不对劲，加群问一下就行 —— 群里可能已经有人遇到过，答案也留得住，
          后来的人搜得到。顺手把上面导出的日志一起发过来，定位会快很多。
        </p>
      </section>
    </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(24, 39, 65, 0.25);
  backdrop-filter: blur(10px) saturate(125%);
  -webkit-backdrop-filter: blur(10px) saturate(125%);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 70;
}
.panel {
  position: relative;
  isolation: isolate;
  display: flex;
  flex-direction: column;
  width: 720px;
  max-width: calc(100vw - 56px);
  max-height: calc(100vh - 90px);
  overflow: hidden;
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.86), rgba(242, 247, 255, 0.72));
  border: 1px solid var(--glass-edge);
  backdrop-filter: blur(28px) saturate(160%);
  -webkit-backdrop-filter: blur(28px) saturate(160%);
  border-radius: 20px;
  border-color: var(--glass-edge);
  box-shadow: 0 24px 64px rgba(19, 37, 70, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.9);
  padding: 24px 32px;
}
.settings-mascot {
  position: absolute;
  z-index: 0;
  top: 34px;
  right: 8px;
  height: clamp(300px, 43vh, 380px);
  width: auto;
  max-width: min(270px, 42%);
  object-fit: contain;
  object-position: top right;
  opacity: 0.18;
  pointer-events: none;
}
.panel > header {
  position: relative;
  z-index: 1;
  flex: none;
}
.panel > .grid {
  position: relative;
  z-index: 1;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.panel > header .x {
  position: absolute;
  top: 0;
  right: 0;
  z-index: 2;
}
.panel header {
  display: flex;
  align-items: center;
  margin-bottom: 18px;
}
.panel header h2 {
  margin: 0;
  font-size: 16px;
}
.panel header .x {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--ink-soft);
  font-size: 14px;
}
.panel header .x:hover {
  color: var(--ink);
}
.setmask-enter-active,
.setmask-leave-active {
  transition: opacity 0.16s ease;
}
.setmask-enter-from,
.setmask-leave-to {
  opacity: 0;
}
.setpop-enter-active {
  transition: transform 0.2s cubic-bezier(0.2, 0.9, 0.3, 1.15), opacity 0.18s ease;
}
.setpop-enter-from {
  transform: translateY(10px) scale(0.97);
  opacity: 0;
}
.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  column-gap: 0;
  row-gap: 0;
  border-top: 1px solid var(--hairline);
}
.card {
  min-width: 0;
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--hairline);
  border-radius: 0;
  padding: 18px 0;
}
.card.wide {
  grid-column: 1 / -1;
}
.rowhint {
  margin: 8px 0 6px;
  font-size: 12px;
  color: var(--ink-soft);
}
/* 单选：圆点 + 两行说明，比两个按钮清楚得多 */
.radios {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 2px;
}
.radio {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 2px;
  border: 0;
  border-bottom: 1px solid var(--hairline);
  border-radius: 0;
  cursor: pointer;
  transition-property: border-color, background-color;
  transition-duration: 140ms;
  transition-timing-function: ease-out;
}
.radio:hover {
  background: color-mix(in srgb, var(--primary-soft) 55%, transparent);
}
.radio.on {
  color: var(--primary-deep);
  background: transparent;
}
/* 真 radio 藏起来但保留可聚焦、可用键盘操作 */
.radio input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.radio .dot {
  flex: none;
  width: 16px;
  height: 16px;
  margin-top: 2px;
  border-radius: 50%;
  border: 1.5px solid #c3cad6;
  background: #fff;
  position: relative;
  transition-property: border-color;
  transition-duration: 140ms;
}
.radio.on .dot {
  border-color: var(--primary);
}
.radio.on .dot::after {
  content: '';
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  background: var(--primary);
  transform: scale(0.4);
  opacity: 0;
  animation: dotin 0.16s ease-out forwards;
}
@keyframes dotin {
  to {
    transform: scale(1);
    opacity: 1;
  }
}
.radio input:focus-visible + .dot {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 20%, transparent);
}
.rtext {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.rtext em {
  font-style: normal;
  font-size: 13px;
  color: var(--ink);
}
.rtext small {
  font-size: 11.5px;
  color: var(--ink-soft);
  line-height: 1.5;
}
/* 开关：状态一眼看出，不用读文字 */
.switchrow {
  display: flex;
  align-items: center;
  gap: 12px;
}
.switchrow .rtext {
  flex: 1;
}
.switch {
  flex: none;
  width: 46px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--hairline);
  border-radius: 13px;
  background: #eef1f6;
  position: relative;
  cursor: pointer;
  transition-property: background-color, border-color;
  transition-duration: 160ms;
  transition-timing-function: ease-out;
}
.switch .knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(24, 30, 42, 0.22);
  transition-property: transform;
  transition-duration: 180ms;
  transition-timing-function: cubic-bezier(0.2, 0.9, 0.3, 1.1);
}
.switch.on {
  background: var(--primary);
  border-color: var(--primary);
}
.switch.on .knob {
  transform: translateX(20px);
}
.switch:focus-visible {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 20%, transparent);
}
.pick {
  border: 1px solid var(--hairline);
  background: rgba(255, 255, 255, 0.58);
  backdrop-filter: blur(8px);
  border-radius: var(--radius-ctrl);
  padding: 7px 14px;
  font-size: 12.5px;
  color: var(--ink-soft);
}
.pick.on {
  border-color: var(--primary);
  color: var(--primary-deep);
  background: var(--primary-soft);
}
/* 主操作：蓝底白字，一眼看出是能点的 */
.pick.primary {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
  padding: 8px 18px;
  font-weight: 500;
  transition-property: background-color, transform;
  transition-duration: 140ms;
  transition-timing-function: ease-out;
}
/* 日志那一行：标题在左，按钮靠右且小巧 */
.logrow {
  display: flex;
  align-items: center;
  gap: 12px;
}

/*
 * 官方群那一行：与上面的"问题反馈"分开一点，避免看成一整块。
 *
 * 用一条极浅的分隔线而不是加大间距 —— 它俩是**同类信息**（联系方式），
 * 间距太大会显得是两个模块；而完全贴着又分不清哪个是哪个。
 */
.logrow.group {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--hairline);
}

/*
 * 问题反馈的 QQ 号：用等宽字体 + 稍大一点，方便用户照着输入。
 *
 * 为什么不用主色调高亮：它不是操作按钮（点了也没反应），
 * 只是"一串要抄下来的数字"。视觉上像"可点的链接"会误导用户去点。
 * margin-left:auto 把它推到右边，与「日志」行的按钮位置对齐。
 */
.qqnum {
  margin-left: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
  letter-spacing: 0.4px;
  color: var(--primary-deep);
  user-select: all; /* 一键全选，方便复制 */
}
@media (max-width: 720px) {
  .panel {
    width: calc(100vw - 32px);
    max-width: none;
    padding: 20px;
  }
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* ---------------- 操作审计 ---------------- */
/* 和上面的「日志」行拉开距离，两者是不同的东西 */
.auditrow {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--hairline);
}
.auditctl {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.picksel {
  border: 1px solid var(--hairline);
  border-radius: 8px;
  padding: 4px 8px;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.58);
  backdrop-filter: blur(8px);
  color: var(--ink);
}
/* 审计原文一行一条，等宽字体便于对齐时间戳 */
.auditbox {
  margin: 12px 0 0;
  max-height: 300px;
  overflow: auto;
  padding: 10px 12px;
  border-radius: var(--radius-ctrl);
  background: var(--card-n);
  border: 1px solid var(--hairline);
  font-family: 'Cascadia Mono', 'Consolas', monospace;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--ink-soft);
  white-space: pre-wrap;
  word-break: break-all;
}
.pick.primary.sm {
  margin-left: auto;
  padding: 5px 12px;
  font-size: 12px;
}
.pick.primary:hover:not(:disabled) {
  background: var(--primary-deep);
}
.pick.primary:active:not(:disabled) {
  transform: scale(0.97);
}
.pick.primary:disabled {
  /*
   * ★ 禁用态不许再用 opacity 压暗（四厂商审计，与 InstanceCard 同一修法）
   *
   * 原来是 `opacity: 0.6`：白字压在 --primary（#2f6bd8）上，白卡背景下
   * 有效底色 ≈ #82A6E8，文字对比度实测**2.4:1**（AA 要 4.5）——
   * 「下载更新」正是这张设置里唯一的主按钮，禁用（正在下载中）
   * 是最常出现的状态。
   *
   * 项目在 tokens.css 立过规矩：`button:disabled` 全局那几层已经把
   * "灰"表达完了，**组件层不要再叠 opacity**（两层会相乘更糟）。
   * 这里照 InstanceCard 的合规写法：换一个够深的底 + 抵消全局 opacity。
   * 实测白字 on #5f759c = 4.66 ✔（scripts/_contrast-check.cjs 可复核）。
   */
  background: #5f759c;
  border-color: #5f759c;
  box-shadow: none;
  cursor: not-allowed;
  opacity: 1;
}
.path {
  font-size: 12px;
  color: var(--ink-soft);
  margin: 6px 0 0;
  word-break: break-all;
}
.hint {
  color: var(--ink-soft);
  font-size: 12px;
  line-height: 1.6;
  margin: 8px 0 0;
}
.hint.strong {
  color: var(--ink);
}
/*
 * 搬家进行中的横幅：用主色底 + 深字，让它在一屏灰色提示里**一眼可见**。
 * （信息本身很重要：它解释了"为什么按钮是灰的、什么时候能好"。）
 * 对比度按项目规矩实测过：--primary-soft(#e8f0fd) 底 + --primary-deep 字
 * 远高于 AA 门槛（scripts/_contrast-check.cjs 那一套口径）。
 */
.hint.moving {
  color: var(--primary-deep);
  background: var(--primary-soft);
  border-radius: var(--radius-ctrl);
  padding: 8px 10px;
}
/*
 * 下载好的安装包路径：行内等宽展示 + 一个跳转按钮。
 * 用 --ink（而不是 --ink-soft）是因为路径是**用户要抄/要点的信息**，
 * 不是辅助说明；--ink-soft 在白卡上只有 3.87 对比度，偏虚。
 */
.pathinline {
  font-family: var(--font);
  color: var(--ink);
  word-break: break-all;
}
.linkbtn {
  margin-left: 8px;
  padding: 0;
  border: none;
  background: none;
  /* 链接式按钮：颜色只能用 token，且必须够对比（--primary-deep 白底 5.92） */
  color: var(--primary-deep);
  font-size: 12px;
  font-family: var(--font);
  cursor: pointer;
  text-decoration: underline;
}
.linkbtn:hover {
  color: var(--primary);
}
/*
 * 更新说明。
 * 用 --primary-soft 打底的浅蓝块，但**文字必须用 --primary-deep** ——
 * --primary-soft 在白卡上对比只有 1.14（几乎看不见），
 * 所以背景色只能是背景，不能承载文字。
 */
.notes {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: var(--radius-ctrl);
  background: var(--primary-soft);
  color: var(--primary-deep);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
}
/* 迁移漏项的清单：必须显眼（它解释「为什么新目录里启动不了」） */
.faillist {
  margin: 8px 0 0;
  padding-left: 18px;
  color: var(--ink);
  font-size: 12px;
  line-height: 1.7;
}
.faillist b {
  color: var(--primary-deep);
}
.err {
  color: var(--danger);
}
</style>
