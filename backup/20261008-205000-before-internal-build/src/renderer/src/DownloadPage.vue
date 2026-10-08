<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
/*
 * SWR 缓存（指导书第二章）。
 * 我第一版写了这些调用却**忘了 import** —— mounted 里直接 ReferenceError，
 * 整页白屏、8 条界面测试红。测试抓出来的，记在这里：
 * 新增模块级工具时，先确认 import 再写调用。
 */
import {
  dlHydrate,
  dlHydrateFresh,
  dlNextLoadId,
  dlIsCurrentLoad,
  dlSave,
  dlSaveHealth,
  dlNoteLoadFailed,
  dlInvalidate,
  dlMarkProbed,
  dlProbeBlocked
} from './dl-cache'

/** QQ 官网下载页（与主进程 qq-check.ts 里的常量保持一致） */
const QQ_DOWNLOAD_URL = 'https://im.qq.com/pcqq/index.shtml'

interface Mirror {
  label: string
  base: string
  mode: 'proxy' | 'files'
  builtin?: boolean
  hideBase?: boolean
  note?: string
}
interface MirrorState {
  mirrors: Mirror[]
  pref: { a: string; n: string }
}
interface VersionItem {
  tag: string
  assetName: string
  sizeMB?: number
  publishedAt?: string
  prerelease?: boolean
  from: string
  base: string
}
interface RuntimeVersion {
  type: 'a' | 'n'
  tag: string
  from?: string
  installedAt: string
  sizeMB?: number
}
interface Progress {
  type: 'a' | 'n'
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

interface LauncherApi {
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
  versions?: { list?: (p: { type: 'a' | 'n'; base?: string }) => Promise<VersionItem[]> }
  runtime?: { install?: (p: { type: 'a' | 'n'; tag: string; base?: string }) => Promise<{ tag: string; from: string }> }
  runtimes?: {
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
    cancel?: (p: { type: 'a' | 'n'; tag: string }) => Promise<{ ok: boolean; reason?: string }>
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

const api = (): LauncherApi => ((window as unknown as { launcher?: LauncherApi }).launcher ?? {})

const state = ref<MirrorState | null>(null)
const runtimes = ref<RuntimeVersion[]>([])
const py = ref<{ ready: boolean; version: string } | null>(null)
/**
 * 进度按任务分别记：同时装 Python + AstrBot + NapCat 时，
 * 之前只有一个 progress 变量，后开始的会把先开始的覆盖掉，
 * 看着就像「只显示一个在下载」。
 */
const progressMap = ref<Map<string, Progress>>(new Map())
const progressList = computed(() => [...progressMap.value.values()])

/*
 * ★ "看起来卡死"的保护（指导书 7.3(5)）
 *
 * pip 装几十个依赖时，中间可能有一段**没有任何输出**（比如在解压一个
 * 大 wheel、或在等镜像响应）。此时进度百分比不动、包名也不变 ——
 * 界面看上去就是死了。主人的原话正是「看起来在装但不走，以为卡死」。
 *
 * 判据：某个任务**超过 5 秒**没收到新的进度事件 → 在它的标签位置显示
 * 「正在处理，请稍候…」。靠一个 1 秒的 tick 驱动（只在有任务在跑时开），
 * 与进度事件本身的节奏解耦 —— 收不到事件也能靠时间判断。
 */
const STALL_MS = 5000
/** 每个任务最后一次收到进度事件的时刻 */
const lastEventAt = new Map<string, number>()
/** 每秒 +1 的"时钟"，用来触发 stall 的重新计算（computed 才会有反应） */
const stallTick = ref(0)
let stallTimer: ReturnType<typeof setInterval> | undefined

function markEvent(key: string): void {
  lastEventAt.set(key, Date.now())
  /* 有任务在跑就确保时钟在转；没有任务就停掉（省电、也避免无谓渲染） */
  if (!stallTimer && progressMap.value.size > 0) {
    stallTimer = setInterval(() => {
      stallTick.value++
      if (progressMap.value.size === 0) {
        clearInterval(stallTimer)
        stallTimer = undefined
      }
    }, 1000)
  }
}

/** 这个任务是不是"暂时没有新输出"（>5s 没动静，且还没结束） */
function isStalled(p: Progress): boolean {
  void stallTick.value // 建立响应式依赖：每秒重算
  if (p.phase === 'done' || p.phase === 'error') return false
  const at = lastEventAt.get(trackKey(p))
  if (!at) return false
  return Date.now() - at > STALL_MS
}

/**
 * 这个任务已经跑了多久（秒）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 为什么要显示"已用时"（主人 2026-09-27：
 *    「这个正在处理请稍后到底是啥，卡在这里很久，用户看见会以为卡死了，
 *      你也没个进度显示什么的」）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 原来说「正在处理，请稍候…」的毛病
 *
 * 那句话**本身就是"卡住了"的语气** —— 它没有传达任何信息：
 *   · 不知道在干什么
 *   · 不知道还要多久
 *   · 不知道它是不是还活着
 *
 * 而装 AstrBot 依赖本来就要**几分钟**，期间 pip 可能有一大段没有输出
 *（构建某个源码包、解压大 wheel）。那几分钟里用户只能盯着这句话。
 *
 * ## 现在给两样东西
 *
 *   ① **已用时**（每秒在涨）—— 数字在动本身就是"它还活着"的最强信号，
 *      比任何文案都有效
 *   ② 一句**说清在干什么**的说明（而不是"请稍候"）
 *
 * 见模板里那个 `stallHint`。
 */
function elapsedSec(p: Progress): number {
  void stallTick.value
  /*
   * ★ 优先用**主进程给的** startedAt（主人 2026-09-27：
   *   「正在安装依赖 · 已用 3 秒 —— 切换到其他页面回来，计时又刷新了」）
   *
   * 原来只用下面那个组件内的 Map —— 切走页面组件卸载、Map 没了，
   * 切回来又从 0 读。而主进程在每个事件里带着 it 的**真实起点**，
   * 所以跨页面切换也准。
   *
   * 本地 Map 保留作回落：测试构造的事件、或老主进程（不发这个字段）时用。
   */
  const fromMain = (p as { startedAt?: number }).startedAt
  const at = fromMain ?? startedAt.get(trackKey(p))
  if (!at) return 0
  return Math.max(0, Math.round((Date.now() - at) / 1000))
}

/** 任务开始时刻（**回落用**：主进程没给 startedAt 时，首次见到它时自己记） */
const startedAt = new Map<string, number>()

/**
 * 正在取消中的任务键。
 *
 * 为什么要它：取消是**异步生效**的（主进程发 abort，pip/fetch 响应并退出
 * 需要时间）。点了之后必须立刻给反馈 —— 否则用户会以为没点着，
 * 然后连点好几下。
 */
const cancelling = ref<Set<string>>(new Set())

/**
 * 取消一个正在进行的下载/安装。
 *
 * 主人 2026-09-27：「安装/下载一个加入取消，防止卡住了只能重启软件
 * 来换更快的安装/下载源」。
 *
 * ## 流程
 *
 *   ① 立刻标成"取消中…"（按钮禁用）—— 给反馈，防连点
 *   ② 调主进程的 `runtimes:cancel`（它按 `<type>:<tag>` 定位任务）
 *   ③ **等主进程那边真的结束**：它会发一条 `phase:'error'` 的进度事件
 *      （"已取消"），那条事件到达时清掉"取消中"标记
 *
 * ## 为什么不在这里直接清掉标记
 *
 * 因为"发出取消"≠"已经停了"。立刻清掉的话按钮会变回可点的「取消」，
 * 而那个任务可能还在跑 —— 用户以为没生效，又点一次。
 * 所以标记的清除**挂在事件上**（见 setProgress 里那段）。
 */
async function cancelTask(p: Progress): Promise<void> {
  const key = trackKey(p)
  if (cancelling.value.has(key)) return
  cancelling.value = new Set([...cancelling.value, key])
  try {
    const r = await api().runtimes?.cancel?.({ type: p.type, tag: p.tag })
    if (!r?.ok) {
      const next = new Set(cancelling.value)
      next.delete(key)
      cancelling.value = next
      return
    }

    /* 主进程已发出 abort 后，先在本地落一个结束态。
     * 这样即使 pip/子进程回收或 IPC 事件稍有延迟，用户点击后也会马上看到反馈。 */
    const next = new Map(progressMap.value)
    next.set(key, {
      ...p,
      phase: 'error',
      percent: null,
      gotText: '',
      speedText: '',
      error: '已取消 —— 你可以换个更快的源重新下载'
    })
    progressMap.value = next
    cancelling.value = new Set()
    scheduleClear(key, 6000)
  } catch {
    const next = new Set(cancelling.value)
    next.delete(key)
    cancelling.value = next
  }
}

function trackKey(p: Progress): string {
  return `${p.type}|${p.tag}`
}
function setProgress(p: Progress): void {
  const next = new Map(progressMap.value)
  next.set(trackKey(p), p)
  progressMap.value = next
  /*
   * 首次见到就记下（作为**回落**）。主进程给了 startedAt 时不会用到它 ——
   * 但两个都留着：主进程那条更准，这条保证"没有主进程数据时也有个起点"。
   */
  if (!startedAt.has(trackKey(p))) startedAt.set(trackKey(p), Date.now())
  markEvent(trackKey(p))
  /*
   * ★ 结束事件到达 → 清掉"取消中"标记（取消流程的收尾）。
   *
   * 取消走的是 `phase: 'error'` 这条路（原因文案是"已取消…"），
   * 所以这里对 error 一视同仁地清掉即可 —— 无论它是取消导致的
   * 还是真失败，那个任务都已经不在跑了。
   */
  if (p.phase === 'done' || p.phase === 'error') {
    if (cancelling.value.has(trackKey(p))) {
      const nx = new Set(cancelling.value)
      nx.delete(trackKey(p))
      cancelling.value = nx
    }
  }
  if (p.phase === 'done') {
    void reload()
    scheduleClear(trackKey(p), 2500)
  } else if (p.phase === 'error') {
    scheduleClear(trackKey(p), 6000)
  }
}

/*
 * ★ 延时清理必须登记，卸载时要一起取消
 *
 * UI 审计抓出来的：原来直接 `setTimeout(...)`，**id 既不保存也不清理**。
 * onUnmounted 只取消了 offProgress 订阅。
 *
 * 后果：用户看到"下载完成"后马上切到别的页（App.vue 用 v-if 挂载本页，
 * 切页即卸载），那个 2.5 秒后的回调仍会执行 —— 它会去写一个
 * 已经卸载的组件的 ref。Vue 会报警告，而且这个定时器会**一直挂着**
 * 到点才释放。反复进出下载页就会攒下一堆。
 *
 * 现在把 id 收进一个 Set，onUnmounted 里统一 clearTimeout。
 * 用 Set 而不是数组：同一个 key 连续调度时不会重复堆积。
 */
const pendingClear = new Set<ReturnType<typeof setTimeout>>()
function scheduleClear(key: string, ms: number): void {
  const id = setTimeout(() => {
    pendingClear.delete(id)
    clearProgress(key)
  }, ms)
  pendingClear.add(id)
}
function cancelPendingClears(): void {
  for (const id of pendingClear) clearTimeout(id)
  pendingClear.clear()
}
function clearProgress(key: string): void {
  const cur = progressMap.value.get(key)
  // 已经结束了才清，免得把新一轮的进度误删
  if (cur && cur.phase !== 'done' && cur.phase !== 'error') return
  const next = new Map(progressMap.value)
  next.delete(key)
  progressMap.value = next
  /* 开始时刻也要清（否则它与 lastEventAt 一样会无界增长） */
  startedAt.delete(key)
  /*
   * ★ 时间戳也要一起删（四厂商审计提的"Map 只增不减"）
   *
   * lastEventAt 是"这个任务最后收到进度的时刻"，本来只在任务活着时有意义。
   * 不清的话它会随每次安装/下载攒下去 —— 单次会话量级很小（几十条），
   * 但这是**无界的增长**，而且留着过期时间戳没有任何用途。
   * 清了之后 isStalled 对已消失的任务自然返回 false（get 不到）。
   */
  lastEventAt.delete(key)
}
/*
 * `isSettled` 已删除（守卫测试 no-dead-renderer-code 抓出只剩定义）。
 * 它原来给旧进度条判断"任务结束没"，而那个进度条在重写布局时
 * 换成了新的任务条（直接用 p.phase 判断），于是它成了死代码。
 */
const err = ref('')
/*
 * 删除成功后的**非错误**提示（比如"某个实例的版本记录损坏了"）。
 *
 * 为什么不复用 err：那是红色的失败信息，而"删成功了但有个副作用要提醒"
 * 是两回事 —— 混在一起用户会以为删除失败了。
 */
const note = ref('')
/**
 * 谁在忙就只锁谁。之前用一个全局 busy，装 Python 会让所有「下载」按钮
 * 一起变成"下载中"，看着像全都在装——这里按「类型|版本」精确记。
 */
const busyKeys = ref<Set<string>>(new Set())
const pyBusy = ref(false)

function keyOf(type: 'a' | 'n', tag: string): string {
  return `${type}|${tag}`
}
function isBusy(type: 'a' | 'n', tag: string): boolean {
  return busyKeys.value.has(keyOf(type, tag))
}
function markBusy(type: 'a' | 'n', tag: string, on: boolean): void {
  const next = new Set(busyKeys.value)
  if (on) next.add(keyOf(type, tag))
  else next.delete(keyOf(type, tag))
  busyKeys.value = next
}

// 弹窗状态：选源 → 选类型 → 选版本
const picking = ref<Mirror | null>(null) // 正在从哪个源选
const pickType = ref<'a' | 'n'>('a')
const versions = ref<VersionItem[]>([])
const loadingVersions = ref(false)

const newLabel = ref('')
const newBase = ref('')
const newMode = ref<'proxy' | 'files'>('proxy')
const showAdd = ref(false)

const mirrors = computed(() => state.value?.mirrors ?? [])

/*
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 源按类型分类（主人 2026-09-27 的要求）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 主人原话：
 *   「你为啥不直接在下载页分类，NapCat 下载，下面是 github 源和官方源，
 *     AstrBot 下载，下面是 python 源和官方源」
 *
 * 以前所有源混在一个"镜像源"卡片里，每张卡片的「下载」按钮会去问
 * `nextPickType(m)` —— 于是点 GitHub 源也能翻到 AstrBot（而 GitHub 上
 * 根本没有可用的 AstrBot 后端），用户当然要问"为什么 github 源里还有 astrbot"。
 *
 * 现在：界面分两块，**与后端的源过滤一一对应**（见 version-catalog.ts 里
 * "按类型过滤源"那段）：
 *   · AstrBot 下载 → Python 源（pip 索引） + 官方源
 *   · NapCat 下载  → GitHub 源（直连/代理） + 官方源
 */
/*
 * `officialMirrors`（mode==='files' 的官方文件源）已删除。
 *
 * 主人 2026-10-08 要求「去掉官方源」，模板里那一组行已经移掉，
 * 这个 computed 就只剩定义了（守卫测试抓出）。留着会让下一个人
 * 以为"官方源还在界面上某个地方显示"。
 */
/** GitHub 系源（mode==='proxy'）：只对 NapCat 有意义 */
const githubMirrors = computed(() => mirrors.value.filter((m) => m.mode === 'proxy'))

/*
 * AstrBot 的 **Python 源**（pip 索引）—— 从主进程的 python-sources.json 读。
 * 界面放在"下载"页而不是设置页（主人明确要求：下载页分类才直观）。
 */
interface PySourceItem {
  label: string
  indexUrl: string
  note?: string
  builtin?: boolean
}
const pySources = ref<{ sources: PySourceItem[]; pref: string; active?: PySourceItem }>({
  sources: [],
  pref: ''
})
const pyActive = ref('')

/**
 * Python 源的实测延迟（与 `mirrorHealth` 对称）。
 *
 * 主人 2026-09-27：「加入和 github 一样的测通断」。
 * key 用 indexUrl（渲染层的 v-for 也是按它做 key）。
 */
const pyHealth = ref<Map<string, { status: string; ms: number | null; reason?: string }>>(
  new Map()
)

/** 探测所有 Python 源的通断与延迟（与 probeMirrors 同一形态） */
async function probePySources(): Promise<void> {
  try {
    const l = window as unknown as {
      launcher?: {
        pysrc?: {
          test?: () => Promise<Array<{ indexUrl: string; status: string; ms: number | null; reason?: string }>>
        }
      }
    }
    const rows = (await l.launcher?.pysrc?.test?.()) ?? []
    const m = new Map<string, { status: string; ms: number | null; reason?: string }>()
    for (const r of rows) m.set(r.indexUrl, { status: r.status, ms: r.ms, reason: r.reason })
    pyHealth.value = m
  } catch {
    /* 探测失败就当没测过，不打扰用户（与 GitHub 源一致） */
  }
}

/**
 * 一次重测**两边**的源（GitHub 源 + Python 源）。
 *
 * 为什么要有这个：界面上只有「重新检测」一个按钮，用户在心理上认为
 * 它测的是"所有源"。原来只测 GitHub 那半边，Python 源的徽章会停在
 * 进页面时的旧值 —— 用户点了检测却发现那一栏没变化，看着像坏了。
 */
async function probeBoth(): Promise<void> {
  await Promise.all([probeMirrors(), probePySources()])
}

async function loadPySources(): Promise<void> {
  try {
    const l = window as unknown as {
      launcher?: {
        pysrc?: { state?: () => Promise<{ sources: PySourceItem[]; pref: string; active?: PySourceItem }> }
      }
    }
    const st = await l.launcher?.pysrc?.state?.()
    if (st) {
      pySources.value = st
      pyActive.value = st.active?.label ?? ''
    }
  } catch {
    /* 读不到就不显示 Python 源那一栏（不该让整页报错） */
  }
}

/*
 * `setPySource` 已删除（主人 2026-09-27 去掉「用这个」按钮之后它没人调了）。
 *
 * 原来的语义是"把某个源设成首选源"—— 那是个**全局配置**，
 * 用户为了装一次腾讯源还得先改配置，多一步且反直觉。
 * 现在的语义是「点哪个源的下载，就用哪个源装这一次」，
 * 靠 install() 把 indexUrl 传给后端实现，不需要"首选源"这个概念。
 *
 * 后端的 `pysrc:pref` 通道保留（用户自定义源时仍可能需要），
 * 只是界面不再暴露"设为当前"这个动作。
 */

/**
 * 弹窗里那句"版本从哪来"的说明。
 *
 * 主人 2026-09-27 两处质疑都指向同一件事：**界面没说清版本的出处**。
 *   · 「官方源也是高达几十个版本，你真的塞了这么多版本在我的服务器上吗」
 *   · 「这个换版本是哪个源的」
 *
 * ## 但第一版我又写成了废话（主人当场指出）
 *
 * 原文：「版本列表来自 PyPI（AstrBot 的官方发布渠道），装的时候用你点的这个源。」
 * 问题：
 *   · 「AstrBot 的官方发布渠道」—— 括号里的解释，用户不需要
 *   · 「装的时候用你点的这个源」—— 那本来就是"点哪个用哪个"的应有之义，
 *     说出来等于解释了一遍点击行为
 *
 * ## 现在：只留**用户会误判的那一点**
 *
 * 用户真正会误判的是：**以为这些包存在我们服务器上**。
 * 所以只需要说清"这些版本是从 PyPI 查来的"。
 *
 * 具体源（官方源/GitHub 源）那条不用说话 —— 列表本来就是那个源的内容，
 * 标题已经写着源名了（"这里是这个源上现有的版本"同样是废话）。
 */
const versionSourceHint = computed<string>(() => {
  const m = picking.value
  if (!m) return ''
  if (pickType.value === 'a' && !m.base) {
    return '版本来自 PyPI'
  }
  return ''
})

async function removePySource(indexUrl: string): Promise<void> {
  try {
    const l = window as unknown as {
      launcher?: {
        pysrc?: {
          remove?: (v: string) => Promise<{ sources: PySourceItem[]; pref: string; active?: PySourceItem }>
        }
      }
    }
    const st = await l.launcher?.pysrc?.remove?.(indexUrl)
    if (st) {
      pySources.value = st
      pyActive.value = st.active?.label ?? ''
    }
  } catch (e) {
    /*
     * ★ 这里原来是 `note?.('删除 Python 源失败', ...)` —— **必然抛 TypeError**
     *   （子代理审计抓出，我复核确认：本文件第 225 行 `const note = ref('')`，
     *    它是个**字符串 ref**，不是函数；而 `note()` 那个函数在 App.vue 里，
     *    这个组件根本没有）
     *
     * 后果比"不提示"更糟：catch 里**二次抛错**，
     * "删除 Python 源失败"的真实原因（后端报什么错）全部丢失，
     * 界面上什么都不显示 —— 用户点了"删"，源还在，也没有任何解释。
     *
     * 本组件自己的错误显示变量是 `err`（页面顶部那条红字）。
     */
    err.value = `删除 Python 源失败：${e instanceof Error ? e.message : String(e)}`
  }
}

/**
 * 打开"选版本"弹窗。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ Python 源**不能传 base** —— 这是"点下载没反应"的真凶
 *   （主人 2026-09-27 反馈：「点下载怎么没反应」，日志里
 *     只有 app:checkUpdate、**没有任何 runtime:install / 下载记录**）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 原来错在哪
 *
 * 我给 Python 源构造了一个假的 mirror：
 *     { label: 'Python 源', base: indexUrl, mode: 'files' }
 * 然后 `loadVersions` 把 `base` 原样传给 `versions:list`。
 * 而后端拿到 base 后会把它当**文件源**去拼清单：
 *     https://pypi.org/simple/versions.json     ← 这个地址**根本不存在**
 * 于是版本列表永远是空的 → 弹窗里什么都没有 →
 * 用户看到的就是"点了下载，一点反应都没有"。
 *
 * ## 正确做法
 *
 * `versions:list` 对 AstrBot 的处理本来就有两条路：
 *   · 传 `base` → 只从那个源找（文件源读 versions.json）
 *   · **不传 base** → 走 PyPI 元数据（`listAstrbotPypiVersions`）
 *
 * AstrBot 的版本**本来就来自 PyPI**（它的后端只在 PyPI，GitHub 只有前端），
 * 所以点 Python 源时应该走第二条：**不传 base**。
 * 「用哪个源装」是 `runtime:install` 阶段的事（那时才用 indexUrl 给 pip 传 `-i`）。
 *
 * 换句话说：**列版本**用 PyPI 元数据，**装**用用户选的 Python 源 ——
 * 这正好对应 python-source.ts 里 METADATA_SOURCE 的设计意图。
 */
/**
 * 缺 Python 时的引导弹窗状态。
 *
 * 主人 2026-10-08：
 *   「当没有安装 python 的时候，点击下载 astrbot 的源的下载的时候，
 *     应该弹窗提示先安装 Python，当 python 安装好之后再点击下载
 *     才是跳转到下载列表」
 *
 * ## 为什么必须在"点源上的下载"这一层拦
 *
 * 原来的行为：点源的「下载」→ 进入版本列表（正常）→ 点某个版本的「下载」
 * → 后端报「还没装内置 Python——先去「下载」页装好 Python 再下载 AstrBot」。
 *
 * 三个问题：
 *   1. **白跑一趟**：用户已经进到列表、挑好版本了，才被告知前置条件不满足 ——
 *      而这些步骤本该在进列表之前就知道
 *   2. **报错位置离原因太远**："先装 Python"这件事和"选版本"是两个阶段，
 *      把前者的错误抛在后者的操作上，用户会以为是那个版本有问题
 *   3. **没法直接解决**：提示说"去下载页装 Python"，可用户**已经在**下载页了，
 *      却还得自己找到那个小小的「安装」按钮
 *
 * 所以现在：点下载时先看 Python。缺 → 弹窗，按钮直达安装；有了才进列表。
 *
 * ## 为什么 AstrBot 需要而 NapCat 不需要
 *
 * NapCat 自带 Node 运行时（它的产物是打包好的 Node 程序），
 * 而 AstrBot 是 Python 包，必须用内置 Python 的 pip 装进运行时目录。
 */
const needPython = ref<{ label: string; indexUrl: string; type: 'a' | 'n' } | null>(null)

/** 判断内置 Python 是否就绪（未加载完时当作"未知"，不拦） */
function pythonReady(): boolean {
  return py.value?.ready === true
}

function openPickByBase(type: 'a' | 'n', indexUrl: string): void {
  /*
   * ══════════════════════════════════════════════════════════════════════════
   * ★ base 与 indexUrl 的分工（主人 2026-09-27 严格验证后理清）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 这个源要同时喂给**两个完全不同**的地方，之前混用一个字段，于是出问题：
   *
   *   · **列版本**（versions:list 的 base）
   *       AstrBot 的版本来自 PyPI 元数据，**绝不能**把 pip 索引地址
   *       当 base 传过去 —— 后端会去请求
   *       `https://pypi.org/simple/versions.json`（不存在）→ 列表空白
   *       → 用户看到"点下载没反应"。所以这里传**空 base**。
   *
   *   · **装**（runtime:install 的 base）
   *       必须带上用户点的那个源，否则 pip 用的是配置里的首选源 ——
   *       也就是"点哪个源都一样"，实测确认过这个 bug。
   *
   * 所以：`base` 留空（管列版本），`indexUrl` 带上（管安装）。
   * 后端按 indexUrl 在 Python 源表里查出对应的源给 pip。
   */
  /*
   * 标题必须是**用户点的那个源的名字**。
   *
   * 第一版这里写死了 'Python 源' —— 于是点「腾讯源」进去，
   * 弹窗标题还写着"Python 源"，用户根本不知道自己点的是哪个
   *（主人 2026-09-27 实测：「我点腾讯源还是写的 Python 源」）。
   *
   * 这与"点哪个源就用哪个源"是同一个要求的两面：
   * **界面上显示的、用户点的、实际会用的，三者必须一致。**
   */
  const src = pySources.value.sources.find((s) => s.indexUrl === indexUrl)
  /*
   * ★ Python 前置检查（主人 2026-10-08）
   *
   * 缺 Python 时**不进版本列表**，改为弹窗引导安装 ——
   * 详见 needPython 的说明。检查放在这里（拿到 label 之后、openPick 之前），
   * 这样弹窗里能显示用户点的是哪个源。
   *
   * 只在 py.value 明确为"没装"时才拦：py 还没加载完（null）时放行 ——
   * 宁可让用户进列表后拿到后端的明确报错，也不要因为界面尚未就绪
   * 而误拦一个其实已经装好 Python 的用户。
   */
  if (type === 'a' && py.value && !pythonReady()) {
    needPython.value = { label: src?.label ?? 'Python 源', indexUrl, type }
    return
  }
  const fake: Mirror = {
    label: src?.label ?? 'Python 源',
    base: '',
    mode: 'files',
    builtin: true,
    indexUrl
  } as Mirror
  openPick(fake, type)
}
const installedA = computed(() => runtimes.value.filter((r) => r.type === 'a'))
const installedN = computed(() => runtimes.value.filter((r) => r.type === 'n'))
const selectedResource = ref<'a' | 'n'>('a')
const resourcePage = ref(1)
const resourcePageSize = 5
const selectedInstalled = computed(() => selectedResource.value === 'a' ? installedA.value : installedN.value)
const resourcePageCount = computed(() => Math.max(1, Math.ceil(selectedInstalled.value.length / resourcePageSize)))
const visibleInstalled = computed(() => {
  const start = (resourcePage.value - 1) * resourcePageSize
  return selectedInstalled.value.slice(start, start + resourcePageSize)
})
const resourcePlaceholders = computed(() => Math.max(0, resourcePageSize - visibleInstalled.value.length))
function selectResource(type: 'a' | 'n'): void {
  selectedResource.value = type
  resourcePage.value = 1
}
function changeResourcePage(next: number): void {
  resourcePage.value = Math.min(Math.max(1, next), resourcePageCount.value)
}

interface EnvironmentInfo {
  os: string
  cpu: string
  gpu: string
  memory: string
  memoryUsed: string
  memoryFree: string
  python: string
  qq: string
}
const environment = ref<EnvironmentInfo | null>(null)
const environmentLoading = ref(false)
let environmentTimer: ReturnType<typeof setInterval> | undefined

function mb(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${Math.round(value)} MB`
}

function cleanCpu(raw: string): string {
  return raw.replace(/\(R\)|\(TM\)|CPU|Processor/gi, '').replace(/\s{2,}/g, ' ').trim() || '未检测到'
}

function cleanGpu(raw: string): string {
  const value = raw.replace(/^ANGLE\s*\((?:有线|[^,]+,\s*)?/i, '').replace(/\)$/, '')
  return value.split(/\s+Direct3D|\s+OpenGL|\s+Metal|\s+Vulkan|\s+vs_|\s+ps_/i)[0].replace(/\s+\([^)]*\)$/, '').trim() || '未检测到'
}

function formatWindows(raw: string): string {
  const build = Number(raw.match(/\d+$/)?.[0] ?? 0)
  if (build >= 26200) return `Windows 11 · 25H2（Build ${build}）`
  if (build >= 26100) return `Windows 11 · 24H2（Build ${build}）`
  if (build >= 22000) return `Windows 11（Build ${build}）`
  if (build >= 10240) return `Windows 10（Build ${build}）`
  return raw || 'Windows'
}

function detectGpu(): string {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
    if (!gl) return '未检测到'
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    return cleanGpu(ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)))
  } catch {
    return '未检测到'
  }
}

async function refreshEnvironment(): Promise<void> {
  await Promise.all([loadEnvironment(), checkQQ()])
  await loadEnvironment()
}

async function loadEnvironment(): Promise<void> {
  if (environmentLoading.value) return
  environmentLoading.value = true
  try {
    const overview = await api().stats?.overview?.()
    const sys = overview?.system
    const nav = navigator as Navigator & { userAgentData?: { platform?: string }; deviceMemory?: number }
    const platform = nav.userAgentData?.platform || navigator.platform || '未知系统'
    const total = sys?.totalMemMB ?? 0
    const free = sys?.freeMemMB ?? 0
    environment.value = {
      os: formatWindows(sys?.osVersion ?? 'Windows'),
      cpu: cleanCpu(sys?.cpuModel ?? '未检测到'),
      gpu: cleanGpu(sys?.gpuModel || detectGpu()),
      memory: mb(total),
      memoryUsed: mb(Math.max(0, total - free)),
      memoryFree: mb(free),
      python: py.value?.ready ? `Python ${py.value.version}` : '未安装',
      qq: qq.value?.ok
        ? `QQ ${qq.value.version ?? ''}`.trim()
        : qq.value?.installed
          ? (qq.value.version ? 'QQ 版本不符合' : 'QQ 版本读取失败')
          : '未安装 QQ'
    }
  } finally {
    environmentLoading.value = false
  }
}

/** 各源存活情况：base → 延迟（null=不通，undefined=还没测） */
const mirrorHealth = ref<Map<string, { status: string; ms: number | null; reason?: string }>>(new Map())
const testing = ref(false)

/**
 * QQ 环境状态。
 *
 * NapCat 是注入已安装的 QQ 运行的，所以没装 QQ 或版本太老都跑不起来。
 * 这个检测放在镜像源这里：首次进页面自动测一次（让用户早点知道），
 * 之后只在用户点「检测」时才测——不反复骚扰，也省掉每次进页面都查注册表。
 */
interface QQStatus {
  ok: boolean
  installed: boolean
  version?: string
  build?: number
  minBuild: number
  reason?: string
}
const qq = ref<QQStatus | null>((() => {
  try {
    const raw = sessionStorage.getItem('astriax.qq-status')
    return raw ? JSON.parse(raw) as QQStatus : null
  } catch {
    return null
  }
})())
const qqBusy = ref(false)
const QQ_CACHE_KEY = 'astriax.qq-status'
/** 本次会话是否已经自动检测过（首次进入自动，之后仅手动） */
let qqAutoChecked = false

// 与 App.vue 里同一份声明（各 SFC 的类型互不共享，各自声明）
declare global {
  interface Window {
    launcher?: {
      app?: {
        qqStatus?: () => Promise<QQStatus>
        openExternal?: (url: string) => Promise<void>
      }
    }
  }
}

async function checkQQ(): Promise<void> {
  qqBusy.value = true
  try {
    const st = (await window.launcher?.app?.qqStatus?.()) as QQStatus | undefined
    if (st) {
      qq.value = st
      if (st.ok) {
        try { sessionStorage.setItem(QQ_CACHE_KEY, JSON.stringify(st)) } catch { /* 存储不可用时照常显示本次结果 */ }
      }
      void loadEnvironment()
    }
  } catch (e) {
    /*
     * 检测失败**要说出来**，不能像原来那样静默吞掉。
     *
     * 原来这里是空 catch：一旦 qqStatus 抛错（或通道没接上），
     * qq 永远是 null，界面就永远停在「还没检测」——
     * 用户点多少次「检测」都没反应，也完全不知道是出错了。
     * 这正是用户看到「点右边『检测』…」那句文案的原因：
     * 文案本身该删，但底下藏着的是「检测一直失败」这个真问题。
     *
     * 用一个明确的结果代替 null，让界面可以显示「检测失败」而不是「还没检测」。
     */
    qq.value = {
      ok: false,
      installed: false,
      reason: `检测失败：${e instanceof Error ? e.message : String(e)}`
    }
  } finally {
    qqBusy.value = false
  }
}

/** 首次进页面自动检测一次 */
async function autoCheckQQOnce(): Promise<void> {
  if (qqAutoChecked) return
  qqAutoChecked = true
  await checkQQ()
}

function openQQDownload(): void {
  void window.launcher?.app?.openExternal?.(QQ_DOWNLOAD_URL)
}

/**
 * 项目主页（主人 2026-10-08 要求放在资源页左侧）。
 *
 * 与 `publish-urls.ts` 里的 GITHUB_WEB_URL 是同一个地址 —— 渲染层
 * 不 import 主进程模块（会打进渲染包、且跨进程边界），所以这里写常量。
 * 换仓库时两处都要改（搜索 GITHUB_WEB_URL 能找到另一处）。
 */
const GITHUB_REPO_URL = 'https://github.com/Huan-Yan123/AstriaX'

/**
 * 官方群号 —— 与 `SettingsPanel.vue` 的 `OFFICIAL_GROUP` 必须同号。
 *
 * 渲染层没有共享常量的地方，所以这个值在两处各写了一遍。
 * 用户照着其中一处加不进去，就是这里漂了 —— 搜索 `1077554004` 能定位全部。
 *
 * 为什么反馈渠道是群而不是私聊 QQ / GitHub Issues（主人 2026-10-08 定的）：
 *   · GitHub：目标用户是 QQ 机器人玩家，让他们注册账号、写英文标题、
 *     贴日志文件，绝大多数人不会做，反馈就直接消失了
 *   · 私聊：很多人不愿意私聊陌生人；群里问一句压力小得多，
 *     而且别人可能已经遇到过同样的问题
 */
const OFFICIAL_GROUP = '1077554004'

function openGithub(): void {
  void window.launcher?.app?.openExternal?.(GITHUB_REPO_URL)
}

async function probeMirrors(): Promise<void> {
  testing.value = true
  try {
    const rows = (await api().mirrors?.test?.()) ?? []
    const m = new Map<string, { status: string; ms: number | null; reason?: string }>()
    for (const r of rows) m.set(r.base, { status: r.status, ms: r.ms, reason: r.reason })
    mirrorHealth.value = m
    /*
     * 记下"刚探测过"的时刻 —— 进页面自动探测的 60s 节流就靠它
     *（dlProbeBlocked 读它）。不记的话每次进页面都重新打全部源，
     * 那就是主人抱怨的"每次点进去都要等"。
     */
    dlMarkProbed()
    /*
     * ★ 还要把**探测结果本身**写回快照（审计抓出的真问题）。
     *
     * 只记时刻是不够的：reload 总在探测之前跑，所以快照里的 health
     * 永远是空的。用户切走再回来（节流生效、不重测）→ 水合拿到空 health
     * → 那些"120ms / 可用"「N 个源不可用」整块消失，看着像功能时有时无。
     */
    dlSaveHealth([...m.entries()].map(([base, v]) => ({ base, ...v })))
    await autoPickFastest()
  } catch {
    /* 探测失败就当没测过，不打扰用户 */
  } finally {
    testing.value = false
  }
}

/**
 * 探测完自动把最快（延迟最低）的可用源设为 **NapCat** 的首选。
 *
 * 注意「可用」的判据是 status === 'ok'，也就是**源上真的有版本清单**。
 * 只判断延迟是不够的：一个连得上但没文件的源延迟可能很低，
 * 选它当首选就会让下载直接扑空。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 只设 NapCat 的（`n`）—— **不再设 AstrBot 的（`a`）**
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 主人 2026-09-26：「把 astrbot 从 GitHub 源剥离，单独做一个 python 源」
 *                +「github 源只有 napcat」。
 *
 * 这些候选源全是 **GitHub 代理**（gh-proxy.com / cors.isteed.cc 等），
 * 它们只对 NapCat 的 release 资产有意义。AstrBot 的后端**只在 PyPI**，
 * 把 `pref.a` 设成某个 GitHub 代理 base 对它是**无意义且误导**的：
 *   · 界面上 AstrBot 那栏会显示"用的某个 GitHub 源"，而 pip 实际走 PyPI
 *   · 下一个人读 `mirrors.json` 会以为 AstrBot 真的在用这个源
 *
 * 所以这里只写 `n`。AstrBot 的源由「Python 源」那一套独立管理
 *（`python-sources.json` + `resolvePythonSource`），与 GitHub 代理完全无关。
 */
async function autoPickFastest(): Promise<void> {
  const alive = mirrors.value
    .map((m) => ({ base: m.base, info: mirrorHealth.value.get(m.base) }))
    .filter((x): x is { base: string; info: { status: string; ms: number | null } } => {
      return x.info?.status === 'ok' && typeof x.info.ms === 'number'
    })
    .sort((a, b) => (a.info.ms ?? 0) - (b.info.ms ?? 0))
  if (!alive.length) return
  const best = alive[0].base
  // 和当前一致就别多跑一次 IPC
  if (state.value?.pref.n === best) return
  try {
    state.value = (await api().mirrors?.pref?.({ n: best })) ?? state.value
  } catch {
    /* 设不上就维持原样，下载时仍会按顺序试 */
  }
}

/**
 * ★ 源是否**明确不可用** —— 下载按钮的上锁判据（主人 2026-10-08）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 主人原话：「修复下载按钮不会根据源是否可用而自动上锁和解锁」
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 原来的缺陷（三处，读源码确认）
 *
 *   ① **NapCat 那一行根本没有 disabled** ——
 *      连不上的 GitHub 源，按钮照样能点，点进去是个空列表。
 *      用户白跑一趟，还分不清是源坏了还是软件坏了。  ← 这是主缺陷
 *   ② 两个探测器的**状态枚举不一致**：GitHub 源是 `ok|empty|unreachable`
 *      三档，Python 源当时只有 `ok|unreachable` 两档（"空页面"被归进
 *      unreachable）。于是判据没法统一写，只能各写一套 —— 迟早漏。
 *      本次把 Python 侧也补成三档（见 python-source-test.ts），
 *      两边的语义这才真正对齐。
 *   ③ AstrBot 那行的判据写死了 `=== 'unreachable'`，与 `deadMirrors`
 *      用的 `status !== 'ok'` **不是同一个式子** —— 枚举一变就会漏。
 *
 * ## 现在的判据（与 `deadMirrors` 统一）
 *
 *     health 存在 且 status !== 'ok'  →  不可用（上锁）
 *
 * 这一个式子同时覆盖 unreachable 与 empty，而项目里"哪些源可以清理"
 * 用的就是同一口径 —— 两处一致，以后加状态也不用改两个地方。
 *
 * ## 为什么要带 `reason`（见下面的 downHint）
 *
 * 只上锁、不说原因，用户其实陷入**更糟**的状态：改之前他点一下至少
 * 能看到"这源是空的"，改之后只有一个灰按钮，只能反复点"重新检测"，
 * 而源确实空、重试无解。所以锁上的同时必须把原因告诉他。
 *
 * ## 为什么"没探测过"（undefined）**不锁**
 *
 * 探测是异步的，要几百毫秒到几秒。若把"还没测"当成不可用，
 * 用户进页面第一眼看到的是一排灰按钮 —— 那比"能点、下载时按顺序
 * 回落试探"更糟（而且主进程的下载本来就会自动换源重试）。
 * 所以：**只有明确探测到不可用才锁**。
 */
function isSourceDown(
  h: { status: string } | undefined
): boolean {
  return h !== undefined && h.status !== 'ok'
}

/**
 * 下载按钮的悬浮提示 —— **把"为什么是灰的"说清楚**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 为什么必须有这个（独立复核抓出的缺口）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 上锁之后如果只说"不可用"，用户其实陷入了**更糟的状态**：
 *
 *   · 改之前：按钮能点 → 点进去看到空列表 → 至少知道"这个源没东西"
 *   · 改之后：按钮是灰的、徽章只写"不可用"、**没有原因、也没法操作**
 *     → 用户只能反复点「检测所有来源」，而源确实是空的，重试无解
 *
 * 主进程的探测**已经生成了人话原因**（"源上没有文件"、"超时（8 秒内
 * 没响应…可以再点一次「重新检测」）"、"HTTP 403（被拒绝，可能需要换源）"），
 * `python-source-test.ts` 里还专门注释说"可直接展示" ——
 * 但模板从来没渲染过 `reason`。这里把它接出来。
 *
 * 用 `reason` 而不是自己按 status 拼文案：原因来自**真正发探测的那一层**，
 * 它知道是超时还是 403；渲染层再猜一遍必然会漂移。
 */
function downHint(h: { status: string; ms?: number | null; reason?: string } | undefined, verb: string): string {
  if (!isSourceDown(h)) return ''
  const why = h?.reason?.trim()
  return why
    ? `这个源不可用：${why}\n换一个源，或点右上角「检测所有来源」重测`
    : `这个源检测到不可用，${verb}会失败 —— 换一个源，或点右上角「检测所有来源」重测`
}

/**
 * 不可用的自定义源：给用户一个「移除」。
 *
 * 「不可用」包括两种，**都算不可用**（这是之前判错的地方）：
 *   - unreachable：连不上/超时/HTTP 错误
 *   - empty：连得上，但源上根本没有版本清单（啥也下不到）
 * 内置官方源永远留着（hideBase，用户加不了）。
 */
const deadMirrors = computed(() =>
  mirrors.value.filter((m) => {
    if (m.builtin) return false
    return isSourceDown(mirrorHealth.value.get(m.base))
  })
)

async function removeAllDead(): Promise<void> {
  for (const m of deadMirrors.value) {
    try {
      state.value = (await api().mirrors?.remove?.(m.base)) ?? state.value
    } catch {
      /* 单个删不掉就跳过 */
    }
  }
  await probeMirrors()
}

/** 已装版本集合：`${type}|${tag}`，用于把「下载」按钮变成「已安装」 */
const installedKeys = computed(() => new Set(runtimes.value.map((r) => `${r.type}|${r.tag}`)))

function isInstalled(tag: string): boolean {
  return installedKeys.value.has(`${pickType.value}|${tag}`)
}
function displayBase(m: Mirror): string {
  return m.hideBase ? '官方源' : m.base || 'github.com'
}

async function reload(): Promise<void> {
  /*
   * ★ 三路**并行** + 请求 ID + 写 SWR（指导书 1.3(7) + 2.2 的交汇）
   *
   * 原来是三串 `await`：状态 → 已装 → python。最慢一个决定总时长；
   * 用户挂起此页的 1 秒里再别的路径进来，旧回来的数据还会盖住新的。
   *
   *   · 并行：总时长 = 最慢一路，不再相加
   *   · loadId：进页/刷新各领新 id；比当前 id 旧的本子直接丢弃
   *   · dlSave：拉成的新数据整包写回缓存 —— 下一次进入页面秒开
   */
  const my = dlNextLoadId()
  const [st, rows, pySt] = await Promise.allSettled([
    api().mirrors?.state?.(),
    api().runtimes?.list?.(),
    api().python?.status?.()
  ])
  if (!dlIsCurrentLoad(my)) return /* ← 已切走：老回包不落地 */

  if (st.status === 'fulfilled') state.value = (st.value ?? null) as never
  if (rows.status === 'fulfilled') runtimes.value = (rows.value ?? []) as never
  if (pySt.status === 'fulfilled') py.value = (pySt.value ?? null) as never
  for (const f of [st, rows, pySt]) {
    if (f.status === 'rejected') {
      /* 单路失败：如实报，但别让其它两路的好数据一起作废 */
      err.value = `读列表失败：${String(f.reason instanceof Error ? f.reason.message : f.reason)}`
      break
    }
  }

  /*
   * 写缓存（把 mirrorHealth 一并序列化进去 —— Map 存 plain 数组）。
   *
   * ★ 但**三路全失败时不能写**（审计抓出的"过期数据被续期"）：
   * 那种情况下 state/rows/py 保留的是水合来的旧值，dlSave 却会盖上
   * 一个新的 ts —— 于是这份旧数据在 5 分钟内被判为"新鲜"，
   * 连"展示的是上次的数据哦"都不会出现。正确做法是标记为过期（ts=0），
   * 让"这是旧数据"这件事在 UI 上如实表达。
   */
  const allFailed = [st, rows, pySt].every((f) => f.status === 'rejected')
  if (allFailed) {
    dlNoteLoadFailed()
  } else {
    dlSave({
      state: state.value,
      rows: runtimes.value as never,
      py: py.value as never,
      health: [...mirrorHealth.value.entries()].map(([base, v]) => ({ base, ...v }))
    })
  }
}

function openPick(m: Mirror, type: 'a' | 'n'): void {
  picking.value = m
  pickType.value = type
  versions.value = []
  err.value = ''
  void loadVersions()
}

/*
 * `nextPickType` 已删除（主人 2026-09-27）。
 *
 * 它原来的职责是"从某个源点进来时，猜用户想装哪一类"（缺什么就猜什么）——
 * 那是"所有源混在一起"时代的产物。现在下载页已经按类型分了两个分区，
 * **点 AstrBot 区的源就是装 AstrBot，点 NapCat 区的就是装 NapCat**，
 * 不需要任何猜测。`openPick(m, type)` 里的 type 由分区直接给。
 */

/**
 * 拉版本列表。
 *
 * 默认走主进程的磁盘缓存（用户要求：别每次打开都重新获取）。
 * `force` = 用户显式点「刷新」时用，绕过缓存走网络。
 */
async function loadVersions(force = false): Promise<void> {
  const m = picking.value
  if (!m) return
  loadingVersions.value = true
  err.value = ''
  try {
    versions.value =
      (await api().versions?.list?.({
        type: pickType.value,
        base: m.base,
        noCache: force
      })) ?? []
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loadingVersions.value = false
  }
}

/*
 * `switchPickType` 已删除（主人 2026-09-27：「napcat 源列表点下载里面有
 * astrbot，astrbot 源点下载里面有 napcat 是什么情况」）——
 * 弹窗里那个 AstrBot/NapCat 切换器撤掉了，类型由**从哪个分区点进来**决定，
 * 所以不再需要"换类型重新拉列表"这个动作。
 *
 * `pickType` 本身保留：它记着"这个弹窗是给哪一类的"，
 * 列版本与安装都要用它。
 */

async function install(v: VersionItem): Promise<void> {
  const t = pickType.value
  markBusy(t, v.tag, true)
  err.value = ''
  try {
    /*
     * ★ 把"用户点的那个源"传给主进程（主人 2026-09-27 严格验证出的 bug）
     *
     * 传的是 `picking.indexUrl ?? picking.base`：
     *   · Python 源 → `indexUrl` 是 pip 索引地址（base 刻意留空给列版本用）
     *   · GitHub/官方源 → `indexUrl` 不存在，用 `base`
     *
     * 主进程拿到后会：Python 走 pip 的 `-i`（**用这个源装**），
     * 其它类型走下载源选择。
     *
     * 改之前这里只传 `base`，而 Python 源的 base 是空串 →
     * 后端只好去读"配置里的首选源"→ **点哪个源都一样**（实测确认）。
     */
    await api().runtime?.install?.({
      type: t,
      tag: v.tag,
      base: picking.value?.indexUrl ?? picking.value?.base
    })
    await reload()
    await loadVersions()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    markBusy(t, v.tag, false)
  }
}

async function installPython(): Promise<void> {
  pyBusy.value = true
  err.value = ''
  try {
    py.value = (await api().python?.install?.()) ?? py.value
    /*
     * ★ 写操作后主动失效（审计：这条原则原来只覆盖了"删除版本"）
     *
     * Python 装完只更新了组件里的 py.value，快照仍是 ready:false。
     * 用户在安装途中离开下载页（装上要几十秒），回来时 SWR 会先把
     * 「未安装 + 安装按钮」画出来 —— 正是主人抱怨的"py 装没装看不出来"。
     *
     * 用 keepProbe：装 Python 不影响"哪些镜像源可用"，
     * 没必要因此重打一遍所有源（那会打穿 60s 节流）。
     * 失效后由下面的 reload 把新状态写回快照。
     */
    dlInvalidate({ keepProbe: true })
    await reload()
    /*
     * ★ 还要刷新**环境格**（主人 2026-10-08 实测：装完 Python 环境区仍显示"未安装"）。
     *
     * 原因：`environment.python` 是 `loadEnvironment()` 里根据 `py.value`
     * 算出来的一个**快照字符串**。`reload()` 更新的是 `py`，但不会重算
     * environment —— 于是环境格停在旧值，看起来像"装了没生效"。
     * 而 `loadEnvironment` 自己会读最新的 py，调一次就同步了。
     */
    await loadEnvironment()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    pyBusy.value = false
  }
}

/**
 * 引导弹窗里的「安装 Python」。
 *
 * 装成功之后**自动继续**进用户原本想去的那个源的版本列表 ——
 * 这才是"点下载"的完整意图。否则用户装完还要再点一次下载，
 * 而我们明明已经知道他要装 AstrBot。
 *
 * 装完不自动进列表的情况：安装失败，或 py 状态没变成 ready
 *（不能凭"调用没抛错"就当作装好了，那会跳到一个装不了东西的列表）。
 */
async function installPythonFromDialog(): Promise<void> {
  const pending = needPython.value
  await installPython()
  if (!pending) return
  if (!pythonReady()) return
  needPython.value = null
  openPickByBase(pending.type, pending.indexUrl)
}

const delTarget = ref<{ type: 'a' | 'n'; tag: string } | null>(null)

/*
 * 点了「删除」时，先算出有哪些实例还在用这个版本，写进确认弹窗里。
 *
 * 为什么要在**删之前**算：删除本身现在允许执行（用户明确要求「改成可以删」），
 * 所以唯一的保护手段就是让用户看清后果再确认 —— 弹窗里必须写明白
 * 「这几个实例下次启动会失败」，而不是含糊地说「不受影响」。
 *
 * 属性名注意：实例接口返回的是 runtimeTag（运行时版本）。
 */
/*
 * 删版本时提示「谁在用」。
 *
 * 踩过的坑：这里原来是 `i.runtimeTag === t.tag`，而 instance:list 返回的
 * 记录里**根本没有 runtimeTag 字段**（真实绑定在 <实例目录>\instance.json），
 * 于是 filter 恒为空 —— 确认框永远显示「没有实例在使用这个版本」，
 * 用户就会放心删掉一个正在被使用的运行时。
 *
 * 现在主进程在 instance:list 里把 runtimeTag 一并带出来了（见 ipc.ts），
 * 所以这个判断才是真的有效。**别把那段补字段的代码删掉**，
 * 否则这里会静默退化成"永远为空"。
 */
const instancesOfType = ref<
  Array<{ id: string; name: string; type: 'a' | 'n'; runtimeTag?: string; status?: string }>
>([])

const delUsedBy = computed(() => {
  const t = delTarget.value
  if (!t) return []
  return instancesOfType.value
    .filter((i) => i.type === t.type && i.runtimeTag === t.tag)
    .map((i) => i.name)
})

/**
 * 正在**运行**、且用的是这个版本的实例。
 *
 * 和主进程 runtimes:remove 的判据对齐（那边用 liveStatusOf 得到的 status）。
 * 有它在就禁用删除按钮 —— 让用户在**点之前**就知道点不动、以及为什么，
 * 而不是点完弹一句报错。
 *
 * 为什么单独列出来：仅仅「被引用」和「正在跑」的后果完全不同 ——
 * 前者下次启动失败（可恢复），后者会把它正在执行的代码抽走（当场半死）。
 * 用户报告里那个「删完 AstrBot 就版本未知」正是后者。
 */
const delRunning = computed(() => {
  const t = delTarget.value
  if (!t) return []
  return instancesOfType.value
    .filter((i) => i.type === t.type && i.runtimeTag === t.tag && i.status === 'running')
    .map((i) => i.name)
})

async function askRemove(type: 'a' | 'n', tag: string): Promise<void> {
  // 每次弹确认前刷一遍实例列表，避免拿旧数据吓人或漏报
  try {
    instancesOfType.value = (await api().instance?.list?.()) ?? []
  } catch {
    instancesOfType.value = []
  }
  // 上一次删除留下的提示不该跟着这一次显示
  note.value = ''
  delTarget.value = { type, tag }
}

async function doRemove(): Promise<void> {
  const t = delTarget.value
  if (!t) return
  err.value = ''
  try {
    const r = await api().runtimes?.remove?.({ type: t.type, tag: t.tag })
    delTarget.value = null
    /*
     * ★ 写操作成功 → 主动失效缓存（指导书 2.3 明列的一条）
     *
     * 不失效的话：删掉 v4.18.19 之后立刻切走再回来，SWR 会先把
     * **缓存里那个已被删掉的版本**画出来（然后后台刷新再抹掉）——
     * 用户会看到"删了又回来"的假象，比空白更让人困惑。
     * 失效之后再进页就是全新拉取（主进程那边的磁盘缓存是另一层，不受影响）。
     */
    dlInvalidate()
    /*
     * 版本记录损坏的实例要单独提示。
     *
     * instance.json 读不出来的实例，我们**无法确认**它有没有用这个版本
     * （详见 ipc.ts 里 tagOf 的注释）。删除是放行了，但它下次启动可能
     * 直接失败 —— 用户必须在**这一刻**被告知，否则他会在几天后突然
     * 遇到「运行时结构不对」，完全联想不到是这里删掉的。
     *
     * 提示里给出修法（重新选一次版本会重写记录），而不是只说"坏了"。
     */
    const unknown = (r as { unknownBinding?: string[] } | void)?.unknownBinding ?? []
    if (unknown.length) {
      note.value =
        `已经删掉 ${t.tag} 啦。注意哦：${unknown.join('、')} 的版本记录已经损坏，` +
        `没法确认它到底有没有在用这个版本呢 —— 请在实例卡片上重新选一次版本，` +
        `不然它下次启动可能会失败哦。`
    } else {
      note.value = ''
    }
    await reload()
    if (picking.value) await loadVersions()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
    delTarget.value = null
  }
}

/* ---------------- 手动导入 ---------------- */

const impFile = ref('')
const impBusy = ref(false)
const impErr = ref('')
const impMsg = ref('')
const impVersion = ref('')
const impProbe = ref<{
  kind: 'a' | 'n' | null
  version: string
  reason: string
  sizeMB: number
  sha256: string
  sample: string[]
} | null>(null)

/** 当前页面在哪个类型（AstrBot / NapCat），导入时用它判断包类型对不对 */
const impType = computed<'a' | 'n'>(() => (installedN.value.length && !installedA.value.length ? 'n' : 'a'))
async function pickImport(): Promise<void> {
  impErr.value = ''
  impMsg.value = ''
  impProbe.value = null
  try {
    const file = (await api().runtimes?.pickFile?.()) as string | null | undefined
    if (!file) return // 用户取消了
    impFile.value = file
    impBusy.value = true
    const p = (await api().runtimes?.probeFile?.(file)) as typeof impProbe.value
    impProbe.value = p ?? null
    // 能识别就先把版本号填上，用户少打一次字
    if (p?.version) impVersion.value = p.version
  } catch (e) {
    impErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    impBusy.value = false
  }
}

async function doImport(): Promise<void> {
  if (!impFile.value) return
  impErr.value = ''
  impMsg.value = ''
  impBusy.value = true
  try {
    const r = (await api().runtimes?.importFile?.({
      type: impProbe.value?.kind ?? impType.value,
      file: impFile.value,
      version: impVersion.value
    })) as { tag?: string; depsOk?: boolean } | undefined
    /*
     * ★ 依赖没装上必须**明确告警**，不能只说"装好啦"（审查抓出的闭环）
     *
     * AstrBot 的 wheel 只含它自己，依赖（click/quart/aiohttp…）要靠 pip 装。
     * 若 pip 失败（网络/内置 Python 没装），那个运行时**启动必崩** ——
     * 而第一版这里只显示"装好啦 v4.28.0"，用户以为成功了，
     * 去启动实例才发现报错，且回来重试会撞"已经有一个 vX 了"。
     *
     * 现在：depsOk === false 时说清"装了一半 + 怎么办"，
     * 而不是给一个会误导的成功提示。
     */
    if (r?.depsOk === false) {
      /*
       * ★ 去掉 Markdown 星号 + 精简（主人 2026-09-27 实测反馈）
       *
       * 原来写的是：
       *     导入完成，但**依赖没装上**（这个版本启动会失败）。
       *     常见原因：内置 Python 还没装，或网络连不上 Python 源。
       *     先去「必要运行组件」把 Python 装好、确认能连上源，然后**再导入一次
       *     同一个文件**即可覆盖重装。
       *
       * 两个问题：
       *   ① 这段文字走的是**纯文本插值**（模板里 `{{ impErr }}`），
       *      不渲染 Markdown —— 于是 `**` 原样显示成星号，看着像乱码
       *   ② 三句太长，像在读说明书
       *
       * 现在压成两句：**先说后果，再说怎么办**。
       * "常见原因"那句删掉 —— 用户不需要知道可能是什么原因，
       * 他需要知道"我现在该干什么"。
       */
      impErr.value =
        `导入完成，但依赖没装上，这个版本启动会失败。\n` +
        `把「必要运行组件」里的 Python 装好，再导入一次这个文件就行。`
      impMsg.value = ''
    } else {
      impMsg.value = `装好啦 ${r?.tag ?? impVersion.value}~`
    }
    impProbe.value = null
    impFile.value = ''
    impVersion.value = ''
    await reload()
  } catch (e) {
    impErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    impBusy.value = false
  }
}

async function addMirror(): Promise<void> {
  err.value = ''
  if (!newBase.value.trim()) {
    err.value = '得先填镜像地址哦'
    return
  }
  try {
    state.value = (await api().mirrors?.add?.({
      label: newLabel.value.trim() || newBase.value.trim(),
      base: newBase.value.trim(),
      mode: newMode.value
    })) ?? state.value
    newLabel.value = ''
    newBase.value = ''
    showAdd.value = false
    /*
     * 加了源 → 快照失效（审计：这条原则原来只覆盖删除版本）。
     * 保留探测结果：新加的源在列表里但还没测过，用户切走再进来时
     * 旧源的可用性标签仍然有效，不该整块消失。
     */
    dlInvalidate({ keepProbe: true })
    await reload()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

async function removeMirror(base: string): Promise<void> {
  err.value = ''
  try {
    state.value = (await api().mirrors?.remove?.(base)) ?? state.value
    /* 删了源 → 失效（并清掉这个源的探测结果，它已经不在列表里了） */
    const next = new Map(mirrorHealth.value)
    next.delete(base)
    mirrorHealth.value = next
    dlInvalidate({ keepProbe: true })
    dlSaveHealth([...next.entries()].map(([b, v]) => ({ base: b, ...v })))
    await reload()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

let offProgress: (() => void) | undefined

/*
 * ★ SWR 第 1 步：缓存命中就**先画上**（指导书 2.2 的核心）
 *
 * ## 为什么必须在 setup 顶层，而不是 onMounted（这里踩过一次）
 *
 * 我第一版把这段放进 onMounted —— 而 onMounted 是**首次渲染之后**才跑的，
 * 于是第一帧仍然是空白（要等一次 Vue tick 才补上）。主人要的是
 * 「点进去立即看到上次的内容」，那必须是**首次渲染就带着数据**。
 * 放在 setup 里（组件实例化阶段）才能做到真正的同步可见。
 *
 * 测试抓到的：`tests/ui/dl-cache.spec.ts` 里"mount 后同步查 DOM"
 * 那条一开始是红的，就是因为它测出了这个先后顺序。
 *
 * 未命中缓存时什么也不做：页面先渲染骨架（空列表），随后 reload 填。
 */
const cachedSnap = dlHydrate()
if (cachedSnap) {
  state.value = cachedSnap.state
  runtimes.value = cachedSnap.rows as never
  py.value = cachedSnap.py as never
  mirrorHealth.value = new Map(
    cachedSnap.health.map((h) => [h.base, { status: h.status, ms: h.ms, reason: h.reason }])
  )
  /*
   * 新鲜度提示：过期也先用（SWR 的本意），但要如实说明"这是上次的" ——
   * 用 dlHydrateFresh 判断是否在 TTL 内，而不是自己再算一遍时间
   *（TTL 口径只有一处实现，避免两处漂移）。
   */
  if (!dlHydrateFresh()) {
    note.value = '展示的是上次的数据哦，最新的正在后台加载~'
  }
}

onMounted(async () => {
  /*
   * ★ 订阅进度必须在**可能失败的 await 之前**（UI 审计抓出的真问题）
   *
   * 原来写的是：
   *     await reload()                       ← 三个裸 await，没 try/catch
   *     offProgress = api().onDownloadProgress?.(...)
   *
   * `reload()` 内部是一串 IPC 调用。只要其中**任何一个** reject，
   * 这个 async 函数就在那里中断，后面的订阅**永远不会执行** ——
   * 于是整个会话里进度条都不出现，而且不给任何错误提示。
   * 用户的观感是"点了下载，界面一动不动，像卡死了"。
   *
   * 修法有两层：
   *   1. **先订阅**，再做会失败的数据加载 —— 订阅是一次性的、
   *      没有前置条件，不该排在一个可能抛错的调用后面
   *   2. `reload()` 包 try/catch，失败也要让用户知道（否则
   *      界面就是"空的"，用户不知道是没数据还是出错了）
   *
   * 顺序还有一个好处：加载数据期间如果已经有下载在跑，
   * 进度事件也不会漏掉。
   */
  offProgress = api().onDownloadProgress?.((p) => setProgress(p))

  /*
   * ══════════════════════════════════════════════════════════════════════════
   * ★★ 恢复**已经在跑**的下载进度（主人 2026-09-27 实测的真问题）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 他的原话：
   *   「我从下载页切换到其他页面再回来，顶部的下载进度就消失了，
   *     直到更新进度才重新显示更新了进度的那个，没更新进度的就一直不显示」
   *
   * 原因：`progressMap` 是**这个组件的 ref** —— 切走页面 = 组件卸载 =
   * 进度全丢。切回来时新组件是空的，只有**之后**新发生的事件才会显示东西。
   * 于是"装到一半切走再回来"看到空白（或只剩某个还在推进的任务），
   * 用户完全不知道那个安装还在不在跑。
   *
   * 修法：主进程维护了任务快照（`liveDownloads`），这里挂载时问一次、
   * 把进度条**原样恢复**。
   *
   * 为什么放在订阅**之后**：中间那个 await 期间可能来新事件，
   * 先订阅才不会漏；而恢复的旧快照会被新事件自然覆盖（都是 setProgress）。
   */
  try {
    const sessions = (await api().downloadSessions?.()) ?? []
    for (const s of sessions) setProgress(s)
  } catch {
    /* 拿不到快照就算了：进度条空着不影响下载本身 */
  }

  try {
    await reload()
  } catch (e) {
    err.value = `读取列表失败：${e instanceof Error ? e.message : String(e)}`
  }

  /*
   * 探测节流（60s）：进页面自动测过一次后，短时间内反复进出不再
   * 重打全部源（那是"每次点进去都要等"观感的另一半来源）。
   * 用户点「检测」仍然随时可测 —— 节流只拦自动路径。
   */
  if (dlProbeBlocked()) {
    /* 复用上轮探测结果（hydrate 里已经铺好），不再打服务器 */
  } else {
    void probeMirrors()
  }
  // 首次进页面自动查一次 QQ（之后只在用户点「检测」时查）
  void autoCheckQQOnce()

  /*
   * ★ 加载 AstrBot 的 Python 源列表（主人 2026-09-27 的界面要求）
   *
   * 「AstrBot 下载」分区要列出 **Python 源**（PyPI 官方 / 腾讯云 / …）。
   *
   * 踩过的坑：我写好了 `loadPySources()` 与模板，却**忘了在这里调它** ——
   * 于是那个分区里**只有官方源**（那是从 mirrors 来的），
   * Python 源一个都不显示，看起来像"Python 源没用"。
   * 而这正是审查里反复出现的那类问题：**定义了、没接线**。
   * 互动测试（真的打开软件看一眼）当场就发现了。
   */
  void loadPySources()
  /* Python 源也要测通断（与 GitHub 源一样显示"可用 xxx ms"） */
  void probePySources()
 void loadEnvironment()
})
onUnmounted(() => {
  if (environmentTimer) clearInterval(environmentTimer)
  environmentTimer = undefined
  offProgress?.()
  // 延时清理的定时器也要一起取消（否则会写已卸载组件的 ref）
  cancelPendingClears()
  // stall 时钟同理：组件都卸载了还在每秒 tick 是纯浪费
  if (stallTimer) clearInterval(stallTimer)
  stallTimer = undefined
})
</script>

<template>
  <div class="download-console">
    <header class="console-head">
      <div>
        <p class="eyebrow">RUNTIME CENTER</p>
        <h1>资源与环境</h1>
        <p class="head-note">管理运行环境、版本与下载来源</p>
      </div>
      <div class="head-actions">
        <span v-if="err" class="head-alert">{{ err }}</span>
      </div>
    </header>

    <p v-if="note" class="notice">{{ note }}</p>

    <section v-if="progressList.length" class="task-strip">
      <div class="strip-label"><span class="live-dot" />正在进行</div>
      <div class="task-list">
        <div v-for="p in progressList" :key="trackKey(p)" class="task-row">
          <div class="task-name">{{ p.label ?? p.tag }}</div>
          <div class="task-state">
            <!--
              ★ 必须**始终**显示「已用 N 秒」（主人 2026-09-27 + 2026-10-08 两次强调）

              原话：「这个正在处理请稍后到底是啥，卡在这里很久，用户看见会以为
                     卡死了，你也没个进度显示什么的」

              为什么"秒数在涨"这件事如此重要：
                装 AstrBot 依赖要几分钟，期间 pip 可能有一大段没有任何输出
                （构建源码包、解压大 wheel）。这时**一个每秒都在变的数字**
                比任何"请稍候"都更能说明"它还活着"。

              我重写任务条时一度只在 `isStalled`（超过 5 秒没动静）时才显示计时，
              那等于把最需要它的正常时段也排除了 —— 回归测试 progress-stall
              与 elapsed-survives-nav 一起把这条钉了回来。
            -->
            <span v-if="isStalled(p)">{{ p.speedText || '处理中' }} · 已用 {{ elapsedSec(p) }} 秒<template v-if="elapsedSec(p) >= 120">（暂时没有新输出是正常的，pip 可能在编译依赖或等待镜像；长时间不变可取消后换源重试）</template><template v-else>（pip 正在处理依赖，没有新输出是正常的，别关软件）</template></span>
            <span v-else-if="p.phase === 'verify'">校验中 · 已用 {{ elapsedSec(p) }} 秒</span>
            <span v-else-if="p.phase === 'finish'">写入中 · 已用 {{ elapsedSec(p) }} 秒</span>
            <span v-else>{{ p.speedText || '下载中' }} · 已用 {{ elapsedSec(p) }} 秒</span>
          </div>
          <div class="task-progress"><i :style="{ width: (p.phase === 'error' ? 0 : (p.percent ?? 30)) + '%' }" /></div>
          <span class="task-percent">{{ p.percent === null ? '—' : `${Math.round(p.percent)}%` }}</span>
          <button v-if="p.phase !== 'done' && p.phase !== 'error'" class="cancelbtn" :disabled="cancelling.has(trackKey(p))" @click="cancelTask(p)">
            {{ cancelling.has(trackKey(p)) ? '取消中' : '取消' }}
          </button>
          <span v-else class="task-result" :class="p.phase">{{ p.phase === 'done' ? '完成' : '已取消/失败' }}</span>
        </div>
      </div>
    </section>

    <div class="console-grid">
      <aside class="resource-nav">
        <div class="nav-title">资源</div>
        <button class="resource-item" :class="{ active: selectedResource === 'a' }" type="button" @click="selectResource('a')">
          <span class="resource-mark astrbot-mark">A</span>
          <span><b>AstrBot</b><small>Python 运行环境</small></span>
          <strong>{{ installedA.length }}</strong>
        </button>
        <button class="resource-item" :class="{ active: selectedResource === 'n' }" type="button" @click="selectResource('n')">
          <span class="resource-mark napcat-mark">N</span>
          <span><b>NapCat</b><small>QQ 注入运行环境</small></span>
          <strong>{{ installedN.length }}</strong>
        </button>
        <div class="nav-rule" />
        <!--
          ★ 项目主页 + 求 Star（主人 2026-10-08）

          主人要求：「在资源页左侧**超链**这个 GitHub 链接…并写感谢以及
          要 Star 的文案」——所以这里是**正文里的一句超链接**，
          不是一个包着整块区域的按钮：可点的只有那串地址本身。

          为什么用 <a> 而不是 <button>：
            · 它语义上就是"去外部网页"，<a> 让悬浮手型、下划线、
              键盘可达性全都免费拿到（button 要手写一遍，还容易被漏）。
            · 点击仍然交给 `app.openExternal` —— 主进程用系统浏览器打开。
              必须 `preventDefault()`：Electron 的渲染进程里，<a> 的默认
              导航会**把启动器窗口自己**变成那个网页，用户就回不来了。
        -->
        <div class="repo-note">
          <span class="repo-head">
            <svg class="repo-star" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.4l-3.8 2 .7-4.3-3.1-3 4.3-.6z" /></svg>
            <b>AstriaX 开源</b>
          </span>
          <p>
            代码全部公开在 GitHub。感谢每一位用过它、报过问题的人 ——
            觉得好用的话，去 <a class="repo-link" :href="GITHUB_REPO_URL" title="在浏览器里打开项目主页" @click.prevent="openGithub">github.com/Huan-Yan123/AstriaX</a>
            点个 <em>Star</em> 吧，那是对这个项目最实在的支持，也能让更多需要它的人找到这里。
          </p>
        </div>

        <div class="nav-rule" />
        <!--
          ★ 问题反馈教程（主人 2026-10-08：「在下方挂一个问题反馈教程」）
          ★ 再去掉 GitHub 渠道、改用群号（主人同日晚些时候的要求）

          为什么只留群、不留 GitHub Issues：
            这个软件的用户主要是 QQ 用户（要装 NapCat 跑 QQ 机器人），
            让他们去注册 GitHub 账号、写英文标题、贴日志文件 ——
            绝大多数人不会做，反馈就直接消失了。
            群是他们已经在用的地方，门槛为零。
        -->
        <div class="feedback-guide">
          <span class="repo-head"><b>遇到问题？</b></span>
          <ol>
            <li>先去<b>设置 → 日志</b>点「导出日志」，会生成一个 zip（里面有运行环境、版本、报错原文）。</li>
            <li>再想清楚三件事：<b>做了什么</b>、<b>期望什么</b>、<b>实际看到什么</b>。</li>
            <li>带上 zip 和这三件事，加群 <em>{{ OFFICIAL_GROUP }}</em> 问 —— 群里问一句压力小，也常有人遇到过同样的问题。</li>
          </ol>
          <p class="hint">
            有日志的话，绝大多数问题能一次定位 —— 比"打不开/用不了"这种描述快很多。
          </p>
        </div>

        <div class="nav-rule" />
        <!--
          ★ 使用流程（主人 2026-10-08：从"常见问题"改成"使用流程"）

          为什么改成流程而不是 FAQ：
            左侧栏是**引导**的位置，而 FAQ 是**救火**的位置 ——
            用户遇到问题时不会回来这里翻，他会直接去群里问。
            但"我该按什么顺序做什么"是每个新用户都会问的，
            而且问一次就够。所以这里放顺序，不放症状。
        -->
        <div class="flow-guide">
          <span class="repo-head"><b>使用流程</b></span>
          <ol>
            <li>本页上方先装<b>运行环境</b>：AstrBot 需要内置 Python；NapCat 要本机有新版 QQNT。</li>
            <li>在<b>下载资源</b>里选一个可用的源，装上要用的版本（灰色按钮的源不通，换一个）。</li>
            <li>去<b>实例</b>页新建一个实例，选刚装好的版本。</li>
            <li>点<b>启动</b>，等状态变成"运行中"（NapCat 要等注入 QQ，十几秒）。</li>
            <li>点 <b>WebUI</b> 进管理面板；初始密码在实例日志里。</li>
          </ol>
        </div>
      </aside>

      <main class="resource-main">
        <section class="resource-section environment-section">
          <div class="section-head"><div><span class="section-index">02</span><h2>运行环境</h2></div><button class="tool-btn" type="button" :disabled="environmentLoading || qqBusy" @click="refreshEnvironment">{{ environmentLoading || qqBusy ? '检测中…' : '重新检测环境' }}</button></div>
          <div class="environment-grid">
            <div class="environment-cell"><span>系统</span><b>{{ environment?.os ?? '检测中…' }}</b></div>
            <div class="environment-cell"><span>处理器</span><b :title="environment?.cpu">{{ environment?.cpu ?? '检测中…' }}</b></div>
            <div class="environment-cell"><span>显卡</span><b :title="environment?.gpu">{{ environment?.gpu ?? '检测中…' }}</b></div>
            <div class="environment-cell"><span>内存</span><b>{{ environment ? `${environment.memoryUsed} / ${environment.memory}` : '检测中…' }} <small>可用 {{ environment?.memoryFree ?? '—' }}</small></b></div>
            <div class="environment-cell"><span>Python</span><b class="env-stack"><i :class="{ good: py?.ready }" />{{ environment?.python ?? '检测中…' }}</b><button v-if="!py?.ready" class="row-action primary env-action" :disabled="pyBusy" @click="installPython">{{ pyBusy ? '安装中' : '安装' }}</button></div>
            <div class="environment-cell"><span>QQ</span><b class="env-stack" :title="qq?.reason"><i :class="{ good: qq?.ok }" />{{ environment?.qq ?? '未检测' }}</b><div class="env-actions"><button v-if="qq && !qq.ok" class="row-action primary env-action" @click="openQQDownload">下载 QQ</button></div></div>
          </div>
        </section>

        <section class="resource-section">
          <div class="section-head"><div><span class="section-index">01</span><h2>安装版本</h2></div>
          </div>
          <div class="version-table">
            <div class="table-head"><span>产品</span><span>版本</span><span>来源</span><span>大小</span><span /></div>
            <div v-for="r in visibleInstalled" :key="`${selectedResource}-${r.tag}`" class="version-row">
              <span class="product-label"><i :class="selectedResource === 'a' ? 'astrbot-dot' : 'napcat-dot'" />{{ selectedResource === 'a' ? 'AstrBot' : 'NapCat' }}</span>
              <b>{{ r.tag }}</b><span>{{ r.from || '—' }}</span><span>{{ r.sizeMB ? `${r.sizeMB} MB` : '—' }}</span>
              <button class="row-action danger" type="button" @click="askRemove(selectedResource, r.tag)">删除</button>
            </div>
            <div v-for="slot in resourcePlaceholders" :key="`placeholder-${selectedResource}-${slot}`" class="version-row placeholder-row" aria-hidden="true">
              <span class="product-label"><i :class="selectedResource === 'a' ? 'astrbot-dot' : 'napcat-dot'" />{{ selectedResource === 'a' ? 'AstrBot' : 'NapCat' }}</span><span>等待安装版本</span><span>—</span><span>—</span><span />
            </div>
          </div>
          <div class="table-footer">
            <span>{{ selectedResource === 'a' ? 'AstrBot' : 'NapCat' }} · 共 {{ selectedInstalled.length }} 个版本</span>
            <div class="pager">
              <button class="page-btn" type="button" :disabled="resourcePage <= 1" @click="changeResourcePage(resourcePage - 1)">‹</button>
              <span>{{ resourcePage }} / {{ resourcePageCount }}</span>
              <button class="page-btn" type="button" :disabled="resourcePage >= resourcePageCount" @click="changeResourcePage(resourcePage + 1)">›</button>
            </div>
          </div>
        </section>

        <section class="resource-section source-section">
          <div class="section-head"><div><span class="section-index">03</span><h2>下载资源</h2></div><button class="tool-btn section-action" :disabled="testing" @click="probeBoth">{{ testing ? '检测中' : '检测所有来源' }}</button></div>
          <div class="source-block"><h3>AstrBot <small>Python 源</small></h3><div class="source-table"><div v-for="s in pySources.sources" :key="`py-${s.indexUrl}`" class="source-row"><b>{{ s.label }}</b><span class="source-url">{{ s.indexUrl }}</span><span v-if="pyHealth.get(s.indexUrl)" class="health" :class="pyHealth.get(s.indexUrl)?.status" :title="pyHealth.get(s.indexUrl)?.reason">{{ pyHealth.get(s.indexUrl)?.status === 'ok' ? `可用 ${pyHealth.get(s.indexUrl)?.ms}ms` : '不可用' }}</span><button class="row-action primary" :disabled="isSourceDown(pyHealth.get(s.indexUrl))" :title="downHint(pyHealth.get(s.indexUrl), '安装')" @click="openPickByBase('a', s.indexUrl)">下载</button><button v-if="!s.builtin" class="row-action danger" @click="removePySource(s.indexUrl)">删</button></div></div></div>
          <div class="source-block"><h3>NapCat <small>GitHub 源</small></h3><div class="source-table"><div v-for="m in githubMirrors" :key="`gh-${m.base}`" class="source-row"><b>{{ m.label }}</b><span class="source-url">{{ displayBase(m) }}</span><span v-if="mirrorHealth.get(m.base)" class="health" :class="mirrorHealth.get(m.base)?.status" :title="mirrorHealth.get(m.base)?.reason">{{ mirrorHealth.get(m.base)?.status === 'ok' ? `可用 ${mirrorHealth.get(m.base)?.ms}ms` : '不可用' }}</span><button class="row-action primary" :disabled="isSourceDown(mirrorHealth.get(m.base))" :title="downHint(mirrorHealth.get(m.base), '下载')" @click="openPick(m, 'n')">下载</button><button v-if="!m.builtin" class="row-action danger" @click="removeMirror(m.base)">删</button></div></div></div>
          <div class="source-tools">
            <button class="tool-btn" @click="showAdd = !showAdd">{{ showAdd ? '收起' : '添加 GitHub 源' }}</button>
            <button class="tool-btn" @click="pickImport">{{ impBusy ? '处理中…' : '导入压缩包' }}</button>
            <button v-if="deadMirrors.length" class="tool-btn" @click="removeAllDead">清理失效源（{{ deadMirrors.length }}）</button>
          </div>
          <!--
            手动导入的探测结果。
            ★ 这一段是**补回来**的：重写模板时把它丢了，于是用户选完压缩包
            什么反馈都没有（探测结果存在 impProbe 里但没人渲染），
            确认安装的按钮也没了 —— 功能整条断掉。
            守卫测试 no-dead-renderer-code 抓出了 doImport 没有调用点。
          -->
          <div v-if="impProbe" class="import-result">
            <b v-if="impProbe.kind">认出来啦：{{ impProbe.kind === 'a' ? 'AstrBot' : 'NapCat' }} {{ impProbe.version || '（版本未知）' }}</b>
            <b v-else>这个压缩包没认出来，换一个试试</b>
            <div class="import-actions">
              <button class="action-btn primary" :disabled="impBusy" @click="doImport">{{ impBusy ? '导入中…' : '确认导入' }}</button>
              <button class="tool-btn" :disabled="impBusy" @click="impProbe = null; impFile = ''">取消</button>
            </div>
          </div>
          <p v-if="impErr" class="import-note bad">{{ impErr }}</p>
          <p v-else-if="impMsg" class="import-note">{{ impMsg }}</p>
          <div v-if="showAdd" class="addbox"><input v-model="newBase" class="inp wide" placeholder="https://镜像地址/" /><input v-model="newLabel" class="inp" placeholder="名称" /><button class="action-btn primary" @click="addMirror">添加</button></div>
        </section>
      </main>
    </div>

    <Transition name="pop"><div v-if="picking" class="mask" @click.self="picking = null"><div class="dlg"><header class="dhead"><h2>{{ picking.label }}</h2><button class="tool-btn" :disabled="loadingVersions" @click="loadVersions(true)">{{ loadingVersions ? '读取中' : '刷新' }}</button><button class="x" @click="picking = null">×</button></header><p v-if="versionSourceHint" class="srcline">{{ versionSourceHint }}</p><div class="vlist"><p v-if="loadingVersions" class="none">正在读取版本列表…</p><p v-else-if="!versions.length" class="none">这个源上没读到版本</p><div v-for="v in versions" :key="v.tag" class="vitem"><div class="vinfo"><b>{{ v.tag }}</b><span v-if="v.prerelease" class="tag warn">测试版</span></div><div class="vright"><span v-if="v.publishedAt" class="meta">{{ v.publishedAt.slice(0, 10) }}</span><button v-if="isInstalled(v.tag)" class="status-chip ready" disabled>已安装</button><button v-else class="action-btn primary" :disabled="isBusy(pickType, v.tag)" @click="install(v)">{{ isBusy(pickType, v.tag) ? '下载中' : '下载' }}</button></div></div></div></div></div></Transition>
    <Transition name="pop"><div v-if="delTarget" class="mask" @click.self="delTarget = null"><div class="dlg small"><h2>删除 {{ delTarget.type === 'a' ? 'AstrBot' : 'NapCat' }} {{ delTarget.tag }}？</h2><p class="sub">{{ delRunning.length ? `有 ${delRunning.length} 个实例正在使用，需先停止它们。` : delUsedBy.length ? `有 ${delUsedBy.length} 个实例引用此版本，删除后需要重新选择版本。` : '运行时文件将被删除。' }}</p><div class="row"><button class="tool-btn" @click="delTarget = null">取消</button><button class="action-btn danger" :disabled="delRunning.length > 0" @click="doRemove">删除</button></div></div></div></Transition>
    <Transition name="pop"><div v-if="needPython" class="mask" @click.self="needPython = null"><div class="dlg small">
      <h2>要先装 Python 呀</h2>
      <p class="sub">
        AstrBot 是 Python 程序，得靠内置 Python 来安装。
        装好之后回来再点「下载」，就能挑版本了。
      </p>
      <div class="row">
        <button class="tool-btn" @click="needPython = null">知道了</button>
        <button class="action-btn primary" :disabled="pyBusy" @click="installPythonFromDialog">
          {{ pyBusy ? '安装中…' : '安装 Python' }}
        </button>
      </div>
    </div></div></Transition>
  </div>
</template><style scoped>
.download-console { max-width: 1180px; margin: 0 auto; padding: 20px 28px 36px; color: var(--ink); }
.console-head { display:flex; justify-content:space-between; align-items:flex-end; gap:24px; padding-bottom:18px; border-bottom:1px solid var(--hairline); }
.eyebrow { margin:0 0 7px; color:var(--primary); font-size:10px; font-weight:800; letter-spacing:.16em; }
.console-head h1 { margin:0; font-size:25px; line-height:1; font-weight:750; letter-spacing:-.03em; }
.head-note { margin:7px 0 0; color:var(--ink-soft); font-size:12px; }
.head-actions { display:flex; align-items:center; gap:10px; }
.head-alert { max-width:280px; color:var(--danger); font-size:11px; }
.console-grid { display:grid; grid-template-columns:188px minmax(0,1fr); gap:34px; padding-top:22px; }
/*
 * 左侧栏：普通块布局，项目主页卡片**紧跟**在资源项下面。
 *
 * 早先用过 flex + `margin-top:auto` 把它顶到底部 —— 主人否决了
 *（「不要在最下面，放在资源下面」）。那一栏的高度是跟着右侧内容走的，
 * 顶到底部会让卡片与资源项之间空出一大段，反而显得是两块无关的东西。
 */
.resource-nav { border-right:1px solid var(--hairline); padding-right:20px; }
.nav-title { margin:0 0 9px; color:var(--ink-soft); font-size:10px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; }
.resource-item { display:grid; grid-template-columns:28px 1fr auto; align-items:center; gap:8px; min-height:48px; padding:6px 8px; margin:2px 0; border-left:2px solid transparent; }
.resource-item.active { background:var(--primary-soft); border-left-color:var(--primary); }
.resource-item b { display:block; font-size:12px; }
.resource-item small { display:block; margin-top:2px; color:var(--ink-soft); font-size:10px; }
.resource-item strong { color:var(--ink-soft); font-size:12px; }
.resource-mark { display:grid; place-items:center; width:25px; height:25px; border-radius:5px; color:#fff; font-size:12px; font-weight:800; }
.astrbot-mark { background:#315da8; } .napcat-mark { background:#d06a3c; }
.nav-rule { height:1px; margin:22px 0; background:var(--hairline); }
/*
 * 项目主页 + 求 Star（资源项下面的一段说明文字）
 *
 * 三处刻意的选择：
 *   · **没有背景**（主人的要求）—— 只有文字，读起来是这一栏的一部分
 *   · **超链是行内的** —— 可点的只有那串地址，不是整块区域
 *   · 星标用主色，是整段里唯一的彩色锚点（眼睛会落上去）
 */
.repo-note { padding:0 2px; }
.repo-head { display:flex; align-items:center; gap:6px; margin-bottom:6px; }
.repo-head b { color:var(--ink); font-size:11.5px; font-weight:700; }
.repo-star { width:12px; height:12px; flex:0 0 auto; fill:var(--primary); }
.repo-note p { margin:0; color:var(--ink-soft); font-size:10.5px; line-height:1.65; }
.repo-note em { color:var(--primary); font-style:normal; font-weight:700; }
/* 超链：地址本身就长得像地址，所以给下划线 + 主色，一眼看出能点 */
.repo-link { color:var(--primary); font-weight:600; text-decoration:underline; text-underline-offset:2px; word-break:break-all; cursor:pointer; }
.repo-link:hover { color:var(--ink); }

/*
 * 问题反馈教程（在项目主页下方）
 *
 * 排版上的取舍：
 *   · 用有序列表 —— 这是**有先后顺序的步骤**（先导出日志、再描述、再提交），
 *     用无序点会让用户以为可以任选其一。
 *   · 与 `repo-note` 共用字号/颜色（同一栏的次要内容），
 *     但序号用主色，让"这是可操作的步骤"一眼可辨。
 *   · `.hint` 是补充说明，比正文再淡一级，不打断主流程的阅读。
 */
.feedback-guide { padding:0 2px; }
/*
 * 使用流程（在反馈教程下方）
 *
 * 与上面的反馈教程共用有序列表样式（两处都是"按顺序做"），
 * 所以 `.flow-guide ol` 直接复用 `.feedback-guide ol` 的那套规则 ——
 * 写成一条并集选择器，避免两处各写一遍然后慢慢漂移。
 */
.feedback-guide ol, .flow-guide ol { margin:0; padding-left:14px; color:var(--ink-soft); font-size:10.5px; line-height:1.7; }
.feedback-guide li, .flow-guide li { margin-bottom:4px; }
.feedback-guide li:last-child, .flow-guide li:last-child { margin-bottom:0; }
.feedback-guide li::marker, .flow-guide li::marker { color:var(--primary); font-weight:700; }
.feedback-guide li b, .flow-guide li b { color:var(--ink); font-weight:650; }
.feedback-guide em, .flow-guide em { color:var(--primary); font-style:normal; font-weight:700; }
.feedback-guide .hint { margin:7px 0 0; color:var(--ink-soft); font-size:10px; line-height:1.6; opacity:.82; }
.flow-guide { padding:0 2px; }
.env-line { display:flex; justify-content:space-between; padding:7px 0; color:var(--ink-soft); font-size:11px; border-bottom:1px solid color-mix(in srgb, var(--hairline) 70%, transparent); }
.env-line b { max-width:112px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--danger); font-weight:650; }
.env-truncate { display:block; }
.env-line b.ready { color:var(--ribbon-run); }
.resource-main { min-width:0; display:flex; flex-direction:column; }
.resource-main > .resource-section:not(.runtime-section):not(.environment-section):not(.source-section) { order:1; }
.environment-section { order:2; }
.runtime-section { order:3; }
.source-section { order:4; }
.resource-section { padding:0 0 22px; margin:0 0 22px; border-bottom:1px solid var(--hairline); }
.section-head { display:flex; align-items:baseline; justify-content:space-between; gap:16px; margin-bottom:12px; }
.section-head > div { display:flex; align-items:baseline; gap:10px; }
.section-index { color:var(--primary); font:700 10px/1 ui-monospace, SFMono-Regular, Consolas, monospace; }
.section-head h2 { margin:0; font-size:16px; font-weight:750; letter-spacing:-.015em; }
.section-meta { color:var(--ink-soft); font-size:11px; }
.runtime-line { display:grid; grid-template-columns:34px minmax(0,1fr) auto auto; align-items:center; gap:11px; min-height:52px; padding:9px 0; }
.runtime-icon { display:grid; place-items:center; width:32px; height:32px; border-radius:5px; background:#e7eefb; color:#315da8; font-size:11px; font-weight:800; }
.runtime-copy b { display:block; font-size:13px; } .runtime-copy span { display:block; margin-top:3px; color:var(--ink-soft); font-size:11px; }
.status-chip { display:inline-flex; align-items:center; min-height:22px; padding:0 8px; border-radius:4px; background:#eef1f6; color:var(--ink-soft); font-size:10px; font-weight:750; }
.status-chip.ready { background:#e4f3ec; color:#277653; }
.action-btn,.tool-btn,.row-action,.cancelbtn { border:1px solid var(--hairline); cursor:pointer; font:inherit; }
.action-btn { min-height:28px; padding:0 11px; border-radius:4px; font-size:11px; font-weight:700; }
.action-btn.primary,.row-action.primary { border-color:var(--primary); background:var(--primary); color:#fff; }
.action-btn.danger,.row-action.danger { border-color:#d9aaa5; background:#fff; color:#a33e37; }
.action-btn:disabled,.tool-btn:disabled,.row-action:disabled { cursor:not-allowed; opacity:.5; }
.tool-btn { min-height:28px; padding:0 10px; border-radius:4px; background:#fff; color:var(--ink-soft); font-size:11px; font-weight:650; }
.tool-btn:hover:not(:disabled) { border-color:var(--primary); color:var(--primary-deep); }
.version-table,.source-table { width:100%; }
.table-head,.version-row,.source-row { display:grid; grid-template-columns:110px 1fr minmax(100px,1.2fr) 75px 42px; align-items:center; gap:10px; }
.table-head { min-height:25px; color:var(--ink-soft); border-bottom:1px solid var(--hairline); font-size:10px; }
.version-row { min-height:36px; border-bottom:1px solid color-mix(in srgb,var(--hairline) 72%,transparent); font-size:11px; }
.version-row > span:not(.product-label),.version-row > b { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.product-label { display:flex; align-items:center; gap:6px; font-weight:650; }
.product-label i { width:6px; height:6px; border-radius:50%; } .astrbot-dot { background:#315da8; } .napcat-dot { background:#d06a3c; }
.row-action { min-height:23px; padding:0 6px; border-radius:3px; font-size:10px; font-weight:700; }
.empty-row { padding:17px 0; color:var(--ink-soft); font-size:11px; }
.env-actions { display:flex; gap:5px; margin-top:4px; }
.env-action { align-self:flex-start; min-height:21px; }
.env-stack { cursor:default; }

.environment-cell { min-width:0; min-height:48px; display:flex; flex-direction:column; justify-content:center; gap:4px; padding:8px 11px; border-right:1px solid var(--hairline); border-bottom:1px solid var(--hairline); background:rgba(255,255,255,.16); }
.environment-cell span { color:var(--ink-soft); font-size:10px; }
.environment-cell b { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ink); font-size:11px; font-weight:650; }
.environment-cell b small { color:var(--ink-soft); font-size:10px; font-weight:500; }
.env-stack { display:flex; align-items:center; gap:5px; }
.env-stack i { width:6px; height:6px; flex:0 0 auto; border-radius:50%; background:var(--danger); }
.env-stack i.good { background:var(--ribbon-run); }

.source-block h3 { display:flex; align-items:baseline; gap:9px; margin:0 0 7px; font-size:15px; line-height:1.3; font-weight:800; color:var(--ink); letter-spacing:-.01em; }
.source-block h3 small { color:var(--ink-soft); font-size:10px; font-weight:500; letter-spacing:0; }
.source-row { grid-template-columns:115px minmax(0,1fr) 75px 45px 24px; min-height:35px; border-bottom:1px solid color-mix(in srgb,var(--hairline) 72%,transparent); font-size:11px; }
.source-url { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ink-soft); font-size:10px; }
.health { color:var(--danger); font-size:10px; } .health.ok { color:var(--ribbon-run); }
.source-tools { display:flex; gap:7px; margin-top:11px; flex-wrap:wrap; }
.import-result { display:flex; align-items:center; gap:12px; margin-top:10px; padding:9px 11px; border:1px solid var(--hairline); border-radius:6px; background:rgba(255,255,255,.5); font-size:11px; }
.import-result b { flex:1; min-width:0; font-weight:650; }
.import-actions { display:flex; gap:6px; flex-shrink:0; }
.import-note { margin:8px 0 0; font-size:11px; color:var(--ink-soft); white-space:pre-line; }
.task-strip { margin-top:14px; padding:9px 12px; border:1px solid #cbd8ed; border-left:3px solid var(--primary); background:#f7faff; }
.strip-label { display:flex; align-items:center; gap:6px; margin-bottom:5px; color:var(--primary-deep); font-size:10px; font-weight:800; }
.live-dot { width:6px; height:6px; border-radius:50%; background:#2d9a70; }
.task-row { display:grid; grid-template-columns:180px minmax(120px,1fr) minmax(100px,1.6fr) 38px 52px; align-items:center; gap:10px; min-height:30px; border-top:1px solid #e3eaf4; font-size:11px; }
.task-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:650; } .task-state { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ink-soft); }
.task-progress { height:4px; overflow:hidden; background:#dfe7f2; border-radius:2px; } .task-progress i { display:block; height:100%; background:var(--primary); }
.task-percent { color:var(--ink-soft); font-size:10px; text-align:right; } .task-result { font-size:10px; color:var(--danger); } .task-result.done { color:var(--ribbon-run); }
.cancelbtn { min-height:23px; padding:0 6px; border-color:#d9aaa5; border-radius:3px; background:#fff; color:#a33e37; font-size:10px; font-weight:700; }
.cancelbtn:hover:not(:disabled) { background:#fff2f1; }
.notice { margin:10px 0 0; padding:7px 9px; background:#f3f7fc; color:var(--ink-soft); font-size:11px; }
.addbox { display:flex; gap:7px; margin-top:8px; } .inp { min-height:28px; padding:0 8px; border:1px solid var(--hairline); border-radius:4px; background:#fff; color:var(--ink); font-size:11px; } .inp.wide { flex:1; }
.mask { position:fixed; inset:0; z-index:200; display:grid; place-items:center; background:rgba(19,28,43,.34); }
.dlg { width:min(560px,calc(100vw - 36px)); max-height:75vh; display:flex; flex-direction:column; padding:18px; background:#fff; border:1px solid var(--hairline); border-radius:6px; box-shadow:0 18px 50px rgba(20,30,50,.22); }
.dlg.small { width:min(420px,calc(100vw - 36px)); } .dhead { display:flex; align-items:center; gap:8px; margin-bottom:12px; } .dhead h2,.dlg h2 { margin:0; font-size:15px; } .dhead .x { margin-left:auto; border:0; background:transparent; color:var(--ink-soft); font-size:20px; cursor:pointer; }
.vlist { overflow:auto; } .vitem { min-height:35px; padding:5px 0; } .vright { display:flex; align-items:center; gap:7px; margin-left:auto; } .vinfo { flex:1; } .row { display:flex; justify-content:flex-end; gap:7px; margin-top:16px; }
.resource-item { appearance:none; width:100%; border:0; background:transparent; color:inherit; text-align:left; cursor:pointer; transition-property:background-color,border-color,transform,box-shadow; transition-duration:150ms; transition-timing-function:ease-out; }
.resource-item:not(.active) { background:transparent; }
.resource-item:hover { background:color-mix(in srgb,var(--primary-soft) 72%,transparent); }
.resource-item:focus-visible,.page-btn:focus-visible,.action-btn:focus-visible,.tool-btn:focus-visible,.row-action:focus-visible,.cancelbtn:focus-visible { outline:2px solid color-mix(in srgb,var(--primary) 70%,white); outline-offset:2px; }
.resource-item.active { box-shadow:inset 3px 0 0 var(--primary),0 5px 18px rgba(40,88,168,.08); transform:translateX(2px); }
.placeholder-row { color:color-mix(in srgb,var(--ink-soft) 58%,transparent); }
.placeholder-row .product-label { opacity:.48; }
.table-footer { display:flex; justify-content:space-between; align-items:center; min-height:34px; color:var(--ink-soft); font-size:10px; border-top:1px solid var(--hairline); }
.pager { display:flex; align-items:center; gap:8px; font-variant-numeric:tabular-nums; }
.page-btn { display:grid; place-items:center; width:24px; height:24px; padding:0; border:1px solid var(--hairline); border-radius:4px; background:#fff; color:var(--ink); cursor:pointer; font-size:16px; line-height:1; }
.page-btn:hover:not(:disabled) { border-color:var(--primary); color:var(--primary-deep); background:var(--primary-soft); }
.page-btn:disabled { cursor:not-allowed; opacity:.35; }
.mask { position:fixed; inset:0; z-index:200; display:grid; place-items:center; padding:24px; background:rgba(20,30,48,.28); backdrop-filter:blur(14px) saturate(125%); -webkit-backdrop-filter:blur(14px) saturate(125%); }
.dlg { width:min(560px,calc(100vw - 36px)); max-height:75vh; display:flex; flex-direction:column; padding:20px; background:linear-gradient(145deg,rgba(255,255,255,.82),rgba(240,247,255,.68)); border:1px solid rgba(255,255,255,.78); border-radius:16px; box-shadow:0 24px 70px rgba(16,30,55,.28),inset 0 1px 0 rgba(255,255,255,.9); backdrop-filter:blur(26px) saturate(145%); -webkit-backdrop-filter:blur(26px) saturate(145%); }
.dlg.small { width:min(420px,calc(100vw - 36px)); }
.dhead { display:flex; align-items:center; gap:8px; margin-bottom:12px; padding-bottom:12px; border-bottom:1px solid rgba(180,195,215,.4); }
.dhead h2,.dlg h2 { margin:0; font-size:15px; text-wrap:balance; }
.dhead .x { margin-left:auto; display:grid; place-items:center; width:32px; height:32px; border:1px solid transparent; border-radius:8px; background:transparent; color:var(--ink-soft); font-size:20px; cursor:pointer; transition-property:background-color,color; transition-duration:150ms; }
.dhead .x:hover { background:rgba(179,77,69,.12); color:var(--danger); }
.vlist { overflow:auto; padding:6px 4px 4px 0; }
.vitem {
  display:flex;
  align-items:center;
  min-height:44px;
  gap:12px;
  padding:7px 9px;
  margin:0;
  background:transparent;
  border-bottom:1px solid rgba(164,182,207,.28);
  border-radius:7px;
  transition-property:background-color,border-color,transform;
  transition-duration:150ms;
  transition-timing-function:ease-out;
}
.vitem:first-child { border-top:1px solid rgba(164,182,207,.28); }
.vitem:hover {
  background:rgba(70,116,184,.10);
  border-color:rgba(92,139,207,.28);
}
.vitem .vinfo { min-width:0; display:flex; align-items:center; gap:8px; }
.vitem .vinfo b { color:var(--ink); font-size:12.5px; font-weight:700; }
.vitem .vright { display:flex; align-items:center; gap:9px; margin-left:auto; }
.vitem .meta { color:var(--ink-soft); font-size:10.5px; font-variant-numeric:tabular-nums; }
.vitem .action-btn.primary { min-width:48px; }
.vitem .status-chip.ready { box-shadow:inset 0 0 0 1px rgba(39,118,83,.12); }
.pop-enter-active,.pop-leave-active { transition:opacity .14s ease,transform .14s ease; } .pop-enter-from,.pop-leave-to { opacity:0; transform:translateY(-5px); }
@media (max-width:800px) { .console-grid { grid-template-columns:1fr; gap:18px; } .resource-nav { display:grid; grid-template-columns:1fr 1fr; gap:4px 10px; padding:0 0 12px; border-right:0; border-bottom:1px solid var(--hairline); } .nav-title,.nav-rule { display:none; } .env-line { display:none; } .task-row { grid-template-columns:1fr 90px 38px 52px; } .task-state { display:none; } .table-head,.version-row { grid-template-columns:90px 1fr 65px 42px; } .table-head span:nth-child(3),.version-row > span:nth-child(3) { display:none; } .source-row { grid-template-columns:90px minmax(0,1fr) 45px 24px; } .source-url { display:none; } }
</style>
