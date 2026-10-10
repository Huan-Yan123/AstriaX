<script setup lang="ts">
import type { Instance } from './types/instance'
import { useInstanceVersions } from './composables/useInstanceVersions'
import { useInstanceCredentials } from './composables/useInstanceCredentials'
import { useStartupPrompts } from './composables/useStartupPrompts'

import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import InstanceCard from './InstanceCard.vue'
import CreateWizard from './CreateWizard.vue'
import FirstRunWizard from './FirstRunWizard.vue'
import SettingsPanel from './SettingsPanel.vue'
import DownloadPage from './DownloadPage.vue'
import AppDialog from './AppDialog.vue'
import TitleBar from './components/TitleBar.vue'
// 搬家后要整份清掉下载页的 SWR 缓存（它存的数据都跟着数据根走）
import { dlInvalidate } from './dl-cache'
// 顶部标题栏品牌标记：复用软件图标，避免侧栏再重复显示一次。
import instanceMascot from './assets/mascot-instance-empty.png'
import installMascot from './assets/mascot-runtime-missing.png'
import { desktopError } from './platform/desktop-errors'
import { useLauncherDialogs } from './composables/useLauncherDialogs'
import { useInstanceLogs } from './composables/useInstanceLogs'
import { useDesktopWebUI } from './composables/useDesktopWebUI'

/** QQ 官网下载页（与主进程 qq-check.ts 里的常量保持一致） */
const QQ_DOWNLOAD_URL = 'https://im.qq.com/pcqq/index.shtml'

const list = ref<Instance[]>([])
const wizardOpen = ref(false)

const firstRun = ref<boolean | null>(null)
const settingsOpen = ref(false)
const busy = ref(false)
/** 启动阶段就失败了（读配置抛错等）——必须让用户看见，不能静默吞掉 */
const bootErr = ref('')
// 页签：AstrBot / NapCat 各自独立页面（用户决策）
const page = ref<'a' | 'n' | 'download'>('a')

interface SwitchPerfEntry {
  to: string
  ms: number
  at: number
}
const switchPerf: SwitchPerfEntry[] = []
;(window as unknown as { __astriaxSwitchPerf?: SwitchPerfEntry[] }).__astriaxSwitchPerf = switchPerf

function switchPage(to: 'a' | 'n' | 'download'): void {
  settingsOpen.value = false
  if (page.value === to) return
  const t0 = performance.now()
  page.value = to
  // 下一帧再量：组件的挂载/渲染都发生在这之后
  requestAnimationFrame(() => {
    const ms = Math.round(performance.now() - t0)
    switchPerf.push({ to, ms, at: Date.now() })
    if (switchPerf.length > 20) switchPerf.shift()
    if (ms > 50) {
      // 只报异常值：这条日志就是"哪次切页卡了"的直接证据
      console.warn(`[perf] 切到「${to}」用了 ${ms}ms（超过 50ms 预算）`)
    }
  })
}
const search = ref('')
const shown = computed(() => list.value.filter(x => x.type === page.value && x.name.toLowerCase().includes(search.value.trim().toLowerCase())))

const { dlg, note, ask, onDlgPick, choose, chooseOne } = useLauncherDialogs()
const { silentCheckUpdate, askExportAfterCrash } = useStartupPrompts({ choose, note })

/** 启动失败：先讲清原因，再问要不要导出日志 */
async function askStartFailed(name: string, reason: string): Promise<boolean> {
  return choose(
    `${name} 没启动起来`,
    `${reason}\n\n是否导出日志？日志比截图更容易定位问题。`,
    '导出日志',
    '取消',
    /* 实例起不来正是最需要人来帮的场景 */
    { feedback: true }
  )
}

/**
 * QQ 环境不满足时的引导弹窗。
 *
 * 主动检测已经挪到「下载」页的镜像源那里（首次进页面自动测、之后手动）,
 * 这里只在**启动 NapCat 真的被拦下来**时兜底：那时用户已经踩到问题，
 * 直接把原因说清楚并给一个能点的官网下载入口，比让他去翻日志强。
 */
