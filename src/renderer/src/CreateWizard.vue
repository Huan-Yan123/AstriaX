<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

const emit = defineEmits<{
  close: []
  create: [p: { type: 'a' | 'n'; name: string; port?: number; tag?: string }]
  /** 点「前往下载」：关掉向导并跳到下载页 */
  goto: [page: 'download']
}>()

// 页面已按 AstrBot / NapCat 分家——向导只服务当前页，不提供类型切换
const props = defineProps<{
  defaultType: 'a' | 'n'

  busy?: boolean
}>()

const name = ref('')
const port = ref('')
const tag = ref('')

const err = ref('')

const defaultPort = ref<number | null>(null)
const installed = ref<Array<{ type: 'a' | 'n'; tag: string; sizeMB?: number }>>([])
/** AstrBot 必须有内置 Python 才跑得起来（没装就是创建了也起不来） */
const pyReady = ref(true)
/**
 * 读版本列表失败的原因（空 = 没失败）。
 *
 * 为什么要单独一个：原来那个 catch 把错误全吞了，用户看到的是
 * "创建按钮灰着、没有任何解释"（主人实测就是这个问题）。
 * 现在读不到版本列表会**明说原因**。
 */
const loadErr = ref('')

declare const window: {
  launcher?: {
    instance?: { list?: () => Promise<Array<{ id: string; type: 'a' | 'n'; port: number }>> }
    runtimes?: { list?: () => Promise<Array<{ type: 'a' | 'n'; tag: string; sizeMB?: number }>> }
    python?: { status?: () => Promise<{ ready?: boolean }> }
  }
}

/** 当前类型已下载的版本（新版本在前，仓库层已排好序） */
const myVersions = computed(() => installed.value.filter((v) => v.type === props.defaultType))

/** AstrBot 依赖内置 Python；NapCat 的运行方式由上游 QQ 集成适配处理。 */
const needsPython = computed(() => props.defaultType === 'a')
const pythonMissing = computed(() => needsPython.value && !pyReady.value)

onMounted(async () => {

  try {
    installed.value = (await window.launcher?.runtimes?.list?.()) ?? []
  } catch (e) {
    /*
     * 读不到版本列表 = 一定建不了实例。必须**显式告知**，
     * 否则用户面对的就是"按钮灰着、没有任何解释"。
     */
    loadErr.value = `没读到已安装的版本：${e instanceof Error ? e.message : String(e)}`
  }
  /* 默认选最新装好的那个版本 */
  tag.value = myVersions.value[0]?.tag ?? ''

  if (needsPython.value) {
    try {
      pyReady.value = (await window.launcher?.python?.status?.())?.ready === true
    } catch {
      /* 读不到就当没装（保守）—— 但下面 canCreate 会因此禁用并给出提示 */
      pyReady.value = false
    }
  }

  try {
    const list = (await window.launcher?.instance?.list?.()) ?? []
    const same = list.filter((x) => x.type === props.defaultType)
    defaultPort.value = same.length
      ? Math.max(...same.map((x) => x.port)) + 1
      : props.defaultType === 'a'
        ? 6100
        : 6200
  } catch {
    /* 读不到实例列表只影响"默认端口"这个便利项，用兜底值即可 */
    defaultPort.value = props.defaultType === 'a' ? 6100 : 6200
  }
})

/** 没装任何版本就不让创建——否则建出来是个跑不起来的空壳 */
const canCreate = computed(() => myVersions.value.length > 0 && !pythonMissing.value)
/*
 * 名字留空就用默认名。
 *
 * placeholder 只给一个**示例**（形如 `AstrBot 实例`），不再写「（留空自动取这个）」
 * 那种解释性废话 —— 用户明确要求去掉。留空会自动命名这件事，
 * 字段标签上的「名字（可留空）」已经说清楚了。
 */
const nameHint = computed(() => `${props.defaultType === 'a' ? 'AstrBot' : 'NapCat'} 实例`)

function submit(): void {
  if (pythonMissing.value) {
    err.value = 'AstrBot 需要先安装 Python 才能运行哦，请到「下载」页安装呀。'
    return
  }
  if (!myVersions.value.length) {
    err.value = '该类型尚未下载任何版本，请先到「下载」页安装一个版本哦。'
    return
  }
  err.value = ''
  /*
   * 这里**不再** `busy.value = true`。
   *
   * busy 现在由父组件拥有（见 defineProps 的说明）：
   * App.vue 的 create() 一开始就置 true，并在 `finally` 里置 false，
   * 成功失败都会解锁。向导只负责发起，不负责收尾 ——
   * 这样"创建失败后按钮永久灰掉"那条路径从结构上就不存在了。
   */
  emit('create', {
    type: props.defaultType,
    name: name.value.trim(),
    port: port.value ? Number(port.value) : undefined,
    tag: tag.value
  })
}

