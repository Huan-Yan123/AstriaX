<script setup lang="ts">
import { usePythonSources } from './composables/usePythonSources'

import { useGithubSources } from './composables/useGithubSources'
import { useRuntimeRemoval } from './composables/useRuntimeRemoval'

import { useRuntimeImport } from './composables/useRuntimeImport'
import { useRuntimePip } from './composables/useRuntimePip'

import { useDownloadProgress } from './composables/useDownloadProgress'
import { useRuntimeEnvironment } from './composables/useRuntimeEnvironment'
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
  dlProbeBlocked
} from './dl-cache'

/** QQ 官网下载页（与主进程 qq-check.ts 里的常量保持一致） */
const QQ_DOWNLOAD_URL = 'https://im.qq.com/pcqq/index.shtml'

import type { Mirror, MirrorState, VersionItem, RuntimeVersion, Progress, LauncherApi } from './types/runtime-center'

const api = (): LauncherApi => ((window as unknown as { launcher?: LauncherApi }).launcher ?? {})

const state = ref<MirrorState | null>(null)
const runtimes = ref<RuntimeVersion[]>([])
const py = ref<{ ready: boolean; version: string } | null>(null)
/**
 * 进度按任务分别记：同时装 Python + AstrBot + NapCat 时，
 * 之前只有一个 progress 变量，后开始的会把先开始的覆盖掉，
 * 看着就像「只显示一个在下载」。
 */
const { progressList, cancelling, isStalled, elapsedSec, trackKey, setProgress, cancelTask } = useDownloadProgress({ cancel: payload => api().runtimes?.cancel?.(payload), reload })

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

const { newLabel, newBase, newMode, showAdd, mirrors, githubMirrors, mirrorHealth, testing, probeMirrors, isSourceDown, downHint, deadMirrors, removeAllDead, addMirror, removeMirror } = useGithubSources(api, state, err, reload)

/*
 * `officialMirrors`（mode==='files' 的官方文件源）已删除。
 *
 * 主人 2026-10-08 要求「去掉官方源」，模板里那一组行已经移掉，
 * 这个 computed 就只剩定义了（守卫测试抓出）。留着会让下一个人
 * 以为"官方源还在界面上某个地方显示"。
 */
/** GitHub 系源（mode==='proxy'）：只对 NapCat 有意义 */

/*
 * AstrBot 的 **Python 源**（pip 索引）—— 从主进程的 python-sources.json 读。
 * 界面放在"下载"页而不是设置页（主人明确要求：下载页分类才直观）。
 */
const { pySources, pyActive, pyHealth, probePySources, loadPySources, removePySource } = usePythonSources(err)
async function probeBoth(): Promise<void> {
  await Promise.all([probeMirrors(), probePySources()])
}

const versionSourceHint = computed<string>(() => {
  const m = picking.value
  if (!m) return ''
  if (pickType.value === 'a' && !m.base) {
    return '版本来自 PyPI'
  }
  return ''
})

const needPython = ref<{ label: string; indexUrl: string; type: 'a' | 'n' } | null>(null)

/** 判断内置 Python 是否就绪（未加载完时当作"未知"，不拦） */
function pythonReady(): boolean {
  return py.value?.ready === true
}