function askInstallQQ(reason: string): void {
  dlg.value = {
    title: '需要先安装 QQ',
    body: reason,
    buttons: [
      { text: '稍后再说', kind: 'ghost', value: 'later' },
      { text: '去官网下载', kind: 'main', value: 'go' }
    ],
    onPick: (v) => {
      if (v === 'go') {
        void window.launcher?.app
          ?.openExternal?.(QQ_DOWNLOAD_URL)
          .catch((e: unknown) => note('打不开浏览器', e instanceof Error ? e.message : String(e)))
      }
    }
  }
}

const { webuiOpen, webuiVisible, webuiBusy, refreshWebUi, toggleWebUi, closeAllWebUi } = useDesktopWebUI({
  name: id => list.value.find(x => x.id === id)?.name ?? id,
  report: note,
})

/** 工具条上显示现在开的是哪个实例的 WebUI */
const webuiWho = computed(() => {
  if (!webuiVisible.value) return webuiOpen.value.size ? 'WebUI 正在加载…' : 'WebUI'
  const inst = list.value.find((x) => x.id === webuiVisible.value)
  return `当前显示「${inst?.name ?? webuiVisible.value}」的 WebUI`
})

declare const window: {
  launcher?: {
    instance: {
      list: () => Promise<Instance[]>
      create: (p: unknown) => Promise<Instance>
      start: (id: string) => Promise<void>
      stop: (id: string) => Promise<void>
      remove: (id: string) => Promise<void>
    }
    config?: { get: () => Promise<Record<string, unknown>>; set: (p: unknown) => Promise<void> }
    app?: {
      qqStatus?: () => Promise<{ ok?: boolean; installed?: boolean; reason?: string; minBuild?: number }>
      openExternal?: (url: string) => Promise<void>
    }
  }
}

const api = () => window.launcher!.instance
const cfgApi = () => window.launcher!.config!

async function refresh(): Promise<void> {
  list.value = await api().list()
  // 运行时状态跟着一起刷：之前在下载页装好版本回来，
  // 这里不重读就一直是「没装运行时」，卡片和创建按钮都会被误判。
  void refreshRuntimeState()
  void refreshWebUi()
}

async function bootstrapData(): Promise<{ cfg: Record<string, unknown>; insts: Instance[] }> {
  const [rawCfg, insts] = await Promise.all([

    window.launcher?.config?.get() as Promise<unknown> | undefined,
    api()
      .list()
      .catch(() => [] as Instance[])
  ])
  // 兜底在这里 —— 此时 rawCfg 已经是真实返回值（可能是 undefined）
  const cfg = (rawCfg ?? {}) as Record<string, unknown>
  return { cfg, insts }
}

onMounted(async () => {

  try {
    /*
     * config:get 和 instance:list **并行**发（见 bootstrapData 的说明）。
     * 原来串行等，首屏要等两个来回；现在只等最慢的那个。
     */
    const { cfg, insts } = await bootstrapData()
    firstRun.value = !cfg.dataRoot
    if (firstRun.value === false) list.value = insts
  } catch (e) {
    firstRun.value = false
    bootErr.value = `读取配置失败：${e instanceof Error ? e.message : String(e)}`
  }
  if (firstRun.value === false) {
    // 首屏已经拿到实例列表了，剩下的次要信息（运行时状态 / WebUI）
    // 各自并行加载，不挡住界面显示
    void refreshRuntimeState()
    void refreshWebUi()
  }
  /*
   * 启动时静默预热版本列表缓存（用户要求：「改成启动时静默检测并缓存，
   * 出现更新操作（下载/删除）再更新」）。
   *
   * 为什么放最后、且不 await：这是个纯后台的网络预热，慢的话（源不通、
   * 超时 15 秒）会把界面启动拖住。扔出去不管，用户第一次进下载页时
   * 缓存多半已经好了。主进程那边也把失败全部吞掉，不会弹任何东西。
   */
  if (firstRun.value === false) void prewarmVersions()
  /*
   * 上次异常退出 → 问一次要不要导出诊断日志。
   * 放在首启判断**之后**：首启用户正在看著作声明，别让两个弹窗抢焦点。
   * 不 await：它内部只是问一句话，不该拖住 onMounted 的其余收尾。
   */
  if (firstRun.value === false) void askExportAfterCrash()

  if (firstRun.value === false) void silentCheckUpdate()
})

/**
 * 启动时的静默更新检查。
 *
 * 有新版才弹窗（一天最多一次）；没更新、检查失败都完全不打扰。
 * 「跳过此版本」的版本也不会再弹（主进程记着 skippedAppVersion）。
 */