/** 去下载页（先关掉向导） */
function goDownload(): void {
  emit('close')
  emit('goto', 'download')
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dlg">
      <h2>新建 {{ defaultType === 'a' ? 'AstrBot' : 'NapCat' }} 实例呀</h2>
      <p class="sub">每个实例都有一份完全独立的运行环境哦，名字得全仓库唯一（AstrBot 和 NapCat 之间也不能重名）。</p>

      <label class="f">
        <span>实例名（可以留空）</span>
        <input v-model="name" type="text" :placeholder="nameHint" @keyup.enter="submit" />
      </label>

      <label class="f">
        <span>选个版本</span>
        <select v-if="myVersions.length" v-model="tag">
          <option v-for="v in myVersions" :key="v.tag" :value="v.tag">
            {{ v.tag }}<template v-if="v.sizeMB"> · {{ v.sizeMB }} MB</template>
          </option>
        </select>
        <div v-else class="noversion">
          <span>还没有下载任何版本呢，要先装一个版本才能创建实例哦</span>
          <button class="go" type="button" @click="goDownload">去下载页</button>
        </div>
      </label>

      <label class="f">
        <span>WebUI 端口</span>
        <!--
          placeholder 只留默认值本身。
          原来写的是 `默认 6100（同类末端口 +1，可以改哦）`——
          括号里那句是**实现细节**（怎么算出这个默认值的），
          用户既不需要知道、也不该在主流程里读到它。
          （同一行的下面那条注释记着：用户此前也要求去掉过"范围 6100-6199"那句，
            理由是"占用了顺延是程序自己的事"。这次是同一类。）
        -->
        <input v-model="port" type="number" :placeholder="defaultPort ? `默认 ${defaultPort}` : '默认自动分配呀'" min="1025" max="65535" @keyup.enter="submit" />
        <!--
          这里原来有一行「范围 6100-6199，被占了会自动顺延。」
          用户明确要求去掉：占用了顺延是程序自己的事，不用写在界面上教用户。
        -->
      </label>

      <!--
        这里原来有个「QQ 号」输入框（填了免扫码登录）。
        去掉了：NapCat 的多开数据隔离本来就在实例目录层面做掉了，
        而那个字段填错反而会让用户以为必须填、或者覆盖掉扫码登录的账号。
        登录方式交给 NapCat 自己的 WebUI 处理。
      -->

      <!-- AstrBot 缺 Python：这是跑不起来的前置条件，必须先拦住 -->
      <div v-if="pythonMissing" class="blocked">
        <span>AstrBot 需要先安装 Python 才能运行呢</span>
        <button class="go" type="button" @click="goDownload">去下载页</button>
      </div>

      <p v-else-if="!myVersions.length" class="warn">请先到「下载」页安装一个 {{ defaultType === 'a' ? 'AstrBot' : 'NapCat' }} 版本，回来就能创建啦。</p>

      <!--
        读版本列表失败时**明说原因**。
        原来这种情况什么都不显示，用户只看到一个灰着的「创建」按钮
        （主人实测：「astrbot 和 napcat 都点不了创建」）。
      -->
      <p v-if="loadErr" class="err">{{ loadErr }}</p>

      <p v-if="err" class="err">{{ err }}</p>

      <div class="row">
        <button class="ghost" @click="emit('close')">先不建了</button>
        <!--
          ★ 按钮为什么禁用 —— **必须能问出原因**
            （主人 2026-09-27：「astrbot 和 napcat 都点不了创建」，
              而鼠标悬停只有"禁用标志"、看不到任何理由）

          原来的 title 只在 `!canCreate` 时给文字，而 `busy` 为 true 时
          `canCreate` 仍可能是 true → **title 是空的** → 用户面对一个
          灰按钮，完全不知道在等什么、要等多久。

          现在四种情况分别说清，并且 `busy` 那条明确告诉他"正在创建中"。
        -->
        <button
          class="main"
          :disabled="busy || !canCreate"
          :title="busy ? '正在创建中，等它一下呀' : canCreate ? '' : pythonMissing ? '得先安装 Python 哦' : loadErr ? loadErr : '得先下载一个版本哦'"
          @click="submit"
        >
          {{ busy ? '创建中…' : '创建' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped src="./styles/CreateWizard.css"></style>
