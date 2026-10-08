<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

export interface Instance {
  id: string
  name: string
  type: 'a' | 'n'
  status: string
  port: number
  memMB?: number
  /** 当前运行时版本（如 "4.18.19"）；读不到就是空，卡片显示「版本未知」 */
  runtimeVersion?: string
}

const props = withDefaults(
  defineProps<{
    inst: Instance
    busy?: boolean
    /**
     * 这个实例正在**一键更新**（主人 2026-09-27 要求）：
     *   「更新实例的时候应该锁住启动且一键更新变成一键解锁直到更新完成」
     *   「同时启动按钮文字变成更新中」
     *
     * ## 与 `busy` 的分工（两个都要，缺一不可）
     *
     *   · `busy`     → **禁用**所有会碰运行时的按钮（让用户点不动）
     *   · `updating` → **文案**（按钮写「更新中…」，让用户知道不是卡死）
     *
     * 只禁用的话用户以为界面坏了（"怎么点都没反应"）；
     * 只改文字的话他还能点进去 → 实例在装新版本的同时跑起来 →
     * 两边抢同一个运行时目录（Windows 会锁住文件）→ 各种奇怪 bug。
     */
    updating?: boolean
    /** 正在启动/停止：按钮文字跟着变，用户知道点了有反应 */
    switching?: 'starting' | 'stopping' | null
    webuiOpen?: boolean
    webuiBusy?: boolean
    /*
     * 该类运行时**准备好没有**（App.vue 传 `tplState[x.type]`）。
     *
     * ## 为什么给它一个 `true` 缺省值（这里踩了一个 Vue 的坑）
     *
     * Vue 对 Boolean 类型的 prop 有个特殊转换：**父组件不传时得到 `false`，
     * 而不是 `undefined`**。所以 `tplReady?: boolean` 加上
     * `props.tplReady !== false` 这种写法**达不到"没传就别管"的意图** ——
     * 不传时它已经是 false，照样把按钮禁掉。
     *
     * 这个坑是写测试时暴露的：新加的"停止状态应当可点"那条直接红了，
     * 而 canUpdate 的表达式看起来毫无问题。用 `withDefaults` 给个 true，
     * 语义才变成"**只有明确说没准备好**才禁用"：
     *   · 不传 / 传 undefined → true（默认值生效）→ 不禁用
     *   · 传 false → 明确没准备好 → 禁用，并在 title 里引导去下载页
     */
    tplReady?: boolean
  }>(),
  { tplReady: true }
)
const emit = defineEmits<{
  toggle: []
  webui: []
  del: []
  creds: []
  reset: []
  log: []
  /** 切换运行时版本（用户要求：高版本覆盖低版本，保留数据和配置） */
  version: []
  /**
   * 手动更新到最新版（用户新需求）。
   *
   * 背景：AstrBot 的 WebUI「一键更新」被官方主动禁用（它检测到自己是被
   * `pip install --target` 装出来的，报 "You are running AstrBot via CLI"），
   * 所以更新这件事要由启动器来做。
   */
  update: []
}>()
const menuOpen = ref(false)
const cardEl = ref<HTMLElement | null>(null)

/**
 * 点菜单以外的任何地方都自动收回（含切换页面、点别的卡片）。
 * 用捕获阶段：即使点在别的按钮上也能先收起菜单，不会两个菜单同时开着。
 */
function onDocPointerDown(e: MouseEvent): void {
  if (!menuOpen.value) return
  const el = cardEl.value
  if (el && e.target instanceof Node && el.contains(e.target)) return
  menuOpen.value = false
}
onMounted(() => document.addEventListener('pointerdown', onDocPointerDown, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown, true))

/*
 * ★ 更新中优先于一切（主人 2026-09-27：
 *   「同时启动按钮文字变成更新中」）
 *
 * 顺序很重要：更新期间这个按钮**必须是「更新中…」**，
 * 而不是按 status 显示"启动/停止" —— 否则用户看到"启动"能点（虽然被禁用），
 * 会以为"更新完成了我可以启动了"，从而去点别的入口找麻烦。
 *
 * `busy` 已经在 canToggle 里禁用了它，这里只负责**文案**。
 */