/**
 * 启动时静默预热版本列表（失败什么都不做）。
 *
 * 单独抽成函数而不是内联：这里要吞掉所有异常 —— 预热失败是正常的
 * （没网、源临时不通），绝不能因此弹窗或写 bootErr 把界面搞脏。
 */
async function prewarmVersions(): Promise<void> {
  try {
    const api = window.launcher as unknown as { versions?: { prewarm?: () => Promise<unknown> } }
    await api?.versions?.prewarm?.()
  } catch {
    /* 预热只是加速，失败不影响任何功能 */
  }
}

async function finishFirstRun(dataRoot: string): Promise<void> {
  await cfgApi().set({ dataRoot })
  firstRun.value = false
  await refresh()
}

async function onMoved(): Promise<void> {
  settingsOpen.value = false

  dlInvalidate()
  await refresh()
}

/**
 * 每个实例各自的忙状态：之前用一个全局 busy，点一个实例的「启动」
 * 所有卡片的按钮都跟着变灰，看着像全都在动。这里按 id 精确记。
 */
const busyIds = ref<Set<string>>(new Set())
function isBusyId(id: string): boolean {
  return busyIds.value.has(id)
}
function markBusyId(id: string, on: boolean): void {
  const next = new Set(busyIds.value)
  if (on) next.add(id)
  else next.delete(id)
  busyIds.value = next
}
/** 正在切换状态的实例（用于把按钮文字变成「启动中… / 停止中…」） */
const switching = ref<Map<string, 'starting' | 'stopping'>>(new Map())

const updatingIds = ref<Set<string>>(new Set())

async function toggle(x: Instance): Promise<void> {
  if (isBusyId(x.id)) return
  const action: 'starting' | 'stopping' = x.status === 'running' ? 'stopping' : 'starting'
  markBusyId(x.id, true)
  switching.value = new Map(switching.value).set(x.id, action)
  // 乐观更新：按钮立刻显示「启动中…」，不等后端回话（变量名是 list，不是 instances）
  list.value = list.value.map((it) => (it.id === x.id ? { ...it, status: action === 'starting' ? 'starting' : 'stopping' } : it))
  try {
    if (action === 'stopping') await api().stop(x.id)
    else await api().start(x.id)
    await refresh()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // QQ 环境问题有专门的引导（去官网装/升级 QQ），不该让用户去翻日志
    if (/QQ/.test(msg) && /(没有检测到|版本太低|读不出)/.test(msg)) {
      askInstallQQ(msg)
    } else {
      // 启动失败不能静默：先弹原因，再问要不要导出日志去求助
      const wantLog = await askStartFailed(x.name, msg)
      if (wantLog) {
        try {
          const lApi = (window as unknown as { launcher?: { logs?: { exportZip?: () => Promise<string> } } }).launcher
          const p = await lApi?.logs?.exportZip?.()
          if (p) note('日志已导出', p)
        } catch (e2) {
          note('导出失败', e2 instanceof Error ? e2.message : String(e2))
        }
      }
    }
    await refresh()
  } finally {
    markBusyId(x.id, false)
    const next = new Map(switching.value)
    next.delete(x.id)
    switching.value = next
  }
}

async function create(payload: {
  type: 'a' | 'n'
  name: string
  port?: number
  tag?: string
  qqAccount?: string
}): Promise<void> {
  busy.value = true
  try {
    await api().create(payload)
    wizardOpen.value = false
    page.value = payload.type === 'a' ? 'a' : 'n'
    await refresh()
  } catch (e) {
    // 创建失败直接弹窗说明（重名/端口占用/QQ 环境不满足等），不再无声吞掉
    const msg = e instanceof Error ? e.message : String(e)
    if (/QQ/.test(msg) && /(没有检测到|版本太低|读不出)/.test(msg)) {
      // QQ 是 NapCat 的硬前置：直接引导去官网装/升级，比让用户对着报错发愣好
      wizardOpen.value = false
      askInstallQQ(msg)
    } else {
      note('创建失败', msg)
    }
  } finally {
    busy.value = false
  }
}

const { credView, credErr, showCreds, resetCreds } = useInstanceCredentials({ ask, note, refresh })