function openPickByBase(type: 'a' | 'n', indexUrl: string): void {

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

const { pipTag, pipSpec, pipBusy, pipMsg, pipErr, pipTargets, installPip } = useRuntimePip(api, installedA)

/** 各源存活情况：base → 延迟（null=不通，undefined=还没测） */
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
const { environment, environmentLoading, refreshEnvironment, loadEnvironment } = useRuntimeEnvironment({ overview: () => api().stats?.overview?.(), py, qq, checkQQ })
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

    qq.value = {
      ok: false,
      installed: false,
      minBuild: 40768,
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

/** 资源页项目主页，通过桌面接口在系统浏览器中打开。 */
const GITHUB_REPO_URL = 'https://github.com/Huan-Yan123/AstriaX'

const OFFICIAL_GROUP = '1077554004'

function openGithub(): void {
  void window.launcher?.app?.openExternal?.(GITHUB_REPO_URL)
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

    dlInvalidate({ keepProbe: true })
    await reload()

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

const { delTarget, delUsedBy, delRunning, askRemove, doRemove } = useRuntimeRemoval(api, { err, note, picking, reload, loadVersions })

/* ---------------- 手动导入 ---------------- */

const { impFile, impBusy, impErr, impMsg, impVersion, impProbe, impType, pickImport, doImport } = useRuntimeImport(api, installedA, installedN, reload)

let offProgress: (() => void) | undefined

const cachedSnap = dlHydrate()
if (cachedSnap) {
  state.value = cachedSnap.state as MirrorState
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

  offProgress = api().onDownloadProgress?.((p) => setProgress(p))

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

  void loadPySources()
  /* Python 源也要测通断（与 GitHub 源一样显示"可用 xxx ms"） */
  void probePySources()
 void loadEnvironment()
})
onUnmounted(() => {
  offProgress?.()
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

        <!--
          02 运行环境
          放在「安装版本」之后：用户的实际顺序是先看环境（Python/QQ 装没装），
          再决定装哪个版本 —— 但编号上它仍是 02，因为 01 是这一页的核心动作。
        -->
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

        <section class="resource-section source-section">
          <div class="section-head"><div><span class="section-index">03</span><h2>下载资源</h2></div><button class="tool-btn section-action" :disabled="testing" @click="probeBoth">{{ testing ? '检测中' : '检测所有来源' }}</button></div>
          <div class="source-block"><h3>AstrBot <small>Python 源</small></h3><div class="source-table"><div v-for="s in pySources.sources" :key="`py-${s.indexUrl}`" class="source-row"><b>{{ s.label }}</b><span class="source-url">{{ s.indexUrl }}</span><span v-if="pyHealth.get(s.indexUrl)" class="health" :class="pyHealth.get(s.indexUrl)?.status" :title="pyHealth.get(s.indexUrl)?.reason">{{ pyHealth.get(s.indexUrl)?.status === 'ok' ? `可用 ${pyHealth.get(s.indexUrl)?.ms}ms` : '不可用' }}</span><button class="row-action primary" :disabled="isSourceDown(pyHealth.get(s.indexUrl))" :title="downHint(pyHealth.get(s.indexUrl), '安装')" @click="openPickByBase('a', s.indexUrl)">下载</button><button v-if="!s.builtin" class="row-action danger" @click="removePySource(s.indexUrl)">删</button></div></div></div>
          <div class="source-block"><h3>NapCat <small>GitHub 源</small></h3><div class="source-table"><div v-for="m in githubMirrors" :key="`gh-${m.base}`" class="source-row"><b>{{ m.label }}</b><span class="source-url">{{ displayBase(m) }}</span><span v-if="mirrorHealth.get(m.base)" class="health" :class="mirrorHealth.get(m.base)?.status" :title="mirrorHealth.get(m.base)?.reason">{{ mirrorHealth.get(m.base)?.status === 'ok' ? `可用 ${mirrorHealth.get(m.base)?.ms}ms` : '不可用' }}</span><button class="row-action primary" :disabled="isSourceDown(mirrorHealth.get(m.base))" :title="downHint(mirrorHealth.get(m.base), '下载')" @click="openPick(m, 'n')">下载</button><button v-if="!m.builtin" class="row-action danger" @click="removeMirror(m.base)">删</button></div></div></div>
          <div class="source-tools">
            <button class="tool-btn" @click="showAdd = !showAdd">{{ showAdd ? '收起' : '添加 GitHub 源' }}</button>
            <button class="tool-btn" @click="pickImport">{{ impBusy ? '处理中…' : '导入压缩包' }}</button>
            <button v-if="deadMirrors.length" class="tool-btn" @click="removeAllDead">清理失效源（{{ deadMirrors.length }}）</button>
          </div>

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

        <section v-if="pipTargets.length" class="resource-section pip-section">
          <div class="section-head">
            <div><span class="section-index">04</span><h2>安装 pip 库</h2></div>
          </div>
          <p class="pip-note">
            给 AstrBot 补装 Python 库（插件常需要）。装好后<b>该版本的所有实例</b>都能用 —— 依赖是按版本共享的。
          </p>
          <div class="pip-form">
            <label class="pip-field">
              <span>装到哪个版本</span>
              <select v-model="pipTag" class="inp" :disabled="pipBusy">
                <option v-for="t in pipTargets" :key="t" :value="t">AstrBot {{ t }}</option>
              </select>
            </label>
            <label class="pip-field grow">
              <span>库名</span>
              <input
                v-model="pipSpec"
                class="inp wide"
                :disabled="pipBusy"
                placeholder="例如 requests，也可写 requests>=2.31"
                @keyup.enter="installPip"
              />
            </label>
            <button class="action-btn primary" :disabled="pipBusy || !pipSpec.trim()" @click="installPip">
              {{ pipBusy ? '安装中…' : '安装' }}
            </button>
          </div>
          <p v-if="pipErr" class="pip-note bad">{{ pipErr }}</p>
          <p v-else-if="pipMsg" class="pip-note ok">{{ pipMsg }}</p>
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
</template><style scoped src="./styles/DownloadPage.css"></style>
