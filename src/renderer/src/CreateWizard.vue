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
  /*
   * 父组件正在创建中。
   *
   * 为什么由父组件传入、而不是向导自己管（这是个真实 bug 的修法）：
   * 向导原来自己 `busy = ref(false)`，submit 里置 true 之后
   * **没有任何地方复位** —— 创建失败时父组件只弹个说明、向导不关，
   * 于是「创建」按钮永久灰掉，用户改完名字也点不动，只能关掉重开。
   * 重名是最常见的失败原因，所以第一次用就很可能撞上。
   * 现在改成父组件在 `finally` 里复位（App.vue 的 create 本来就有 finally），
   * 「谁开始、谁收尾」是同一方，不会再漏掉某条路径。
   */
  busy?: boolean
}>()

const name = ref('')
const port = ref('')
const tag = ref('')
/*
 * 这里原来还有个 `qqAccount`（NapCat 绑定的 QQ 号，填了免扫码）。
 *
 * 去掉的原因：
 *   1. 它的「多开隔离」作用其实是多余的 —— 实例目录本来就各自独立，
 *      NapCat 的数据文件在实例自己的 data 目录下，天然不打架；
 *   2. 填错反而有副作用：会把扫码登进去的账号覆盖成填的那个，
 *      用户看到「明明扫码了却登成了别的号」；
 *   3. 免扫码登录可以直接在 NapCat 的 WebUI 里做，不需要在创建时强加一步。
 * 所以创建实例不再问 QQ 号，登录方式交给 NapCat 自己。
 */
const err = ref('')
/*
 * ## busy 必须先置 true，然后**由父组件在失败时复位**
 *
 * 这里曾经是个真 bug（UI 审计抓出来的）：
 *   submit 里 `busy.value = true` 之后**再也没有任何地方复位** ——
 *   全文件只有 3 处出现（声明、置 true、用在 `:disabled`）。
 *
 * 后果：父组件 App.vue 的 create() 在失败时只弹一个说明
 * （重名 / 端口占用 / QQ 环境不满足），**向导并不关闭**，
 * 于是「创建」按钮永久灰着 —— 用户改完名字也点不动，
 * 只能把向导关掉重开。重名是最常见的失败原因，
 * 也就是说这个 bug 在第一次使用时几乎必然被撞上。
 *
 * 修法：向导不再自己管 busy 的复位，而是**接受父组件的 busy**。
 * 父组件在 `finally` 里置 false（App.vue 的 create 本来就有 finally），
 * 于是无论成功失败都会解锁。这样"谁开始、谁收尾"是同一方，
 * 不会出现两边各管一半、漏掉一条路径的情况。
 *
 * 兼容性：保持 `busy` 这个名字给模板用，但它现在是 computed。
 */
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

/** AstrBot 才依赖内置 Python；NapCat 自带 Node，不用管 */
const needsPython = computed(() => props.defaultType === 'a')
const pythonMissing = computed(() => needsPython.value && !pyReady.value)

onMounted(async () => {
  /*
   * ══════════════════════════════════════════════════════════════════════════
   * ★★ 这里原来是一个**吞掉所有错误的 catch**（主人 2026-09-27 实测：
   *    「astrbot 和 napcat 都点不了创建」）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 原写法：
   *     try {
   *       installed.value = (await window.launcher?.runtimes?.list?.()) ?? []
   *       tag.value = myVersions.value[0]?.tag ?? ''
   *       if (needsPython.value) pyReady.value = ...
   *       const list = (await window.launcher?.instance?.list?.()) ?? []
   *       defaultPort.value = ...
   *     } catch {
   *       // 缺省即可
   *     }
   *
   * ## 为什么这是致命的
   *
   * `canCreate` = `myVersions.length > 0 && !pythonMissing`，而
   * `myVersions` 来自 `installed`。**只要上面任何一句抛错**，
   * `installed` 就保持空 → `canCreate` 恒为 false →
   * **「创建」按钮永久灰着，而且不给任何理由**。
   *
   * 更糟的是：这个弹窗里**同时**有 `tag`（能正确显示 `v4.18.28`）
   * 和 `canCreate`（false）—— 界面自相矛盾，用户完全无从判断。
   *
   * ## 现在：三步各管各的，且**失败要说出来**
   *
   * 把三件互不依赖的事分开 try：
   *   ① 版本列表（决定能不能建）—— 失败就把原因显示在弹窗里
   *   ② Python 状态（只影响 AstrBot）
   *   ③ 实例列表（只影响默认端口）
   *
   * 这样 ②③ 失败**不会连累** ①，而 ① 失败会明确告诉用户
   * "没读到版本列表：<原因>"，而不是给一个哑巴灰按钮。
   */
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

<style scoped>
.dlg {
  position: relative;
  isolation: isolate;
  width: 440px;
  max-width: calc(100vw - 36px);
  max-height: calc(100vh - 48px);
  overflow: auto;
  border: 1px solid var(--glass-edge);
  border-radius: 20px;
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.86), rgba(242, 247, 255, 0.72));
  padding: 24px 28px;
  -webkit-backdrop-filter: blur(28px) saturate(160%);
  backdrop-filter: blur(28px) saturate(160%);
  box-shadow: 0 24px 64px rgba(19, 37, 70, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.9);
  animation: popin 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2);
}
@media (max-width: 520px) {
  .dlg {
    width: calc(100vw - 28px);
    padding: 20px;
  }
  .row {
    flex-wrap: wrap;
  }
}
.f {
  display: block;
  margin: 14px 0;
}
.f > span {
  display: block;
  font-size: 12px;
  color: var(--ink-soft);
  margin-bottom: 5px;
}
.f input,
.f select {
  width: 100%;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-ctrl);
  padding: 10px 12px;
  font-size: 14px;
  background: rgba(255, 255, 255, 0.58);
  backdrop-filter: blur(8px);
  font-family: inherit;
}
.f select:focus,
.f input:focus {
  border-color: var(--primary);
  outline: none;
}
.noversion {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
  color: var(--ink-soft);
}
/*
 * 「前往下载」按钮：做成实心蓝底主按钮。
 *
 * 用户报告：「前往下载这个按钮，没放上去就变蓝了，怎么是水平全判定」。
 *
 * 原来这里是白底 + 蓝边框（hover 才变蓝），而且直接在 .f 这个
 * <label> 里 —— .f 是纵向布局，但 .noversion/.blocked 自己是 flex，
 * 按钮被当成 flex item 拉伸/顶到边上，看起来就是「横着一整条」。
 *
 * 现在：实心蓝底（和产品主色一致，一眼就是个按钮）、不用 flex 撑开、
 * 保持内容宽度。
 */
