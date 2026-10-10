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

    updating?: boolean
    /** 正在启动/停止：按钮文字跟着变，用户知道点了有反应 */
    switching?: 'starting' | 'stopping' | null
    webuiOpen?: boolean
    webuiBusy?: boolean

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


const canUpdate = computed(
  () =>
    !props.busy &&
    props.tplReady &&
    props.inst.status !== 'running' &&
    props.inst.status !== 'starting' &&
    props.inst.status !== 'stopping'
)


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
  switch (k) {
    case 'log': emit('log'); break
    case 'reset': emit('reset'); break
    case 'del': emit('del'); break
    case 'version': emit('version'); break
    case 'update': emit('update'); break
  }
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

<style scoped src="./styles/InstanceCard.css"></style>
