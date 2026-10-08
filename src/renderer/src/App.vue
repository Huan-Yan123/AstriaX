<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import InstanceCard from './InstanceCard.vue'
import CreateWizard from './CreateWizard.vue'
import FirstRunWizard from './FirstRunWizard.vue'
import SettingsPanel from './SettingsPanel.vue'
import DownloadPage from './DownloadPage.vue'
import AppDialog, { type DialogButton } from './AppDialog.vue'
import TitleBar from './components/TitleBar.vue'
// 搬家后要整份清掉下载页的 SWR 缓存（它存的数据都跟着数据根走）
import { dlInvalidate } from './dl-cache'
// 顶部标题栏品牌标记：复用软件图标，避免侧栏再重复显示一次。
import astriaxLogo from './assets/astriax-logo.png'
import cornerMascot from './assets/mascot-corner.png'
import instanceMascot from './assets/mascot-instance-empty.png'
import installMascot from './assets/mascot-runtime-missing.png'

/** QQ 官网下载页（与主进程 qq-check.ts 里的常量保持一致） */
const QQ_DOWNLOAD_URL = 'https://im.qq.com/pcqq/index.shtml'

interface Instance {
  id: string
  name: string
  type: 'a' | 'n'
  status: string
  port: number
  runtimeVersion?: string
  /**
   * 绑定的运行时 tag（如 "v4.28.0"）。
   *
   * 由主进程在 instance:list 里补上（读 <实例目录>\instance.json 得来）——
   * 记录本身没这个字段，但「切到哪个版本」「删版本时谁在用」都要它。
   */
  runtimeTag?: string
}

const list = ref<Instance[]>([])
const wizardOpen = ref(false)
/*
 * 首启状态：**null = 还不知道**（配置还没读回来）。
 *
 * ## 为什么必须是三态，不能是 `ref(true)`
 *
 * UI 审计抓到的真问题：原来写 `const firstRun = ref(true)`，
 * 而它要等 `onMounted` 里的 `config:get` 回来才会被改成 false。
 * 于是**每一次启动**（包括早就配好的老用户）都会先渲染一帧
 * `<FirstRunWizard v-if="firstRun">` —— 那是一层全屏 45% 黑遮罩，
 * 用户能看见它闪一下再消失。启动慢时（磁盘/杀软拖累）这一闪更明显。
 *
 * 改成三态后语义清楚了：
 *   null  → 还不知道，**什么都不显示**（既不显示向导，也不显示主界面内容）
 *   true  → 确认是首启，显示著作声明
 *   false → 确认不是首启，进主界面
 *
 * ## 为什么不干脆用 `ref(false)`（默认不进向导）
 *
 * 那样真首启用户会看到主界面先闪一下再弹向导，是同一个问题的镜像。
 * 而且首启时主界面是**空的**（没有 dataRoot、没有实例），
 * 露出来反而让人以为程序坏了。所以用 null 什么都不露，最稳。
 */
const firstRun = ref<boolean | null>(null)
const settingsOpen = ref(false)
const busy = ref(false)
/** 启动阶段就失败了（读配置抛错等）——必须让用户看见，不能静默吞掉 */
const bootErr = ref('')
// 页签：AstrBot / NapCat 各自独立页面（用户决策）
const page = ref<'a' | 'n' | 'download'>('a')

/*
 * ★ 切页耗时埋点（指导书 P0 自检 4）
 *
 * 指导书要求"页面切换耗时 < 50ms，并在开发模式留下记录"。
 * 这里用最轻的方式做：切换时记一个起点，下一个微任务/下一帧量一次，
 * **只有超过 50ms 才输出**（正常情况一声不响，不刷日志）。
 *
 * 为什么不写成"每次都打日志"：正常路径每秒可能切好几次（用户连点），
 * 每次都打就把日志淹了，真出问题时反而看不见那一条。
 *
 * 另外把最近 20 次记录挂在 window.__astriaxSwitchPerf 上，
 * 需要时可以在 DevTools 里直接看分布，不用改代码。
 */
interface SwitchPerfEntry {
  to: string
  ms: number
  at: number
}
const switchPerf: SwitchPerfEntry[] = []
;(window as unknown as { __astriaxSwitchPerf?: SwitchPerfEntry[] }).__astriaxSwitchPerf = switchPerf