const canToggle = computed(
  () =>
    !props.busy &&
    !props.updating &&
    props.inst.status !== 'starting' &&
    props.inst.status !== 'stopping'
)
const webuiUsable = computed(() => props.inst.port > 0 && props.inst.status !== 'starting' && props.inst.status !== 'stopping')

const toggleText = computed(() => {
  /* 更新中：明确告诉用户在干什么（否则"点不动"会被当成卡死） */
  if (props.updating) return '更新中…'
  if (props.switching === 'starting' || props.inst.status === 'starting') return '启动中…'
  if (props.switching === 'stopping') return '停止中…'
  return props.inst.status === 'running' ? '停止' : '启动'
})

const statusText = computed(() => {
  switch (props.inst.status) {
    case 'running': return '运行中'
    case 'starting': return '启动中'
    case 'stopping': return '停止中'
    case 'error': return '出错了'
    default: return '已停止'
  }
})

const subText = computed(() => {
  if (props.tplReady === false) {
    return `还没装运行时呢（端口 :${props.inst.port}）——请到「下载」页安装一个版本哦`
  }
  return `端口 :${props.inst.port}`
})

/** AstrBot 是账号密码，NapCat 是 Token——别混着叫 */
const credWord = computed(() => (props.inst.type === 'a' ? '账密' : 'Token'))

/**
 * 「更新」能不能点。
 *
 * 用户明确要求：「手动更新必须在 astrbot 没有运行的时候才能更新」。
 * 所以运行中/启动中一律禁用（主进程也会再拦一次 —— 界面可以被绕过，
 * 真正的把关必须在主进程）。
 *
 * 另外 `tplReady === false`（还没装运行时）时也禁用：
 * 没有运行时的实例连版本都没有，谈"更新"没意义。
 *
 * 注意 `tplReady` 的**缺省值是 true**（用 withDefaults 设的，
 * 见 defineProps 那段说明）—— 因为 Vue 会把"没传的 Boolean prop"
 * 转成 `false`，不兜住的话这个判断会误禁用。
 */
const canUpdate = computed(
  () =>
    !props.busy &&
    props.tplReady &&
    props.inst.status !== 'running' &&
    props.inst.status !== 'starting' &&
    props.inst.status !== 'stopping'
)

/**
 * 「一键更新」为什么能点 / 为什么灰着 —— **逐条说清**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 为什么单独做这个（主人 2026-09-27 实测的困惑）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 他问：「怎么一键更新是灰色锁定的不让点」
 *
 * 查下去发现：那时他**刚把运行时都删了**（`runtimes.json` 空），
 * 所以 `tplReady=false` → 按钮灰 —— **行为是对的，
 * 但界面只说了一句笼统的「先给它装一个运行时版本」**，
 * 而且那句还是**兜底**文案（任何原因都显示它），
 * 于是用户分不清"为什么不让点"。
 *
 * 现在按**具体原因**给文案，而且告诉用户**怎么办**：
 * 灰按钮旁边的解释，比灰按钮本身重要。
 */
const updateTitle = computed<string>(() => {
  if (props.updating) {
    return '正在更新，别关软件也别动这个实例哦 —— 装好会自动恢复'
  }
  if (props.busy) {
    return '这个实例正忙（启动/停止/换版本中），等它完成再试'
  }
  if (props.tplReady === false) {
    return (
      '还没有可用的运行时版本 —— 更新要先有个版本才能往上换。\n' +
      '请到「下载」页装一个 AstrBot 版本，回来就能一键更新了'
    )
  }
  if (props.inst.status === 'running' || props.inst.status === 'starting') {
    return '它正在运行哦，先点「停止」再一键更新呀（运行中换版本会撞上被占用的文件）'
  }
  if (props.inst.status === 'stopping') {
    return '它正在停止中，稍等一下再试'
  }
  return '一键搞定：装好最新版并切过去，你的数据和配置都会留着'
})

/** 选了菜单项：先收回菜单再派发事件 */
function pick(k: 'log' | 'reset' | 'del' | 'version' | 'update'): void {
  menuOpen.value = false
  emit(k)
}
</script>

