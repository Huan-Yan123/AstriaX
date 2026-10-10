<script setup lang="ts">
import settingsMascot from './assets/mascot-settings.png'
import { ref, onMounted, onBeforeUnmount } from 'vue'

const emit = defineEmits<{ close: []; moved: [] }>()

/*
 * 本组件用到的窗口桥。
 *
 * 项目里没有全局 `Window` 声明，每个组件各自 declare 自己用到的那几个方法
 * （App.vue 也是这么做的）。所以这里声明的是**本文件实际会调的那些**，
 * 桌面 API 由 Tauri transport 提供。
 */
declare const window: {
  launcher?: {
    config?: {
      moving?: () => Promise<{ active: boolean; startedAt?: number; last?: { at: number; failed?: Array<{ item: string; reason: string }> } }>
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
    logs?: { exportZip?: () => Promise<string>; exportBusy?: () => Promise<boolean> }
  }
}

const dataRoot = ref('')
const exporting = ref(false)
const exportedPath = ref('')
const exportErr = ref('')
const closePolicy = ref<'tray' | 'quit' | undefined>(undefined)


const OFFICIAL_GROUP = '1077554004'


const moving = ref(false)
const moveErr = ref('')
const moveNote = ref('')
const moveFailed = ref<Array<{ item: string; reason: string }>>([])
/** 主进程里"正在搬家"的开始时刻（0 = 没在搬）；用于重进设置页时恢复显示 */
const moveStartedAt = ref(0)
/** 已搬秒数（每 500ms 由轮询更新，让用户看到"真的在动"而不是卡住） */
const moveElapsedSec = ref(0)


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
      available?: boolean
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
    } else if (r?.available === false) {
      updErr.value = true
      updMsg.value = '暂时无法读取 Tauri 更新清单，请稍后重试'
    } else {
      updMsg.value = '已是最新版本啦'
    }
  } catch {

    updInfo.value = { hasUpdate: false }
    updErr.value = true
    updMsg.value = '检查更新失败，请稍后重试'
  } finally {
    checking.value = false
  }
}

async function doUpdate(): Promise<void> {
  const info = updInfo.value

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



async function exportLogs(): Promise<void> {
  exporting.value = true
  exportErr.value = ''
  try {
    exportedPath.value = (await window.launcher?.logs?.exportZip?.()) ?? ''
  } catch (e) {
    exportErr.value = String(e instanceof Error ? e.message : e)
  } finally {
    exporting.value = false
  }
}


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

<style scoped src="./styles/SettingsPanel.css"></style>