function switchPage(to: 'a' | 'n' | 'download'): void {
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
const shown = computed(() => list.value.filter((x) => x.type === page.value))

// 统一样式弹窗（替换原生 alert/confirm，风格一致）
interface DlgState {
  title: string
  body?: string
  buttons: DialogButton[]
  requireText?: string
  inputPlaceholder?: string
  error?: string
  /** 多选项按**列表**渲染（换版本那种）；见 AppDialog 的说明 */
  choiceList?: boolean
  onPick?: (v: unknown) => void
}
const dlg = ref<DlgState | null>(null)

/*
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 问题反馈的联系方式（主人 2026-09-27 起，2026-10-08 收敛为只有群）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 主人原话（10-08）：「去掉这个，去掉全部个人 QQ 号，必要的地方替换成群号」
 *
 * ## 为什么只在**求助类**弹窗里附
 *
 * 不是每个提示都该挂联系方式。"已是最新版本""版本已切换"这种成功提示
 * 挂了就是噪音，用户会开始无视整段文字。
 *
 * 判断依据：**用户遇到这个提示时，是不是可能需要人来帮忙**。
 *   · 启动失败 / 崩溃后询问导出日志 / WebUI 打不开 / 导出日志失败
 *     → 需要，附上
 *   · 操作成功、普通的"知道了"
 *     → 不需要
 *
 * 所以给 `note`/`choose` 加一个 `feedback` 选项，由调用点**显式**决定 ——
 * 比"自动判断标题里有没有'失败'"可靠（那种字符串启发式迟早误判）。
 *
 * ## 文案
 *
 * 原来是「加我 QQ」——主语是单个人。换成群之后那句不成立，
 * 所以改成"去群里问"：群里是互相帮忙，不讲"找我"。
 * 同时点明群的好处（可能有人遇到过），用户才知道值不值得去。
 */
const OFFICIAL_GROUP = '1077554004'
/** 拼成可直接贴进弹窗的一段话（空行分隔，视觉上独立成块） */
const FEEDBACK_LINE = `\n\n—— 搞不定的话去群里问：${OFFICIAL_GROUP}（问题反馈群）`

function note(title: string, body?: string, opts?: { feedback?: boolean }): void {
  dlg.value = {
    title,
    body: opts?.feedback ? `${body ?? ''}${FEEDBACK_LINE}` : body,
    buttons: [{ text: '知道了', kind: 'main', value: true }]
  }
}

function ask(title: string, body: string, onYes: () => void, danger = false): void {
  dlg.value = {
    title,
    body,
    buttons: [
      { text: '取消', kind: 'ghost', value: false },
      { text: '确定', kind: danger ? 'danger' : 'main', value: true }
    ],
    onPick: (v) => {
      if (v) onYes()
    }
  }
}

function onDlgPick(v: unknown): void {
  if (v && typeof v === 'object' && '__invalid' in v) {
    dlg.value = dlg.value ? { ...dlg.value, error: '名字不一致——请输入实例完整名称' } : null
    return
  }
  const cb = dlg.value?.onPick
  dlg.value = null
  cb?.(v)
}

/** 二选一弹窗，等用户在弹窗里点完再继续（用于「要不要导出日志」这类追问） */
function choose(
  title: string,
  body: string,
  yes: string,
  no: string,
  opts?: { feedback?: boolean }
): Promise<boolean> {
  return new Promise((resolve) => {
    dlg.value = {
      title,
      body: opts?.feedback ? `${body}${FEEDBACK_LINE}` : body,
      buttons: [
        { text: no, kind: 'ghost', value: false },
        { text: yes, kind: 'main', value: true }
      ],
      onPick: (v) => resolve(v === true)
    }
  })
}

/**
 * 多选一弹窗：把候选项渲染成一个**选项列表**，返回用户选的那个（取消返回 null）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 界面评审后的改法（主人 2026-09-27：「这个换版本的界面美观吗」）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 评审前的问题（截图里一眼可见）：
 *   · 十几个版本按钮**清一色实心蓝**，糊成一片，看不出哪个是当前版本
 *   · 「取消」跟它们混在同一排 —— 它不是选项，却长得像选项
 *   · 最后一行落单右对齐（flex-wrap 的默认行为），看着像 bug
 *   · 每项都挂一个**完全一样**的「28.1 MB」，纯噪音
 *
 * ## 选项从"字符串数组"改成"结构化对象"
 *
 * 顺带修掉一个隐患：原来调用方传字符串标签，选完之后要用
 * `labels.indexOf(picked)` **反查**回 tag —— 一旦两个标签文本相同
 * （比如某天大小不显示了、两个版本拼出一样的字），indexOf 会返回
 * 第一个的下标，**切错版本**。现在选项直接携带 `value`，
 * 选中的就是它自己，不存在反查。
 */
function chooseOne(
  title: string,
  body: string,
  options: Array<{ text: string; value: string; current?: boolean }>
): Promise<string | null> {
  return new Promise((resolve) => {
    dlg.value = {
      title,
      body,
      choiceList: true,
      buttons: [
        { text: '取消', kind: 'ghost', value: null },
        ...options.map((o) => ({
          text: o.text,
          kind: 'main' as const,
          value: o.value,
          current: o.current
        }))
      ],
      onPick: (v) => resolve(typeof v === 'string' ? v : null)
    }
  })
}

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

/*
 * 系统资源显示（内存/磁盘余量）已按用户要求移除，整条链（sys / pullStats /
 * hot / .sysline 样式 / 模板里的 <p>）一并删掉，见下面 webuiWho 处的说明。
 *
 * 保留下来的历史原因记录（防止有人不小心把它加回来）：
 *   - 原来还有个每 2 秒的定时器调 stats:overview 刷每个实例的 CPU/内存，
 *     采集用的 pidusage 在 Windows 上要 spawn wmic.exe，而 wmic 在新版 Windows
 *     里**已被移除**，每次调用要等超时（实测 2.4~5.1 秒），比 2 秒的轮询间隔
 *     还长 —— 主进程几乎永远在等它，界面所有交互因此卡死。
 *   - AstrBot 和 NapCat 自己的 WebUI 都带资源监控，不必在卡片上再抄一份。
 */

// M2 WebUI 开合：开着的实例 id 集合
const webuiOpen = ref<Set<string>>(new Set())

/** 当前**正在显示**的那个实例 id（主进程保证同一时刻只有一个可见） */
const webuiVisible = ref<string | undefined>(undefined)
const webuiBusy = ref<Set<string>>(new Set())

function webuiApi(): {
  open: (id: string) => Promise<void>
  close: (id: string) => Promise<void>
  list: () => Promise<string[]>
  visible?: () => Promise<string | undefined>
} | undefined {
  return (window as unknown as {
    launcher?: {
      webui?: {
        open: (id: string) => Promise<void>
        close: (id: string) => Promise<void>
        list: () => Promise<string[]>
        visible?: () => Promise<string | undefined>
      }
    }
  }).launcher?.webui
}

async function refreshWebUi(): Promise<void> {
  try {
    const ids = (await webuiApi()?.list()) ?? []
    webuiOpen.value = new Set(ids)
    webuiVisible.value = await webuiApi()?.visible?.()
  } catch {
    /* 无 webui 通道则维持现状 */
  }
}

async function toggleWebUi(id: string): Promise<void> {
  const api = webuiApi()
  if (!api || webuiBusy.value.has(id)) return
  webuiBusy.value = new Set(webuiBusy.value).add(id)
  try {
    if (webuiOpen.value.has(id)) {
      await api.close(id)
      webuiOpen.value.delete(id)
      webuiOpen.value = new Set(webuiOpen.value)
    } else {
      await api.open(id)
      webuiOpen.value.add(id)
      webuiOpen.value = new Set(webuiOpen.value)
    }
    /*
     * ★ 每次开合后都问一次"现在显示的是谁"
     *
     * 主进程现在的语义是「同时只显示一个」（修"点 AstrBot 却看到 NapCat"
     * 那个视图堆叠 bug）。渲染层如果不跟着更新，顶部工具条就会写着
     * "AstrBot 的 WebUI"、屏幕上却是另一个 —— 又是"说的是 A、看到的是 B"。
     */
    await refreshWebUi()
  } catch (e) {
    // 别吞错误：之前这里只 console.warn，用户点了没反应还以为软件坏了
    const name = list.value.find((x) => x.id === id)?.name ?? id
    note(`「${name}」的 WebUI 打不开`, e instanceof Error ? e.message : String(e))
  } finally {
    const next = new Set(webuiBusy.value)
    next.delete(id)
    webuiBusy.value = next
  }
}

async function closeAllWebUi(): Promise<void> {
  const api = webuiApi()
  if (!api) return
  await Promise.all([...webuiOpen.value].map((id) => api.close(id).catch(() => undefined)))
  await refreshWebUi()
}

/** 工具条上显示现在开的是哪个实例的 WebUI */
const webuiWho = computed(() => {
  if (!webuiVisible.value) return webuiOpen.value.size ? 'WebUI 正在加载…' : 'WebUI'
  const inst = list.value.find((x) => x.id === webuiVisible.value)
  return `当前显示「${inst?.name ?? webuiVisible.value}」的 WebUI`
})

/*
 * 这里原有 sys / pullStats / hot：系统内存与磁盘余量的展示。
 *
 * 用户要求去掉那两行之后（「系统多余的信息没必要显示在首页」），
 * 这一整条链就没有任何消费者了 —— ref 写了没人读、computed 算了没人用、
 * 还每次启动都发一次 stats:overview。现在一起删掉，不留"看起来有用"的死代码。
 *
 * 注意 stats:overview 这个 IPC 通道本身还在（主进程保留），
 * 将来要做系统信息面板可以直接接回来。
 */

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

/*
 * 首屏数据并行拉取。
 *
 * 用户报告「启动速度贼慢，卡半天白屏」。
 *
 * 原来是串行 await：先 config:get，拿到之后再 await refresh()（里面还有
 * instances:list），前一个不回来后一个就不发。这几个请求**彼此不依赖** ——
 * 完全可以同时发出去，首屏时间从「三者之和」变成「最慢的那个」。
 *
 * ## 踩过的坑：`??` 放在 Promise 上等于没写兜底
 *
 * 第一版写成：
 *     window.launcher?.config?.get() ?? Promise.resolve({})
 * 这**完全没有兜底效果** —— `??` 作用在 Promise 对象上，而 Promise 永远
 * 是非 null/undefined 的，所以右边永远不执行。结果是全新安装（config 从没
 * 写过、主进程 config:get 返回 undefined）时 cfg 就是 undefined，
 * 紧接着 `cfg.dataRoot` 抛 `Cannot read properties of undefined`，
 * 界面上就是用户看到的那句「读取配置失败」。
 *
 * 关键区别：兜底必须作用在 **await 之后的值**上，不是 Promise 上。
 * 所以下面先 await，再对结果做 `?? {}`。
 */
async function bootstrapData(): Promise<{ cfg: Record<string, unknown>; insts: Instance[] }> {
  const [rawCfg, insts] = await Promise.all([
    /*
     * 这里**故意不写任何 `??`**。
     *
     * 不管写成 `?? Promise.resolve({})` 还是 `?? Promise.resolve(undefined)`，
     * 都是死代码 —— `??` 左边是 Promise，永远非空，右边永远不执行。
     * 与其留一句「看着在兜底、其实没用」的代码误导下一个人，不如干脆不写，
     * 把兜底统一放在下面解包之后（那才是唯一有效的位置）。
     *
     * 通道不存在时 config?.get 是 undefined，直接 await undefined 得到 undefined，
     * 一样会被下面的 `?? {}` 接住。
     */
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
  /*
   * 这里必须包 try/catch。
   *
   * `(await window.launcher?.config?.get()) ?? {}` 的 `?.` 只防「方法不存在」，
   * **不防 promise reject** —— config:get 是真实 IPC，它一抛，onMounted
   * 就在这一行中断，firstRun 保持初始值 true，于是 App.vue 的
   * `v-if="firstRun"` 把首启向导永久盖在界面上，侧栏/设置/下载页全点不到。
   * 而且没有任何 catch，用户连一句错误都看不到。
   *
   * 出错时的选择：**当作不是首启**继续进主界面。理由是这样用户至少能用
   * 界面（下载页、设置里都有重试入口），比锁死在一屏遮罩上强得多；
   * 真要是首次运行没配过 dataRoot，后面的操作会各自报出更具体的错误。
   */
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
  /*
   * 启动时自动检查一次启动器更新（用户要求：「软件只有在每次启动的时候会检测一次更新，
   * 一天会推送一次」）。
   *
   * 「一天一次」的节流在主进程做（config.lastUpdateCheckAt），
   * 所以这里无条件调一次就行 —— 没到一天主进程会直接返回「没有更新」，
   * 连服务器都不问。这样写的好处是节流规则只有一份，界面不用自己算时间。
   *
   * 同样不 await：检查更新要走网络，绝不能拖住启动。检查失败时主进程
   * 按「已是最新」处理（用户要求），所以这里不会有任何打扰。
   */
  if (firstRun.value === false) void silentCheckUpdate()
})

/**
 * 启动时的静默更新检查。
 *
 * 有新版才弹窗（一天最多一次）；没更新、检查失败都完全不打扰。
 * 「跳过此版本」的版本也不会再弹（主进程记着 skippedAppVersion）。
 */
async function silentCheckUpdate(): Promise<void> {
  try {
    const api = window.launcher as unknown as {
      app?: {
        version?: () => Promise<string>
        checkUpdate?: (p?: { force?: boolean }) => Promise<{
          hasUpdate: boolean
          currentVersion?: string
          latestVersion?: string
          url?: string
          sizeMB?: number
        }>
        downloadUpdate?: (p: { url: string; version: string }) => Promise<string>
      }
    }
    const r = await api?.app?.checkUpdate?.()
    if (!r?.hasUpdate) return

    const ver = r.latestVersion ?? ''
    const size = r.sizeMB ? `（${r.sizeMB} MB）` : ''
    const cur = r.currentVersion ?? ''
    // 有新版：问要不要现在下载。下载的只是安装包，装不装由用户自己决定
    const go = await choose(
      `发现新版本 ${ver}`,
      `当前 ${cur || '旧版本'}，新版本 ${ver}${size}。\n\n` +
        '下载后会保存到系统「下载」文件夹，双击那个安装包即可完成更新。',
      '下载',
      '以后再说'
    )
    if (!go || !r.url) return

    try {
      const saved = await api?.app?.downloadUpdate?.({ url: r.url, version: ver })
      note('已下载更新包', saved ? `保存在：${saved}\n双击它即可完成更新。` : '下载完成。')
    } catch (e) {
      note('下载更新失败', e instanceof Error ? e.message : String(e))
    }
  } catch {
    /* 静默检查：任何失败都不打扰用户（用户要求失败时当作最新版） */
  }
}

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

/**
 * ★ 上次异常退出 → 提示导出诊断日志（指导书 3.2 的收尾一环）
 *
 * 判据在主进程（running.lock 还在 = 上次没走完正常退出流程）——
 * 为什么不用日志判断：进程被杀/断电时**来不及写任何日志**，
 * 日志末尾永远"看起来正常"，只有锁文件能作证。
 *
 * 三个要点：
 *   · 只在**真崩过**时提示（正常退出绝不打扰）
 *   · 给一键导出（导出包含崩溃转储 + 系统信息，见 logger/crash-logs）
 *   · 选"先不用"也照样能用软件 —— 诊断是帮忙，不是拦路
 */
async function askExportAfterCrash(): Promise<void> {
  try {
    const l = window as unknown as {
      launcher?: {
        app?: { lastCrash?: () => Promise<{ crashed: boolean; startedAt?: number }> }
        logs?: { exportZip?: () => Promise<string> }
      }
    }
    const info = await l.launcher?.app?.lastCrash?.()
    if (!info?.crashed) return
    const when = info.startedAt ? new Date(info.startedAt).toLocaleString() : '（时间读不出）'
    const want = await choose(
      '上次好像没有正常退出呢',
      `软件上次是**异常结束**的（启动于 ${when}），没来得及走完退出流程。\n\n` +
        '崩溃现场我已经留下来了：系统日志 + 崩溃转储 + 系统信息。\n' +
        '要现在导出一份诊断日志吗？以后出问题把它发我，我就能查。',
      '导出诊断日志',
      '先不用啦',
      /* 崩溃后导出日志 = 用户正要找人帮忙，联系方式放这里最有用 */
      { feedback: true }
    )
    if (!want) return
    const p = await l.launcher?.logs?.exportZip?.()
    if (p) note('日志已导出', `诊断日志打包好啦：\n${p}`)
  } catch {
    /* 提示本身失败绝不该影响启动 */
  }
}

async function onMoved(_root: string): Promise<void> {
  settingsOpen.value = false
  /*
   * ★ 数据根变了 → 下载页的 SWR 缓存必须**整份清掉**（四厂商审计一致指认）
   *
   * 那份缓存里存的"已装运行时 / Python 状态 / 镜像源状态"全都是
   * **跟着数据根走**的。不清的话：搬家后进下载页会同步画出旧根的快照，
   * 而且 5 分钟 TTL 内连"展示的是上次的数据哦"都不显示 ——
   * 用户看着旧根的清单、点「删除」时主进程删的却是新根
   *（它按当前 dataRoot 找 store），"看到的"和"动手的"不是一个东西。
   *
   * 这里用**默认的整份清空**（不保留探测结果）：搬家后连"哪些源可用"
   * 都该重新判断，保留它没有意义。
   */
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

/**
 * 正在**一键更新**的实例 id 集合。
 *
 * ## 为什么需要单独一个状态（而不是复用 busyIds）
 *
 * `busyIds` 只表达"这个实例现在别点"（禁用按钮），
 * 而一键更新要额外告诉用户**在干什么** —— 按钮文字从「启动」
 * 变成「更新中…」。
 *
 * 两者职责不同：
 *   · busyIds    → 禁用（启动/停止/换版本/更新）
 *   · updatingIds → 文案（「更新中…」，让用户知道不是卡死）
 *
 * 主人 2026-09-27 的原话点明了这个必要性：
 *   「没有提示用户就不知道其实在更新了，用户看你又去操作这个实例
 *     导致更多的 bug」
 * —— 只禁用不够，**必须能看出在更新**。
 */
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

// 看日志浮层：卡片菜单里的「看日志」
const logView = ref<{ id: string; name: string; text: string } | null>(null)
/** 日志正文节点：打开时把它滚到底部（用户要求从底部开始显示） */
const logPre = ref<HTMLElement | null>(null)

/*
 * 日志内容一渲染就滚到底部。
 *
 * 为什么要 watch 而不是在 showLog 里滚：这时 <pre> 还没挂到 DOM 上
 * （v-if 是拿到文本之后才为真的），scrollHeight 还是 0，滚了也没用。
 * watch + nextTick 保证在 DOM 更新之后执行。
 */
watch(logView, async (v) => {
  if (!v) return
  await nextTick()
  const el = logPre.value
  if (el) el.scrollTop = el.scrollHeight
})

async function showLog(x: Instance): Promise<void> {
  const lApi = (window as unknown as { launcher?: { instance?: { log?: (id: string) => Promise<string> } } }).launcher?.instance?.log
  if (!lApi) {
    note('暂时看不了日志', '日志通道没接上，启动一次实例后再试。')
    return
  }
  /*
   * ══════════════════════════════════════════════════════════════════════════
   * ★★ 日志要**边看边刷新**（主人 2026-09-27：
   *    「点击查看实例日志的时候，日志不会变化，
   *      需要退出来才进去才能刷新新的日志」）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 改之前
   *
   *     logView.value = { name, text: await lApi(x.id) }   ← 拉一次就存住
   *
   * 那是个**一次性快照**：浮层开着的时候实例还在往日志里写，
   * 而界面永远显示打开那一刻的内容。用户想看新日志只能关掉再开 ——
   * 而"看着日志排错"正是这个功能的主要用法，那样等于没用。
   *
   * ## 现在：定时轮询
   *
   *   · 记下这个浮层在看哪个实例（`logView.id`），每 2 秒重新拉一次
   *   · 只在内容**真的变了**时才替换（避免无谓的 DOM 更新与滚动跳动）
   *   · 关闭浮层时**停掉定时器**（不留后台轮询）
   *
   * ## 为什么是 2 秒
   *
   * 日志是给人看的，2 秒的延迟完全无感；而太频繁（比如 200ms）
   * 会：① 频繁 IPC；② 每次重渲染都触发滚动，用户往上翻历史时会被拽回底部。
   * 2 秒是"够新鲜"与"不打扰"之间的平衡点。
   */
  logView.value = { id: x.id, name: x.name, text: (await lApi(x.id)) || '（暂无输出——先启动一次）' }
  startLogPolling(x.id, lApi)
}

/**
 * 日志浮层的自动刷新定时器。
 *
 * 模块级（不是函数局部）：需要在关闭浮层时能停掉它。
 * 每次 showLog 先清旧的 —— 用户在两个实例之间连着点「看日志」时，
 * 不清的话会有两个定时器同时往同一个浮层写，日志会来回跳。
 */
let logTimer: ReturnType<typeof setInterval> | undefined

function stopLogPolling(): void {
  if (logTimer !== undefined) {
    clearInterval(logTimer)
    logTimer = undefined
  }
}

/**
 * 关掉日志浮层（**唯一**的关闭入口）。
 *
 * 为什么收成一个函数，而不是各处写 `logView.value = null`：
 * 关闭必须**连带停掉轮询**，分散写迟早有一处漏掉 —— 那就成了
 * "界面关了、后台还在拉日志"。收口一处，加新的关闭方式（比如 Esc）
 * 时也不会漏。
 */
function closeLog(): void {
  stopLogPolling()
  logView.value = null
}

function startLogPolling(id: string, lApi: (id: string) => Promise<string>): void {
  stopLogPolling()
  logTimer = setInterval(() => {
    void (async () => {
      /*
       * 浮层可能已经被关掉、或切换到了别的实例 —— 两种情况都该停止本轮写入：
       *   · 关掉后日志还在后台刷新 = 白白轮询
       *   · 切到别的实例后回写 = 把 A 的日志写进 B 的浮层
       */
      if (!logView.value || logView.value.id !== id) return
      try {
        const text = (await lApi(id)) || '（暂无输出——先启动一次）'
        /* 内容没变就不动 DOM：否则每 2 秒都会重新渲染 + 滚到底部 */
        if (logView.value && logView.value.id === id && logView.value.text !== text) {
          logView.value = { ...logView.value, text }
        }
      } catch {
        /* 读日志失败不打扰用户（实例可能刚好在重启），下一轮再试 */
      }
    })()
  }, 2000)
}

/**
 * 重置 AstrBot 账密。
 *
 * 只有 AstrBot 需要这个：它的账号密码是自己管的，忘了就得重置。
 * NapCat 的 WebUI token **启动器不再代管**（主人 2026-09-27：
 * 「首次启动不需要强制设置 token」）—— 现在是 NapCat 自己的默认值或用户自己设。
 * 但菜单里**仍然保留**「重置 Token」：用户忘了自己设的那个时，需要一个入口
 * 把它重置回一个**已知值**（114514），否则他只能去翻/删 webui.json。
 * 两者的区别在于：**重置是用户主动点的动作，不是我们偷偷改**。
 *
 * 实例在跑时必须先停下来——否则进程会把旧配置写回去，表现就是「重置了还是登不上」。
 * 所以先在弹窗里说清楚会停实例，确认后重置，完事再把新凭据亮出来。
 */
function resetCreds(x: Instance): void {
  const running = x.status === 'running' || x.status === 'starting'
  const go = (): void => {
    void (async () => {
      const rApi = (
        window as unknown as {
          launcher?: {
            instance?: { resetCreds?: (id: string) => Promise<{ list: Array<{ label: string; value: string }>; stoppedFirst?: boolean }> }
          }
        }
      ).launcher?.instance?.resetCreds
      if (!rApi) {
        note('暂时重置不了', '重置功能没接上。')
        return
      }
      try {
        const r = await rApi(x.id)
        await refresh()
        credErr.value = ''
        credView.value = { name: x.name, list: r.list }
      } catch (e) {
        credErr.value = e instanceof Error ? e.message : String(e)
        credView.value = { name: x.name, list: [] }
      }
    })()
  }
  /*
   * 措辞要跟**实际重置成的值**一致，而且分类型：
   *
   * 踩过的坑（用户报告「不是说 AstrBot 重置账密会变成 astrbot 吗？
   * 为什么还有地方显示 admin 和 mx123456」）：这里原来硬编码了
   * '用户名 admin、密码 mx123456' —— 那是很早以前的取值，
   * 后来按用户要求改成了 astrbot/astrbot（见 constants.ts），
   * 但这段文案没跟着改，于是界面自己打自己的脸。
   *
   * NapCat 那边重置的是 **token**，不是用户名密码，措辞也不一样。
   */
  const what =
    x.type === 'n'
      ? 'WebUI 登录 token 为 114514'
      : '用户名和密码都是 astrbot'
  if (running) {
    ask(`重置「${x.name}」的账密？`, `会先把实例停下来，重置账密为${what}。改完要重新启动才生效。`, go, true)
  } else {
    ask(`重置「${x.name}」的账密？`, `重置账密为${what}。改完要重新启动才生效。`, go, true)
  }
}

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

/*
 * 切换实例的运行时版本。
 *
 * 用户要求：「加入版本识别，支持高版本覆盖低版本且保留数据和配置的覆盖更新」。
 * 后续追加（2026-09-26）：「**astrbot的换个版本应该是从 astrbot 的 py 源里
 * 用户自己选，并测试降级升级**」。
 *
 * ## 为什么要改成"从源里列版本"（原来只看本地已装）
 *
 * 原来只列 `runtimes.list()`（**本机已装**的版本）。后果：
 *   · 用户想升级到 AstrBot 4.28.1 → 本地没有 → **列表里根本没有它**，
 *     得先去「下载」页装一遍，再回来换版本（两步且反直觉）
 *   · 用户想**降级**（新版本有 bug 想退回去）→ 同样要先去下载页
 *   · 而 AstrBot 的版本本来就来自 **PyPI 源**（唯一渠道），
 *     我们完全可以直接把那个源上的版本列出来让他选
 *
 * 现在：AstrBot 走 PyPI（`versions:list` 会带上它），NapCat 走它的源。
 * 两类的"可选版本"都来自各自的源，**升级/降级一视同仁**（列表按版本倒序，
 * 用户想选旧的就选旧的 —— 我们不做"只许升不许降"的限制：
 * 那是用户的机器，他比我们清楚哪个版本能跑）。
 *
 * 几个刻意的处理：
 *   - 已经在用的那个版本仍然列出来（但标"当前"），因为**重装同版本**
 *     是一个合理的修复动作（运行时坏了想重装）
 *   - 列表里标注大小与来源，让用户看清自己在换到哪个版本
 *   - 正在运行时如先说明会重启，别让用户以为数据会丢
 */
async function pickVersion(x: Instance): Promise<void> {
  const l = window as unknown as {
    launcher?: {
      runtimes?: { list?: () => Promise<Array<{ type: 'a' | 'n'; tag: string; sizeMB?: number }>> }
      instance?: {
        setRuntime?: (p: { id: string; tag: string; type: 'a' | 'n' }) => Promise<{
          changed: boolean
          from?: string
          to: string
          restarted?: boolean
          restartError?: string
        }>
      }
    }
  }

  /*
   * ══════════════════════════════════════════════════════════════════════════
   * ★★ 只列**本机已安装**的版本
   *   （主人 2026-09-27：「切换版本改成识别已安装版本，只显示已安装的，
   *     并标注列表只会显示已安装的版本」）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 改之前的两个问题（都是主人实测发现的）
   *
   *   ① 列的是**源上**的版本（PyPI 上 168 个 / NapCat 源上 30 个）——
   *      而 `instance:setRuntime` 后端**要求目标版本本机已装**，
   *      选了没装的会报"还没有下载到本机"。等于列表里大半选项点了必然失败。
   *   ② 列表**混了两个来源**且看不出哪个是哪个：
   *      主人原话「这个换版本是哪个源的，或者加上切换源」——
   *      `v4.18.19` 来自官方源、`v4.18.28/27/26…` 来自 PyPI/GitHub，
   *      混在一起既不知道出处，也不知道哪些真能用。
   *
   * ## 现在
   *
   *   · 只列 `runtimes:list()` 里的**已装版本**（后端的硬前提）
   *   · 标题/正文明确写出"只显示已装的"
   *   · 没有可切的时候，直接引导去「下载」页装（而不是给一堆选了会失败的选项）
   *   · 每个选项带上**大小**（已装版本的大小各不相同，是有用的信息，
   *     与"源上版本大小全都一样"那种噪音不同）
   */
  let installed: Array<{ type: 'a' | 'n'; tag: string; sizeMB?: number }> = []
  try {
    installed = (await l.launcher?.runtimes?.list?.()) ?? []
  } catch (e) {
    note('读不到已安装的版本', e instanceof Error ? e.message : String(e))
    return
  }
  const mineInstalled = installed.filter((v) => v.type === x.type)

  if (!mineInstalled.length) {
    note(
      '还没有装过这个类型的版本',
      `请先到「下载」页安装一个 ${x.type === 'a' ? 'AstrBot' : 'NapCat'} 版本，装好之后这里就能切了。`
    )
    return
  }

  const current = x.runtimeTag
  /* 当前版本排第一（用户最常做的是"重装/切回当前"），其余按版本倒序 */
  const ordered = [...mineInstalled].sort((a, b) => {
    if (a.tag === current) return -1
    if (b.tag === current) return 1
    return cmpTagDesc(a.tag, b.tag)
  })

  /*
   * ★ 已装版本的数量**通常很少**（用户不会装几十个），所以不再截断。
   * 但仍然防一手：万一有人手动导入了几十个，弹窗会撑爆 ——
   * 留一个上限并如实说明（这是"防御性"而非"常态"）。
   */
  const MAX_OPTIONS = 30
  const shown = ordered.slice(0, MAX_OPTIONS)

  const sizes = shown.map((v) => v.sizeMB).filter((s): s is number => typeof s === 'number')
  const sizeVaries = new Set(sizes).size > 1

  const options = shown.map((v) => {
    const bits = [v.tag]
    if (sizeVaries && v.sizeMB) bits.push(`${v.sizeMB} MB`)
    return { text: bits.join('  '), value: v.tag, current: v.tag === current }
  })

  const running = x.status === 'running' || x.status === 'starting'
  const picked = await chooseOne(
    `「${x.name}」切换到哪个版本？`,
    /* 明确写出"只列已装的"—— 主人要求的标注 */
    `这里只显示**已经装好**的版本。` +
      `要装新版本，去「下载」页。\n` +
      `数据和配置都会保留。` +
      (running ? `\n切换会先停掉实例，完成后自动重启。` : ''),
    options
  )
  if (!picked) return
  const tag = picked

  if (!l.launcher?.instance?.setRuntime) {
    note('暂时切换不了', '切换版本的接口没接上。')
    return
  }
  try {
    const r = await l.launcher.instance.setRuntime({ id: x.id, tag, type: x.type })
    await refresh()
    await refreshRuntimeState()
    if (r.restartError) {
      /*
       * 版本已经切好了，只是没能自动启动 —— 这两件事必须分开说。
       * 混在一起会让用户以为切换失败了，然后去重复操作。
       */
      note(
        `已切到 ${r.to}，但没能自动启动`,
        `版本切换成功，数据与配置都保留着。启动失败的原因：\n${r.restartError}`
      )
    } else if (r.changed) {
      note('版本已切换', `「${x.name}」现在是 ${r.to}，数据和配置都保留了。`)
    }
  } catch (e) {
    note('切换版本失败', e instanceof Error ? e.message : String(e))
  }
}

/**
 * 版本号倒序比较（新的在前）。
 *
 * 为什么自己写而不是用现成的：渲染层拿不到主进程的 `cmpVersion`
 *（那是主进程模块）。而这里只需要"把标签按版本从新到旧排"，
 * 三段的数字比较足够了。认不出来的（如 `imported-xxx`）排最后，
 * 它们不是真版本号，排在前面会干扰用户。
 */
function cmpTagDesc(a: string, b: string): number {
  const num = (t: string): number[] | undefined => {
    const m = t.match(/v?(\d+)\.(\d+)\.(\d+)/)
    if (!m) return undefined
    return [Number(m[1]), Number(m[2]), Number(m[3])]
  }
  const na = num(a)
  const nb = num(b)
  if (!na && !nb) return a.localeCompare(b)
  if (!na) return 1 // 认不出的排后面
  if (!nb) return -1
  for (let i = 0; i < 3; i++) {
    if (na[i] !== nb[i]) return nb[i] - na[i] // 倒序
  }
  return 0
}

/**
 * 「更新」：把这个实例升到该类运行时的最新版（用户新需求）。
 *
 * ## 背景（为什么不能靠 AstrBot 自己更新）
 *
 * 用户在 AstrBot 的 WebUI 里点「一键更新」，报：
 *
 *     Exception: Error: You are running AstrBot via CLI,
 *     please use `pip` or `uv tool upgrade` to update AstrBot.
 *
 * 那是 AstrBot 的**主动设计**：它检测到自己是被 `pip install --target`
 * 装出来的（我们运行时就是这个形态），于是禁用 WebUI 自更新。
 * 所以更新入口得由启动器提供。
 *
 * ## 这里只做三件事
 *
 *   1. 判能不能点（运行中不给更新 —— 用户明确要求）
 *   2. 跟用户确认（要联网装包，可能几分钟）
 *   3. 调 instance:update，把主进程返回的**具体结论**翻译成人话
 *
 * 真正的活儿（找最新版、装依赖、校验本体、切指针、二次确认没被启动）
 * 全在主进程，因为界面拿不到"什么是最新版"这个知识，
 * 而且"实例不许在运行时更新"这条约束必须由主进程把关 ——
 * 界面可以被绕过。
 */
async function updateInstance(x: Instance): Promise<void> {
  /*
   * 运行中直接拦下并说清怎么办。
   *
   * 界面上那个菜单项已经 disabled 了，但这里再拦一道：
   * 状态可能刚变化（用户在别处点了启动），而且按钮的 disabled
   * 不该是唯一的防线。
   */
  if (x.status === 'running' || x.status === 'starting') {
    note(
      '它正在运行哦',
      `更新要先装好新版本，而 ${x.type === 'a' ? 'AstrBot' : 'NapCat'} 在运行时` +
        `会占着旧版本的文件（Windows 会锁住），所以请先点「停止」再更新呀。`
    )
    return
  }

  const l = window as unknown as {
    launcher?: {
      instance?: {
        update?: (id: string) => Promise<{
          updated: boolean
          from?: string
          to?: string
          reason?: string
        }>
      }
    }
  }
  if (!l.launcher?.instance?.update) {
    note('暂时更新不了', '更新接口没接上。')
    return
  }

  const yes = await choose(
    `把「${x.name}」更新到最新版？`,
    '会先去网上取最新版本；需要下载并安装依赖，可能要几分钟。\n\n' +
      '你的实例数据、配置和登录状态都会完整保留，只更换运行时版本。\n\n' +
      '前提：它必须是停止状态（现在已经是了）。',
    '开始更新',
    '先不更新'
  )
  if (!yes) return

  busy.value = true
  /*
   * ══════════════════════════════════════════════════════════════════════════
   * ★★ 更新期间把这张卡片锁住（主人 2026-09-27 实测的真实问题）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 主人原话：
   *   「点击一键更新后没有提示了，本地有新版本倒是能秒更新，如果没有会去下载，
   *     没有提示用户就不知道其实在更新了，用户看你又去操作这个实例导致更多的 bug」
   *
   * ## 改之前的三个问题（叠加起来就是"更多 bug"）
   *
   *   ① **只置了全局 `busy`** —— 那个变量只用来禁用「新建实例」按钮，
   *      **卡片本身毫无变化**，用户看不到任何"正在更新"的迹象。
   *   ② **没有按实例锁**：卡片的 `:busy` 绑的是 `isBusyId(x.id)`，
   *      而更新走的是全局 `busy` → **那个实例的启动按钮照常可点**。
   *   ③ 于是用户在"看起来什么都没发生"的几分钟里点了启动 →
   *      实例在**装新版本的同时跑起来**，两边抢同一个运行时目录
   *      （Windows 会锁住正在使用的文件）→ 正是"更多 bug"的来源。
   *
   * ## 现在
   *
   *   · `markBusyId(x.id, true)` → 卡片进入忙碌态：
   *     启动/停止/换版本**全部禁用**（那些按钮都看 `isBusyId`）
   *   · `updatingIds` 记下"这个实例正在更新"，让按钮文字变成「更新中…」
   *     —— 光禁用是"点不动"，加文字才是"知道在干什么"
   *   · `finally` 里解锁（**含失败路径**，否则卡片永久锁死）
   */
  markBusyId(x.id, true)
  updatingIds.value = new Set([...updatingIds.value, x.id])
  try {
    const r = await l.launcher.instance.update(x.id)
    await refresh()
    await refreshRuntimeState()

    if (r.updated) {
      note('更新好啦', `「${x.name}」现在是 ${r.to ?? '最新版'}，数据和配置都保留了。`)
      return
    }

    /*
     * 没更新也要**说清为什么** —— 三种情况差别很大：
     *   · 本来就是最新（好消息，不该像报错）
     *   · 安装期间实例被启动了（用户操作导致，要告诉他再点一次）
     *   · 主进程给了别的原因
     */
    note('没有更新', r.reason ?? '已经是最新版本啦。')
  } catch (e) {
    note('更新失败', e instanceof Error ? e.message : String(e))
  } finally {
    busy.value = false
    /* ★ 失败也要解锁，否则这张卡片永久不能用启动/停止了 */
    markBusyId(x.id, false)
    const next = new Set(updatingIds.value)
    next.delete(x.id)
    updatingIds.value = next
  }
}

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

// 用户在 WebUI 里按 Esc / Ctrl+W 退出：主进程会通知，界面把按钮状态同步回来
onMounted(() => {
  const l = window.launcher as unknown as { webui?: { onClosed?: (cb: () => void) => () => void } }
  const off = l?.webui?.onClosed?.(() => {
    void refreshWebUi()
  })
  if (off) onUnmounted(off)
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
          /*
           * ★ 删除失败必须说出来（UI 审计抓出的真问题）
           *
           * 原来这里是 `try { ... } finally { ... }` —— **只有 finally、
           * 没有 catch**。而 AppDialog 在用户点下按钮时已经先把弹窗清空了
           * （`dlg.value = null`），所以一旦 remove 抛错：
           *   · 弹窗没了
           *   · 没有任何提示
           *   · 变成一条 unhandled rejection（只在控制台里，用户看不见）
           * 用户会以为"删掉了"，而实际上实例和数据都还在 ——
           * 他可能接着去手动删目录，或者干脆以为软件坏了。
           *
           * 删除是不可逆操作，它的失败**必须**让用户看见。
           */
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
interface Cred { label: string; value: string }
const credView = ref<{ name: string; list: Cred[] } | null>(null)
const credErr = ref('')

async function showCreds(x: Instance): Promise<void> {
  credErr.value = ''
  const cApi = (window as unknown as { launcher?: { instance?: { creds?: (id: string) => Promise<Cred[]> } } }).launcher?.instance?.creds
  if (!cApi) {
    return
  }
  try {
    const list = await cApi(x.id)
    if (list.length === 0) {
      credView.value = { name: x.name, list: [] }
      credErr.value = '暂未在运行时配置里找到账号信息（实例首次启动完成初始化后再试）'
    } else {
      credView.value = { name: x.name, list }
    }
  } catch (e) {
    credErr.value = String(e instanceof Error ? e.message : e)
  }
}

/*
 * `winCtl` 已删除（守卫测试 no-dead-renderer-code 抓出它只剩定义、没有调用点）。
 *
 * 它原来是"自绘标题栏"的窗口控制入口，而标题栏现在由
 * `components/TitleBar.vue` 组件接管 —— 那个组件自己调
 * `window.electron.window.*`，不再经过 App.vue。
 *
 * 留着它的害处：下一个人看到 `winCtl` 还在，会以为窗口控制走的是这里，
 * 于是去改一个根本不执行的分支。
 */
</script>

<template>
  <div class="shell">
    <!-- 融合式标题栏：无边框窗口控制 + 液态玻璃效果 -->
    <TitleBar />
    
    <!-- WebUI 视图盖在下面这块区域（顶部让出 78px）。这条工具条是最后一道保险：
         WebUI 页面白屏、渲染层状态错乱时,用户仍然点得到「退出」。 -->
    <div v-if="webuiOpen.size > 0" class="webbar">
      <span class="webwho">{{ webuiWho }}</span>
      <button class="webbtn" @click="closeAllWebUi">退出 WebUI</button>
    </div>
    <div class="body">
    <aside class="rail">
      <div class="railnav">
        <button class="railbtn" :class="{ 'is-active': page === 'a' }" title="AstrBot" @click="switchPage('a')"><span class="navglyph">A</span><span>AstrBot</span></button>
        <button class="railbtn" :class="{ 'is-active': page === 'n' }" title="NapCat" @click="switchPage('n')"><span class="navglyph">N</span><span>NapCat</span></button>
      </div>
      <div class="railfoot">
        <!-- 备份入口按用户要求去掉（功能问题多、意义不大） -->
        <button class="railbtn" :class="{ 'is-active': page === 'download' }" title="下载" @click="switchPage('download')">
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

    <main class="content">
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

      <!--
        空态分两种，别混成一句话：
          1. 这个类型的运行时**还没下载** → 光说「还没有实例」没用，用户缺的是运行时，
             直接给「前往安装」按钮送到下载页（他要装的东西就在那儿）。
          2. 运行时有了、只是还没建实例 → 直说没实例就行。
        原来两种情况都是「还没有 xx 实例——点右上角按钮创建第一个」，
        用户照着点会发现建不了（缺运行时），白跑一趟；
        而且「点右上角按钮」这种指路的话属于废话，按用户要求去掉了。
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
          <template v-if="tplState && !tplState[page]">
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
    </main>
    <img
      v-if="firstRun === false && page !== 'download' && shown.length > 0 && !settingsOpen && !wizardOpen && !logView"
      class="corner-mascot"
      :src="cornerMascot"
      alt=""
      aria-hidden="true"
    />

    <Teleport to="body">
    <div v-if="logView" class="logfull">
      <div class="loghead">
        <b>「{{ logView.name }}」日志</b>
        <!--
          关掉浮层必须**同时停掉轮询**（主人 2026-09-27 修"日志不刷新"时加的）。
          不停的话：浮层关了、定时器还在每 2 秒拉一次日志 ——
          白跑 IPC，而且用户再打开别的实例时会有两个定时器抢着写。
        -->
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

    <SettingsPanel
      v-if="settingsOpen && firstRun === false"
      @close="settingsOpen = false"
      @moved="onMoved"
    />

    <CreateWizard
      v-if="wizardOpen && firstRun === false"
      :default-type="page"
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

    <!--
      choiceList 必须传下去。
      漏了的话 AppDialog 里写好的列表形态永远不生效，界面会退回
      "十几个实心蓝按钮糊成一片"的老样子（实测踩过：组件改好了、
      调用方没绑 prop，真机一看毫无变化）。

      注意 HTML 注释的两条硬约束（都实测踩过，代价是界面直接炸）：
        1. 注释里不能出现连续两个短横线字符（那是注释的结束标记的一部分，
           会让注释提前结束，剩下的字变成正文渲染到界面上）
        2. 注释不能放在标签的属性列表中间（会被当成属性名，编译报
           Attribute name cannot contain U+0022）
    -->
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

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  position: relative;
  isolation: isolate;
  background:
    radial-gradient(ellipse at 12% 8%, rgba(177, 204, 255, 0.25), transparent 36%),
    radial-gradient(ellipse at 88% 92%, rgba(205, 220, 255, 0.2), transparent 34%),
    var(--bg);
}
.logfull {
  position: fixed;
  inset: 0;
  background: #fff;
  z-index: 60;
  display: flex;
  flex-direction: column;
}
.loghead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-bottom: 1px solid var(--hairline);
}
.logx {
  border: 1px solid var(--hairline);
  border-radius: var(--radius-ctrl);
  padding: 6px 12px;
  background: #fff;
  color: var(--ink-soft);
}
.logpre {
  flex: 1;
  overflow: auto;
  margin: 0;
  padding: 14px 20px;
  font: 12px/1.6 'JetBrains Mono', Consolas, monospace;
  white-space: pre-wrap;
  background: #fafbfd;
}
.titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 38px;
  padding-left: 14px;
  /*
   * 标题栏用极淡的主色渐变（而非纯灰），呼应图标的冷蓝底色。
   * 左端稍浓一点，正好把品牌名托起来，也让自绘标题栏不至于是一块死灰。
   */
  background: var(--glass-fill);
  border-bottom: 1px solid var(--glass-edge);
  box-shadow: 0 1px 0 rgba(76, 112, 177, 0.06);
  backdrop-filter: blur(22px) saturate(155%);
  -webkit-backdrop-filter: blur(22px) saturate(155%);
  -webkit-app-region: drag;
  user-select: none;
  flex: none;
}
.brand {
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 650;
  font-size: 13px;
  color: var(--primary-deep);
  letter-spacing: 0.2px;
}
.brand img {
  width: 22px;
  height: 22px;
  object-fit: contain;
}
.exitwebui {
  margin-left: auto;
  padding: 5px 14px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-ctrl);
  background: #fff;
  /* 接到变量上：原来这里硬编码 #c0564f（白字 4.48，不达标） */
  color: var(--danger);
  font-size: 12px;
}
.exitwebui:hover {
  background: var(--danger);
  color: #fff;
}
/* WebUI 工具条：正好落在视图让出的那块空间里，保证退出入口一定看得见。
   高度与 WEBUI_TOP_INSET（74px）里的 34px 严格对应：标题栏 40px + 本工具条 34px。
   两者必须相加等于视图内缩值，否则中间会露出软件底色。 */
.webbar {
  height: 34px;
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
  margin: 0;
  background: linear-gradient(
    135deg,
    rgba(255, 255, 255, 0.86) 0%,
    rgba(238, 245, 253, 0.72) 100%
  );
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  border-bottom: 1px solid rgba(220, 228, 241, 0.6);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7);
  font-size: 12.5px;
  color: var(--ink-soft);
  flex: 0 0 auto;
}
.webwho {
  color: var(--ink);
}
.webhint {
  color: var(--ink-soft);
}
.webbtn {
  margin-left: auto;
  padding: 4px 14px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-ctrl);
  background: #fff;
  color: var(--danger);
  font-size: 12.5px;
}
.webbtn:hover {
  background: var(--danger);
  color: #fff;
}
/*
 * `.winctl` 系列样式已随 `winCtl` 一起删除 —— 窗口控制按钮现在
 * 由 `components/TitleBar.vue` 自己带样式（scoped），这里留着是死 CSS。
 */