<template>
  <article ref="cardEl" class="card" :class="inst.status">
    <header>
      <h3>{{ inst.name }}</h3>
      <span class="badge">{{ inst.type === 'a' ? 'AstrBot' : 'NapCat' }}</span>
      <!--
        当前实例版本。值来自运行时包自己的版本标识（不是我们起的目录名），
        创建和每次启动时各刷新一次，所以换过包/回滚过备份之后这里会跟着变。
        读不到就显示「未知」——宁可说不知道，也不编一个版本号骗人。
      -->
      <span class="ver" :title="inst.runtimeVersion ? `运行时版本 ${inst.runtimeVersion}` : '还没读出运行时版本呢'">
        {{ inst.runtimeVersion ? `v${inst.runtimeVersion}` : '版本未知呢' }}
      </span>
    </header>
    <p class="status">
      <span class="dot" :class="inst.status" />
      <span>{{ statusText }}</span>
      <span class="muted">{{ subText }}</span>
    </p>
    <!--
      这里原来显示「内存 xxx MB」，靠主进程每 2 秒采一次资源占用。
      去掉了：采集用的 pidusage 在 Windows 上要 spawn wmic.exe，
      而 wmic 在新版 Windows 里**已被移除**，每次调用都要等命令失败超时
      （实测 2.4~5.1 秒，比 2 秒的轮询间隔还长）——主进程因此永远在等它，
      整个界面点什么都卡。而且 AstrBot 和 NapCat 自己的 WebUI 都有资源信息，
      没必要在这儿重复一份。 -->
    <div class="actions">
      <button class="main" :disabled="!canToggle" @click="emit('toggle')">
        {{ toggleText }}
      </button>
      <button class="ghost" :class="{ ready: webuiUsable }" :disabled="!webuiUsable || webuiBusy" @click="emit('webui')">
        {{ webuiBusy ? '连接中…' : webuiOpen ? '收起' : 'WebUI' }}
      </button>
      <!-- 账密放在明面上：这是用户最常要看的东西 -->
      <button class="ghost cred" @click="emit('creds')">看看{{ credWord }}</button>
      <div class="morewrap">
        <button class="ghost more" aria-label="更多操作" @click.stop="menuOpen = !menuOpen">⋯</button>
        <Transition name="menupop">
          <div v-if="menuOpen" class="menu">
            <button @click="pick('log')">翻翻日志</button>
            <!--
              ★ 「一键更新」：升到该类型的最新版（用户新需求）。

              为什么要放在这里：AstrBot 的 WebUI「一键更新」被官方**主动禁用**
              （它检测到自己是被 pip 的 target 方式装出来的，报
              "You are running AstrBot via CLI, please use pip or uv tool upgrade"）。
              所以用户需要一个由启动器提供的更新入口。

              为什么运行时要禁用：用户明确要求「手动更新必须在 astrbot
              没有运行的时候才能更新」。技术上也是必要的 ——
              更新的第一步是往 runtimes 里装新版本，而 Windows 会锁住
              正在使用的文件（项目里踩过 `*.deleting-*` 残骸那个坑）。

              禁用时给 title 说明原因，别让用户对着灰按钮猜。

              ★ 文案（主人 2026-09-26）：「更新」两个字改成「**一键更新**」——
              因为它是"检查最新版 + 下载 + 切换 + 重启"一整套动作，
              只写"更新"用户不知道点一下会做什么。
            -->
            <button
              :disabled="!canUpdate || props.updating"
              :title="updateTitle"
              @click="pick('update')"
            >
              {{ props.updating ? '更新中…' : '一键更新' }}
            </button>
            <!--
              切换运行时版本（用户要求：「加入版本识别，支持高版本覆盖低版本
              且保留数据和配置的覆盖更新」）。

              这个架构里实例只持有 instance.json 里的一个 tag 指针，
              运行时目录是共享的，实例数据在自己的目录里 ——
              所以换版本天然保留数据，切换本身很轻。
            -->
            <button @click="pick('version')">换个版本</button>
            <!--
              两种类型都能重置了。原来这里用 v-if 只给 AstrBot，
              理由是「NapCat 的 token 由启动器固定注入、没有重置这回事」——
              那个前提已经不成立：启动器现在不再覆盖用户改过的 token，
              所以 token 归用户管，改乱了就得能重置回去。
            -->
            <button @click="pick('reset')">重置{{ credWord }}</button>
            <!--
              备份和「换新版本」按用户要求去掉了（「意义不大」）。
              备份还常出问题（停止时秒备份、出来是 0MB、回滚留下满地
              .deleted- 残骸），留着只会误导，不如先撤掉入口。
            -->
            <button class="danger" @click="pick('del')">删掉这个实例</button>
          </div>
        </Transition>
      </div>
    </div>
  </article>