// 看日志浮层：卡片菜单里的「看日志」
const { logView, logPre, showLog, closeLog } = useInstanceLogs(note)
// Native child WebViews draw above Vue; close them before showing a local overlay.
watch(() => !!dlg.value || settingsOpen.value || wizardOpen.value || !!logView.value || !!credView.value || page.value === 'download', blocked => {
  if (blocked) void closeAllWebUi()
})

/*
 * 备份 / 换新版本 的入口已按用户要求移除（「意义不大」）。
 *
 * 备份那条路问题尤其多：停止时秒备份、出来是 0MB、回滚还会在实例目录里
 * 留下一堆 .deleted-* 残骸（实测用户机器上就有多个）。与其留着一个
 * 用户不敢用的功能，不如先撤掉。
*
 * 主进程里的实现先留着（ipc 的 backup:*），
 * 因为删数据是不可逆的，等确认不需要了再一起清。
 */

const { pickVersion, updateInstance } = useInstanceVersions({ note, choose, chooseOne, refresh, refreshRuntimeState, busy, updatingIds, markBusyId })

// 运行时状态（卡片提示用）：某类型有没有装好的版本
const tplState = ref<{ a: boolean; n: boolean } | null>(null)
async function refreshRuntimeState(): Promise<void> {
  try {
    const t = (await (window as unknown as { launcher?: { runtimes?: { list?: () => Promise<Array<{ type: 'a' | 'n' }>> } } }).launcher?.runtimes?.list?.()) ?? []
    tplState.value = { a: t.some((v) => v.type === 'a'), n: t.some((v) => v.type === 'n') }
  } catch {
    /* 缺省 */
  }
}
onMounted(() => {
  void refreshRuntimeState()
})

// 主进程问「点 ✕ 要干嘛」：用软件自己的弹窗问，别用系统原生框
onMounted(() => {
  const l = window.launcher as unknown as {
    onAskClose?: (cb: () => void) => () => void
    answerClose?: (v: 'tray' | 'quit') => void
  }
  const off = l?.onAskClose?.(() => {
    void (async () => {
      const toTray = await choose(
        '关窗口之后',
        '想让实例继续跑，就缩到托盘；想彻底退出，就把实例都停掉。',
        '缩到托盘',
        '退出程序'
      )
      l?.answerClose?.(toTray ? 'tray' : 'quit')
    })()
  })
  if (off) onUnmounted(off)
})

// 切页也重读一次运行时列表，避免在下载页装完版本回来依旧显示旧状态
watch(page, () => {
  void refreshRuntimeState()
})

// 待删除实例（确认框：输入完整名称才可删）
function askRemove(x: Instance): void {
  dlg.value = {
    title: `删除「${x.name}」？`,
    body: '该实例的全部数据（配置、数据库、备份）会被永久删除，不可恢复。若它正在运行，会先自动停止。',
    requireText: x.name,
    inputPlaceholder: `输入「${x.name}」以确认`,
    buttons: [
      { text: '取消', kind: 'ghost', value: false },
      /*
       * `needsText: true` —— 只有这个按钮需要先把名字打对。
       *
       * 不标的话，AppDialog 会因为「value === true」把它当成需要校验的那个
       * （见 pick() 的兜底），行为其实一样；显式标出来是为了不再依赖那条推断，
       * 也让「取消为什么不需要输入」这件事在代码里看得见。
       */
      { text: '永久删除', kind: 'danger', value: true, needsText: true }
    ],
    onPick: (v) => {
      if (!v) return
      void (async () => {
        busy.value = true
        try {
          await api().remove(x.id)
          await refresh()
        } catch (e) {

          const msg = e instanceof Error ? e.message : String(e)
          note('删除失败', `「${x.name}」没有删掉哦：${msg}`)
        } finally {
          busy.value = false
        }
      })()
    }
  }
}

const winApi = () => (window as unknown as { launcher?: { windowCtl?: { minimize: () => Promise<void>; toggleMaximize: () => Promise<void>; close: () => Promise<void> } } }).launcher?.windowCtl

// 凭据告知（M2）：查看某实例的账密/token
</script>