.body {
  flex: 1;
  display: flex;
  min-height: 0;
  position: relative;
  z-index: 1;
  isolation: isolate;
}
.corner-mascot {
  position: fixed;
  z-index: 0;
  right: 0;
  bottom: 0;
  width: clamp(160px, 20vw, 256px);
  height: auto;
  opacity: 0.62;
  pointer-events: none;
  user-select: none;
}
.body .content {
  flex: 1;
  overflow: auto;
  position: relative;
  z-index: 1;
}
.body .rail {
  margin-top: 0;
}
.rail {
  width: 172px;
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
  padding: 16px 12px;
  background: color-mix(in srgb, var(--glass-fill) 88%, transparent);
  border-right: 1px solid var(--glass-edge);
  backdrop-filter: blur(22px) saturate(145%);
  -webkit-backdrop-filter: blur(22px) saturate(145%);
}

.railnav {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 5px;
  margin-top: 6px;
}
.railbtn svg {
  display: block;
}
.railfoot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 5px;
}
/* 所有侧栏按钮同尺寸同光学中心，图标才不会看着歪 */
.railbtn {
  width: 100%;
  min-height: 44px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 0;
  line-height: 1;
  border: none;
  border-radius: 9px;
  background: transparent;
  gap: 12px;
  padding: 0 12px;
  font-size: 13px;
  font-weight: 550;
  color: var(--ink-soft);
  transition: background 0.14s ease, color 0.14s ease;
}
.railbtn:hover {
  background: var(--primary-soft);
  color: var(--primary-deep);
}
.railbtn.is-active {
  background: linear-gradient(110deg, rgba(255, 255, 255, 0.86), rgba(223, 234, 255, 0.72));
  color: var(--primary-deep);
  box-shadow: inset 0 0 0 1px rgba(79, 119, 190, 0.12), 0 3px 12px rgba(70, 105, 165, 0.08);
}
.content {
  flex: 1;
  overflow: auto;
  padding: 28px 36px 44px;
}
.topbar {
  display: flex;
  align-items: baseline;
  gap: 14px;
  margin-bottom: 16px;
}
.topbar h1 {
  margin: 0;
  font-size: 24px;
  letter-spacing: -0.025em;
}
.topbar span {
  color: var(--ink-soft);
  font-size: 12.5px;
}
.createbtn {
  margin-left: auto;
  padding: 9px 18px;
  border: none;
  border-radius: var(--radius-ctrl);
  background: var(--primary);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
}
.createbtn:hover {
  background: var(--primary-deep);
}
.createbtn:active {
  transform: scale(0.98);
}
/* .sysline / .sysline.hot 已随系统余量显示一起删除 ——
   没有消费者的样式只会让下一个人以为"这儿还显示着什么"。
   （顺带清掉了里面写死的 #c0564f，那是绕开 tokens.css 的硬编码颜色。） */