</template>

<style scoped>
.card {
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--hairline);
  padding: 18px 14px;
  position: relative;
  cursor: default;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(180px, 1fr) auto;
  /*
   * ★ 两列之间**必须有间距**（之前完全没有）。
   *
   * 原来只有 `align-items: center`，没有 gap —— 于是第一列的内容
   *（名字/徽章/版本）一旦顶到列的右边缘，就会**紧贴**第二列的按钮，
   * 中间连一个像素都不留。截图里版本号几乎粘在「启动」上就是这个原因。
   *
   * 22px 是让"信息区"和"操作区"在视觉上分开一档的最小值：
   * 再小仍然像连在一起，再大在窄屏上会把信息区压得太紧。
   */
  column-gap: 22px;
  align-items: center;
  transition: background 0.14s ease;
}
.card:hover {
  background: var(--primary-soft);
}
header {
  display: flex;
  align-items: center;
  gap: 10px;
  /*
   * ★ header 自己**不伸缩**（`justify-self: start` + 让内容决定宽度）。
   *
   * 这是"版本号贴到按钮上"的真正原因：header 是 grid 第一列
   *（`minmax(180px, 1fr)`），在宽屏上这一列会被拉得很宽；
   * 而 header 默认 `justify-self: stretch`，于是它的盒子占满整列，
   * 内部又有个 `flex:1` 的名字在吃剩余空间 —— 徽章和版本就被顶到
   * **列的右边缘**，那里紧挨着「启动」按钮。
   *
   * 改成 `justify-self: start`：header 只占内容需要的宽度，
   * 于是"名字 徽章 版本"三件挨在一起（左对齐），
   * 与右侧按钮之间留出的是**列宽剩余的自然空白**。
   */
  justify-self: start;
  /* 名字很长时不要把按钮挤走：给 header 一个上限 */
  max-width: 100%;
  min-width: 0;
}
h3 {
  margin: 0;
  font-size: 15.5px;
  /*
   * ★ 名字**不再吃剩余空间**（`flex: 0 1 auto`）。
   *
   * 早先写成 `flex: 1 1 auto`（"唯一可伸缩项"）—— 那个思路用于
   * "名字要在固定宽度里省略"，但副作用是**它会把徽章和版本顶到右边缘**。
   * 现在 header 已经不伸缩了，名字只需"太长时能收缩"：
   * 允许收缩（`flex-shrink: 1`）、不允许增长（`flex-grow: 0`）。
   *
   * `min-width: 0` 仍是省略号生效的前提（flex item 默认 min-width:auto）。
   */
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.badge {
  /*
   * `flex: none` —— 与 `.ver` 一样不可伸缩。
   *
   * 名字那一项是可伸缩的（见 h3），它会把剩余空间吃光；
   * 但**只有**明确 `flex: none` 的项才保证不被压缩 ——
   * flex item 默认是 `flex: 0 1 auto`（允许收缩），
   * 于是名字很长时徽章会被压扁（文字换行/溢出）。
   */
  flex: none;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 11px;
  background: var(--primary-soft);
  color: var(--primary-deep);
}
/*
 * 版本标：跟在**类型徽章**后面（而不是推到 header 最右侧）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 为什么改（主人 2026-10-08 截图反馈：「版本显示的位置怪怪的」）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 原来这里有 `margin-left: auto`，把版本推到了 header 的最右端 ——
 * 而 header 只是 grid 的第一列，它的右边缘**紧挨着「启动/停止」按钮**。
 *
 * 于是视觉上：
 *
 *     NapCat 实例    [NapCat]              v4.18.33   [启动] [WebUI]
 *     ↑ 名字与徽章                     ↑ 飘在这  ↑ 按钮
 *
 * 那枚版本号孤零零贴在按钮左边，读起来像按钮的附属标签
 *（"启动 v4.18.33"？），而不是"这个实例跑的是哪个版本"。
 *
 * 现在它紧跟在类型徽章后面，和名字、类型连成一组：
 *
 *     NapCat 实例    [NapCat] [v4.18.33]            [启动] [WebUI]
 *
 * 语义上也更对：**版本是对这个实例的补充说明**，不是与操作有关的东西，
 * 所以它该挨着"这是什么实例"那一组，而不是挨着"能对它做什么"那一组。
 */
.ver {
  flex: none;
  font: 11px/1 'JetBrains Mono', Consolas, monospace;
  color: var(--ink-soft);
  background: var(--card-n);
  border: 1px solid var(--hairline);
  border-radius: 999px;
  padding: 3px 8px;
  letter-spacing: 0.02em;
}
.status {
  font-size: 12.5px;
  color: var(--ink);
  margin: 8px 0 0;
  display: flex;
  align-items: center;
  gap: 7px;
  grid-column: 1;
}
.muted {
  color: var(--ink-soft);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--ink-soft);
}
/*
 * 这两行原来写的是 var(--ok) —— 但 tokens.css 里**没有** --ok 这个变量，
 * 背景会失效成透明：运行中的实例看不到绿点，状态指示等于没有。
 * 项目里表示「活着/正常」的绿是 --mint（与 --ribbon-run 同色 #34a67c）。
 */