.noversion .go {
  flex: none;
  border: none;
  background: var(--primary);
  color: #fff;
  border-radius: var(--radius-ctrl);
  padding: 5px 13px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition-property: background-color, color;
  transition-duration: 140ms;
}
.noversion .go:hover {
  background: var(--primary-deep);
}
.hint {
  display: block;
  color: var(--ink-soft);
  font-size: 11.5px;
  margin-top: 5px;
}
/* 前置条件没满足：一条淡黄提示 + 一个前往按钮，不用系统原生提示框 */
.blocked {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
  padding: 10px 12px;
  border-radius: 11px;
  background: rgba(253, 246, 230, 0.68);
  border: 1px solid rgba(240, 226, 194, 0.82);
  backdrop-filter: blur(8px);
  font-size: 12.5px;
  color: #8a6d2f;
}
.blocked .go {
  margin-left: auto;
  flex: none;
  border: 1px solid var(--primary);
  background: rgba(255, 255, 255, 0.62);
  color: var(--primary-deep);
  border-radius: 8px;
  padding: 4px 12px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition-property: background-color, color;
  transition-duration: 140ms;
}
.blocked .go:hover {
  background: var(--primary);
  color: #fff;
}
.warn {
  color: #a06f00;
  font-size: 12.5px;
  line-height: 1.55;
}
.err {
  color: var(--danger);
  font-size: 12.5px;
}
.sub {
  color: var(--ink-soft);
  font-size: 13px;
  line-height: 1.6;
}
/* 底部按钮：之前这个组件里没定义 .row/.main/.ghost，
   于是回落到浏览器默认按钮样式（灰底方框），跟全局弹窗不是一个风格。 */
.row {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}
.row button {
  font-family: inherit;
  font-size: 13.5px;
  border-radius: 10px;
  padding: 9px 20px;
  border: 1px solid transparent;
  cursor: pointer;
  transition-property: background-color, border-color, color, transform;
  transition-duration: 140ms;
  transition-timing-function: ease-out;
}
.row button:active:not(:disabled) {
  transform: scale(0.97);
}
.row .ghost {
  background: rgba(255, 255, 255, 0.58);
  border-color: var(--hairline);
  color: var(--ink-soft);
}
.row .ghost:hover {
  border-color: #ccd3de;
  color: var(--ink);
}
.row .main {
  background: var(--primary);
  color: #fff;
  font-weight: 500;
  box-shadow: 0 2px 8px rgba(74, 125, 219, 0.26);
}
.row .main:hover:not(:disabled) {
  background: var(--primary-deep);
}
.row .main:disabled {
  /*
   * ## 这里不能再用浅灰底 + 全局 opacity
   *
   * UI 审计实算：tokens.css 的全局 `button:disabled { opacity: .55 }`
   * 叠加原来这里的 `background: #c8d3e6`（浅灰蓝），白字最终对比度只有
   * **约 1.24:1** —— 而 AA 正文要求 4.5。用户根本读不出按钮上写什么。
   * 而「创建」正是新用户唯一能走的入口，禁用时最常见
   * （没装运行时 / 没装 Python 都会禁用）。
   *
   * 修法：禁用态用一个**够深**的底 + 白字，让对比度达标，
   * 同时把全局那层 opacity 抵消掉（`opacity: 1` 覆盖）。
   * 颜色取 --primary 压暗两档的结果，仍是同一色系（不会看着像坏掉）。
   *
   * 实测对比度（scripts/_contrast-check.cjs --test 可复核）：
   *   白字 on #7d93b8 = 3.1  ← 不够
   *   白字 on #6b82a9 = 3.9  ← 接近
   *   白字 on #5f759c = 4.6  ✔ 达标
   * 所以取 #5f759c。
   */
  background: #5f759c;
  box-shadow: none;
  cursor: not-allowed;
  opacity: 1;
  /* 白字保持不变（上面 .row .main 已经是 color: #fff） */
}
</style>