/* 页面切换：淡入 + 轻微上移（页签点击）/淡出 */
.page-enter-active,
.page-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.page-enter-from {
  opacity: 0;
  transform: translateY(10px);
}
.page-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
/* 卡片进出：渐显 / 渐隐，多卡 DISPATCH 时用 FLIP 自然滑动 */
.cardpop-enter-active {
  transition: opacity 0.22s cubic-bezier(0.2, 0.8, 0.2, 1), transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.cardpop-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
  position: absolute;
}
.cardpop-enter-from {
  opacity: 0;
  transform: translateY(12px) scale(0.98);
}
.cardpop-leave-to {
  opacity: 0;
  transform: scale(0.96);
}
.cardpop-move {
  transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.mask {
  position: fixed;
  inset: 0;
  background: rgba(24, 39, 65, 0.25);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 40;
  -webkit-backdrop-filter: blur(10px) saturate(125%);
  backdrop-filter: blur(10px) saturate(125%);
}
.dlg.confirm {
  position: relative;
  isolation: isolate;
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.86), rgba(242, 247, 255, 0.72));
  border: 1px solid var(--glass-edge);
  border-radius: 20px;
  padding: 22px 24px;
  width: 420px;
  -webkit-backdrop-filter: blur(28px) saturate(160%);
  backdrop-filter: blur(28px) saturate(160%);
  box-shadow: 0 24px 64px rgba(19, 37, 70, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.9);
  animation: popin 0.2s cubic-bezier(0.2, 0.9, 0.3, 1.2);
}
.creds {
  margin: 0 0 8px;
}
.credrow {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 0;
  border-bottom: 1px solid var(--hairline);
}
.credrow dt {
  width: 92px;
  color: var(--ink-soft);
  font-size: 13px;
  margin: 0;
}
.credrow dd {
  margin: 0;
}
.credrow code {
  background: #f0f3f8;
  border-radius: 6px;
  padding: 2px 10px;
  font-size: 13px;
  user-select: all;
}
.hint2 {
  color: var(--ink-soft);
  font-size: 12px;
}
.warn2 {
  color: var(--ink-soft);
  font-size: 13px;
  line-height: 1.6;
}
.err {
  color: var(--danger);
  font-size: 12px;
}
.main.danger {
  background: var(--danger);
}
.main.danger:disabled {
  opacity: 0.45;
}
/*
 * 空态居中放在面板中间，别缩在左上角。
 * 缺运行时是「要用这页必须先做一件事」，视觉上要抓得住眼睛。
 */