.dot.running { background: var(--mint); }
.dot.starting { background: var(--primary); }
.dot.error { background: var(--ribbon-error); }
.res {
  font-size: 12px;
  color: var(--ink-soft);
  margin: 4px 0 0;
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: 0;
  align-items: center;
  grid-column: 2;
  grid-row: 1 / span 2;
}
.main {
  border: none;
  border-radius: var(--radius-ctrl);
  padding: 8px 18px;
  font-size: 13px;
  color: #fff;
  background: var(--primary);
}
.main:disabled {
  /*
   * ## 原来这里是 `opacity: 0.45`，白字被吃掉看不见
   *
   * UI 审计实算：全局 `button:disabled { opacity: .55 }`（tokens.css:183）
   * 和这里的 `.45` 会**相乘**（0.55 × 0.45 ≈ 0.25），
   * 白字落在主色底上最终对比度约 1.4:1 —— AA 要 4.5。
   * 「启动」按钮禁用是常态（实例没运行时、正在启动中都会禁用），
   * 所以用户经常看到的是一个几乎空白的按钮。
   *
   * 修法同 CreateWizard：换成够深的底 + 抵消全局 opacity。
   * 实测白字 on #5f759c = 4.66 ✔ 达标。
   */
  background: #5f759c;
  opacity: 1;
  cursor: not-allowed;
}
.ghost {
  border: 1px solid var(--hairline);
  background: #fff;
  border-radius: var(--radius-ctrl);
  padding: 8px 14px;
  font-size: 13px;
  color: var(--ink-soft);
  display: block;
}
.ghost.ready {
  color: var(--primary-deep);
}
.morewrap {
  position: relative;
  margin-left: auto;
}
.more {
  padding: 8px 12px;
}
.menu {
  position: absolute;
  right: 0;
  /* 向下展开（贴着按钮下沿），不要往上顶 */
  top: calc(100% + 6px);
  bottom: auto;
  min-width: 148px;
  background: #fff;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-ctrl);
  box-shadow: 0 10px 26px rgba(20, 24, 34, 0.14);
  padding: 6px;
  z-index: 20;
}
.menu button {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--ink);
  font-size: 13px;
}
.menu button:hover {
  background: var(--primary-soft);
}
.menu .danger {
  color: var(--danger);
}
.menu .danger:hover {
  background: color-mix(in srgb, var(--danger) 8%, transparent);
}
.menupop-enter-active {
  transition: opacity 0.14s ease, transform 0.14s ease;
}
@media (max-width: 720px) {
  .card {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
  .actions {
    grid-column: 1;
    grid-row: auto;
    flex-wrap: wrap;
  }
}
.menupop-leave-active {
  transition: opacity 0.1s ease;
}
.menupop-enter-from,
.menupop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