<template>
  <div class="shell">
    <!-- 融合式标题栏：无边框窗口控制 + 液态玻璃效果 -->
    <TitleBar />
    <div v-if="desktopError" class="desktop-error" role="alert">
      {{ desktopError }} <button @click="desktopError = ''">关闭提示</button>
    </div>

    <!-- WebUI 视图盖在下面这块区域（顶部让出 78px）。这条工具条是最后一道保险：
         WebUI 页面白屏、渲染层状态错乱时,用户仍然点得到「退出」。 -->
    <div v-if="webuiOpen.size > 0" class="webbar">
      <span class="webwho">{{ webuiWho }}</span>
      <button class="webbtn" @click="closeAllWebUi">退出 WebUI</button>
    </div>
    <div class="body">
    <aside class="rail">
      <p class="rail-heading">工作区</p>
      <label class="rail-search"><span aria-hidden="true">⌕</span><input v-model="search" aria-label="搜索实例" placeholder="搜索实例" /></label>
      <div class="railnav">
        <button class="railbtn" :class="{ 'is-active': !settingsOpen && page === 'a' }" title="AstrBot" @click="switchPage('a')"><span class="navglyph">A</span><span>AstrBot</span></button>
        <button class="railbtn" :class="{ 'is-active': !settingsOpen && page === 'n' }" title="NapCat" @click="switchPage('n')"><span class="navglyph">N</span><span>NapCat</span></button>
      </div>
      <div class="railfoot">
        <!-- 备份入口按用户要求去掉（功能问题多、意义不大） -->
        <button class="railbtn" :class="{ 'is-active': !settingsOpen && page === 'download' }" title="下载" @click="switchPage('download')">
          <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
            <path d="M10 2.8v9.4m0 0 3.6-3.6M10 12.2 6.4 8.6M4 16.4h12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>资源与环境</span>
        </button>
        <button class="railbtn" :class="{ 'is-active': settingsOpen }" title="设置" @click="settingsOpen = !settingsOpen">
          <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
            <path
              d="M8.7 2.5h2.6l.4 1.9a6 6 0 0 1 1.3.75l1.85-.6 1.3 2.25-1.4 1.35a6 6 0 0 1 0 1.5l1.4 1.35-1.3 2.25-1.85-.6a6 6 0 0 1-1.3.75l-.4 1.9H8.7l-.4-1.9a6 6 0 0 1-1.3-.75l-1.85.6-1.3-2.25 1.4-1.35a6 6 0 0 1 0-1.5L3.85 6.8l1.3-2.25 1.85.6a6 6 0 0 1 1.3-.75z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linejoin="round"
            />
            <circle cx="10" cy="10" r="2.1" fill="none" stroke="currentColor" stroke-width="1.4" />
          </svg>
          <span>设置</span>
        </button>
      </div>
    </aside>

    <main class="content" :class="{ 'settings-content': settingsOpen }">
      <SettingsPanel v-if="settingsOpen && firstRun === false" embedded @close="settingsOpen = false" @moved="onMoved" />
      <template v-else>
      <template v-if="page === 'a' || page === 'n'">
      <Transition name="page" mode="out-in">
      <div :key="page" class="page">
      <header class="topbar">
        <h1>{{ page === 'a' ? 'AstrBot 实例' : 'NapCat 实例' }}</h1>
        <button class="createbtn" @click="wizardOpen = true">＋ 新建 {{ page === 'a' ? 'AstrBot' : 'NapCat' }} 实例</button>
      </header>

      <!--
        内存/磁盘显示按用户要求去掉了（「不是让去掉已经检测了吗？怎么还有内存和
        硬盘显示，而且卡死了」）。系统信息本身不卡，但用户不想要这块信息，
        而且它曾经是「每 2 秒全量采样」卡顿的源头，撤掉最省心。
      -->

      <div v-if="shown.length === 0" class="empty">
        <img
          v-if="tplState"
          class="empty-mascot"
          :class="{ 'install-mascot': !tplState[page] }"
          :src="tplState[page] ? instanceMascot : installMascot"
          alt=""
          aria-hidden="true"
        />
        <div class="empty-copy">
          <template v-if="search.trim()"><p class="emptyline">未找到匹配实例</p><button class="emptygo" @click="search = ''">清除搜索</button></template>
          <template v-else-if="tplState && !tplState[page]">
            <p class="emptyline">
              还没有 {{ page === 'a' ? 'AstrBot' : 'NapCat' }} 的运行时文件，需先安装版本才能创建实例。
            </p>
            <button class="emptygo" type="button" @click="switchPage('download')">
              前往安装运行文件
            </button>
          </template>
          <template v-else>
            <p class="emptytitle">这里还空着</p>
            <p class="emptyline">创建一个 {{ page === 'a' ? 'AstrBot' : 'NapCat' }} 实例，就可以从这里管理它。</p>
            <button class="emptygo" type="button" @click="wizardOpen = true">
              ＋ 新建 {{ page === 'a' ? 'AstrBot' : 'NapCat' }} 实例
            </button>
          </template>
        </div>
      </div>

      <TransitionGroup name="cardpop" tag="section" class="cards">
        <InstanceCard
          v-for="x in shown"
          :key="x.id"
          :inst="x"
          :busy="isBusyId(x.id)"
          :updating="updatingIds.has(x.id)"
          :switching="switching.get(x.id) ?? null"
          :webui-open="webuiOpen.has(x.id)"
          :webui-busy="webuiBusy.has(x.id)"
          :tpl-ready="tplState ? tplState[x.type] : undefined"
          @toggle="toggle(x)"
          @webui="toggleWebUi(x.id)"
          @del="askRemove(x)"
          @creds="showCreds(x)"
          @log="showLog(x)"
          @reset="resetCreds(x)"
          @version="pickVersion(x)"
          @update="updateInstance(x)"
        />
      </TransitionGroup>
      </div>
      </Transition>
      </template>

      <Transition name="page" mode="out-in">
      <DownloadPage v-if="page === 'download'" />
      </Transition>
      </template>
    </main>

    <Teleport to="body">
    <div v-if="logView" class="logfull">
      <div class="loghead">
        <b>「{{ logView.name }}」日志</b>

        <button class="logx" @click="closeLog">✕ 关闭日志</button>
      </div>
      <!--
        打开就滚到底部（用户报告：「查看实例日志怎么不直接从底部开始显示」）。
        看日志基本都是为了看**最新**几行（启动失败的原因就在末尾），
        默认停在顶部等于每次都要手动拉到底，很别扭。
      -->
      <pre ref="logPre" class="logpre">{{ logView.text }}</pre>
    </div>
    </Teleport>

    <!-- 只在**确认是首启**时显示（null = 配置还没读回来，不显示，避免闪遮罩） -->
    <FirstRunWizard v-if="firstRun === true" @confirm="finishFirstRun" />

    <!--
      启动阶段失败时的横幅：读配置抛错会造成「界面看起来正常但数据不对」，
      不显示的话用户完全无从知道自己处在异常状态。
    -->
    <div v-if="bootErr && firstRun === false" class="booterr">
      <!-- title 放完整内容：样式上截断省略，但鼠标一悬停还能看到全部 -->
      <span :title="bootErr">{{ bootErr }}</span>
      <button type="button" @click="bootErr = ''">知道了</button>
    </div>



    <CreateWizard
      v-if="wizardOpen && firstRun === false"
      :default-type="page === 'n' ? 'n' : 'a'"
      :busy="busy"
      @close="wizardOpen = false"
      @create="create"
      @goto="(p) => switchPage(p)"
    />

    <!-- 看账密/Token：统一用 AppDialog 外壳，别自己搭一套（原生按钮很丑） -->
    <AppDialog
      :open="credView !== null"
      :title="credView ? `「${credView.name}」凭据` : ''"
      :error="credErr || undefined"
      :buttons="[{ text: '知道了', kind: 'main', value: true }]"
      @pick="credView = null"
      @close="credView = null"
    >
      <dl v-if="!credErr" class="creds">
        <div v-for="c in credView?.list ?? []" :key="c.label" class="credrow">
          <dt>{{ c.label }}</dt>
          <dd><code>{{ c.value }}</code></dd>
        </div>
      </dl>
      <p class="hint2">凭据来自实例自身配置，请保管好，勿外发。</p>
    </AppDialog>

    <AppDialog
      :open="dlg !== null"
      :title="dlg?.title ?? ''"
      :body="dlg?.body"
      :buttons="dlg?.buttons"
      :require-text="dlg?.requireText"
      :input-placeholder="dlg?.inputPlaceholder"
      :error="dlg?.error"
      :choice-list="dlg?.choiceList"
      @pick="onDlgPick"
      @close="dlg = null"
    />
    </div>
  </div>
</template>

<style scoped src="./styles/App.css"></style>