.empty {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: clamp(20px, 4vw, 48px);
  text-align: center;
  min-height: min(62vh, 500px);
  padding: 28px 20px;
  color: var(--ink-soft);
  line-height: 1.7;
}
.empty-copy {
  max-width: 360px;
  text-align: left;
}
.empty-mascot {
  width: clamp(190px, 25vw, 310px);
  max-height: min(52vh, 390px);
  object-fit: contain;
  filter: drop-shadow(0 14px 26px rgba(54, 78, 119, 0.12));
}
.empty-mascot.install-mascot {
  width: clamp(160px, 20vw, 250px);
  max-height: min(44vh, 320px);
}
.emptytitle {
  margin: 0 0 8px;
  color: var(--ink);
  font-size: 23px;
  font-weight: 650;
  letter-spacing: -0.02em;
}
.emptyline {
  max-width: 34em;
}
.emptyline {
  margin: 0;
}
/*
 * 「前往安装」按钮。
 *
 * 踩过的坑（用户报告「没有文件包时提示去安装的字，下面的『去安装』怎么
 * 这么白，为什么不做成蓝底按钮」）：
 * 原来这里写的是 `background: var(--accent)`，而 tokens.css 里**根本没有**
 * `--accent` 这个变量（真实存在的是 --primary）。CSS 变量取了未定义的值时
 * 整条声明失效 → 背景变透明 → 在白卡片上就是一个「白按钮」，
 * 而且完全不报错，光看代码也看不出来。
 *
 * 现在用真实存在的 --primary，并把悬停/按下做得更明确一点，
 * 让它一眼就是个主按钮。
 */
.emptygo {
  border: none;
  background: var(--primary);
  color: #fff;
  font: inherit;
  font-size: 13.5px;
  font-weight: 500;
  padding: 9px 22px;
  border-radius: var(--radius-ctrl);
  cursor: pointer;
  transition: background 0.14s ease;
}
.emptygo:hover {
  background: var(--primary-deep);
}
.emptygo:active {
  background: var(--primary-deep);
  filter: brightness(0.96);
}
.cards {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0;
  border-top: 1px solid var(--hairline);
}
@media (max-width: 760px) {
  .rail {
    width: 62px;
    align-items: center;
    padding-inline: 7px;
  }
  .railnav,
  .railfoot {
    width: 100%;
    align-items: center;
  }
  .railbtn {
    width: 44px;
    min-height: 44px;
    justify-content: center;
    padding: 0;
  }
  .railbtn > span:not(.navglyph) {
    display: none;
  }
  .railbtn.is-active {
    box-shadow: inset 0 -3px 0 var(--primary);
  }
  .content {
    padding: 20px 18px 30px;
  }
  .empty {
    gap: 16px;
    min-height: 360px;
  }
  .empty-copy {
    max-width: 260px;
  }
  .empty-mascot {
    width: 220px;
    max-height: 300px;
  }
  .empty-mascot.install-mascot {
    width: 180px;
    max-height: 260px;
  }
  .topbar {
    align-items: center;
    flex-wrap: wrap;
  }
}
@media (max-width: 520px) {
  .empty {
    flex-direction: column;
    gap: 4px;
  }
  .empty-copy {
    text-align: center;
  }
  .empty-mascot {
    width: min(58vw, 230px);
    max-height: 260px;
  }
  .empty-mascot.install-mascot {
    width: min(48vw, 190px);
    max-height: 220px;
  }
}
.navglyph {
  width: 22px;
  height: 22px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 6px;
  background: color-mix(in srgb, var(--primary) 10%, white);
  color: var(--primary-deep);
  font-size: 11px;
  font-weight: 700;
}
.railbtn svg {
  width: 20px;
  height: 20px;
  flex: none;
}
/*
 * 启动错误横幅：贴着标题栏下方，显眼但不挡操作。
 *
 * 用户报告：「AstrBot 重置完账密之后……报错内容溢出屏幕。报错弹窗大小要固定，
 * 报错内容超出部分省略，而且不能影响上面的正常 UI 和界面。」
 *
 * 原因：里面的 <span> 没有任何宽度约束，而启动失败的 message 会把
 * **进程最后 300 字输出**整段塞进来（含 ANSI 转义、多行日志），
 * 于是横幅被撑得又宽又高，糊住整个界面。
 *
 * 解法：
 *   - 横幅本身限高 + 内部滚动，绝不长过一屏
 *   - 文本截断（省略号），完整内容通过 title 悬浮可见
 *   - 按钮 flex-shrink:0 保证「知道了」永远点得到（它被挤掉就关不掉了）
 */
.booterr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 10px 16px 0;
  padding: 10px 14px;
  border: 1px solid var(--ribbon-error);
  border-radius: var(--radius-ctrl);
  background: var(--card-a);
  font-size: 13px;
  color: var(--ink);
  /* 限高：最多两行左右的高度，超出滚动 */
  max-height: 96px;
  overflow-y: auto;
}
/* 文本占满剩余空间并截断，别把按钮挤出去 */
.booterr > span {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.booterr button {
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-ctrl);
  background: var(--card-n);
  color: var(--ink);
  padding: 6px 14px;
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
}
</style>


