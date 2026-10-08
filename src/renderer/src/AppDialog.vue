<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'

export interface DialogButton {
  text: string
  kind?: 'main' | 'ghost' | 'danger'
  value: unknown
  /**
   * 这个按钮需要先把 requireText 打对才放行（删除确认的「永久删除」）。
   *
   * 为什么要按**按钮**分，而不是弹窗整体一刀切：
   * 见 pick() 的注释 —— 原来对每个按钮都校验，导致点「取消」也弹「名字不一致」。
   */
  needsText?: boolean
  /**
   * ★ 这是"当前正在用的那个"（主人 2026-09-27 的界面评审提出）。
   *
   * 场景：「换个版本」的候选列表里，用户当前用的那个版本要**一眼认出来**。
   * 原来只是把「（当前）」拼进按钮文字，而所有按钮都是同一种实心蓝 ——
   * 十几个蓝块糊成一片，看不出哪个是"现在这个"。
   *
   * 有了这个标记，界面可以：
   *   · 给它一个勾与选中态底色
   *   · 其余项用**描边**而不是实心（一眼分层：一个选中 + 一堆可选项）
   */
  current?: boolean
}

const props = defineProps<{
  open: boolean
  title: string
  body?: string
  buttons?: DialogButton[]
  /** 有输入框时（删除确认那种）用 */
  requireText?: string
  inputPlaceholder?: string
  error?: string
  /**
   * 把带有 `current` 标记的那组按钮**按列表渲染**（换版本那种多选项）。
   *
   * 为什么用显式开关而不是"按钮数 > N 就当列表"：
   * 数量是启发式，4 个动作按钮（保存/另存/取消/删除）会被误判成选项列表。
   * 调用方最清楚"这一组是不是同类选项"，所以由它说。
   */
  choiceList?: boolean
}>()

/**
 * 选项列表里的按钮（当 choiceList 为真时）。
 *
 * 约定：**取消类按钮（value 为 null/false）不算选项**，它们走底部操作行。
 */
const choiceList = computed<DialogButton[]>(() => {
  if (!props.choiceList) return []
  const all = props.buttons ?? []
  return all.filter((b) => b.value !== null && b.value !== false)
})

/** 底部操作行：取消 / 不选 这类"非选项"动作 */
const actionButtons = computed<DialogButton[]>(() => {
  const all = props.buttons ?? []
  if (!props.choiceList) {
    return all.length ? all : [{ text: '知道啦', kind: 'main', value: true }]
  }
  const rest = all.filter((b) => b.value === null || b.value === false)
  /* 兜底：万一调用方没给取消按钮，也要有一个能退出的 */
  return rest.length ? rest : [{ text: '取消', kind: 'ghost', value: null }]
})

/**
 * 折叠选择器是否展开。
 *
 * 默认**收起**（主人 2026-09-27：「为什么不是折叠列表」）——
 * 12 个版本直接铺开要占大半屏、还要挂滚动条，
 * 而"选一个版本"这件事本身不需要那么多视觉面积。
 */
const pickerOpen = ref(false)

/**
 * 折叠选择器里**已选中**的那个值（还没提交）。
 *
 * ★ 它与 `current` 标记是两件事（主人追问「为什么没有确认按钮」时理清的）：
 *   · `current`  = **现在正在用的**（后端状态）
 *   · `selected` = **用户点选的、待确认的**（界面状态）
 * 原来点一下就直接提交（selected 和提交是同一个动作），
 * 于是"选一个版本"和"执行切换"没有分开 —— 而切换会停实例、换运行时、重启，
 * 是个有副作用的操作，必须有确认这一步。
 */
const selectedValue = ref<unknown>(undefined)

/**
 * 收起态显示哪个：**已选中的**（没有选中时退回当前用的那个）。
 *
 * 这样收起时用户也能看到"我准备好了要换成 X" —— 与系统下拉框一致。
 */
const pickedLabel = computed<string>(() => {
  const list = choiceList.value
  if (!list.length) return ''
  const hit =
    list.find((b) => b.value === selectedValue.value) ?? list.find((b) => b.current) ?? list[0]
  return hit.text
})

/** 点一项：只**选中**（并收起列表，像下拉框那样），不提交 */
function selectOption(b: DialogButton): void {
  selectedValue.value = b.value
  pickerOpen.value = false
}

/** 能不能点「切换」：选了、而且不是当前那个 */
const canConfirm = computed<boolean>(() => {
  if (selectedValue.value === undefined) return false
  const hit = choiceList.value.find((b) => b.value === selectedValue.value)
  return Boolean(hit) && !hit?.current
})

/** 不能确认时给一句人话（灰按钮旁边没解释等于没说） */
const confirmHint = computed<string>(() => {
  if (selectedValue.value === undefined) return '先在上面选一个版本'
  const hit = choiceList.value.find((b) => b.value === selectedValue.value)
  if (hit?.current) return '选的就是当前在用的版本，不用切换'
  return '确认切换到这个版本'
})

/** 提交选中项（走与普通按钮完全相同的出口，上层无需区分） */
function confirmChoice(): void {
  if (!canConfirm.value) return
  const hit = choiceList.value.find((b) => b.value === selectedValue.value)
  if (hit) pick(hit)
}

/*
 * 每次弹窗重新打开都**复位**：收起、清空选中。
 *
 * 不复位的话：用户这次点开又关掉、下次打开时会保持着上次的展开态与选中项 ——
 * 而"展开/选中"都是**临时的交互动作**，不该跨弹窗存活
 *（用户会觉得"怎么一打开就是一大片，而且还替我选好了"）。
 */
watch(
  () => props.open,
  (v) => {
    if (v) {
      pickerOpen.value = false
      selectedValue.value = undefined
    }
  }
)

const emit = defineEmits<{ pick: [value: unknown]; close: [] }>()

const text = ref('')

watch(
  () => props.open,
  (v) => {
    if (v) text.value = ''
  }
)

/*
 * ════════════════════════════════════════════════════════════════════
 * ★ 遮罩点击 / Esc：必须按「取消」结算，不能只是关掉
 * ════════════════════════════════════════════════════════════════════
 *
 * ## 为什么（四厂商审计确认的高危 + 它的开发体验成因）
 *
 * 主界面的确认类弹窗有两类消费者：
 *
 *   · **promise 型**（App.vue 的 choose / chooseOne）：弹窗是要答复的 ——
 *     `onPick` 是 promise 唯一的 resolve 入口。
 *     原来点遮罩只 `emit('close')` → 上层把 dlg 清空、弹窗消失，
 *     但那个 Promise **永远不 resolve** —— 等它的调用方整段吊死：
 *     `busy` 不复位、按钮灰着、用户必须重启软件。
 *     一个 0.5px 的 UX 细节（点空白处关闭）背后是功能级的死锁。
 *
 *   · **回调型**（删除确认这类）：`@close="dlg=null"` 就够 —— 没有等待者。
 *
 * ## 修法（一处修，所有宿主受益）
 *
 * 点遮罩/按 Esc 时，在弹窗**内部**模拟点「取消类按钮」：
 * 走 pick() → emit 该按钮的 value → 上层 onResolve/cb 按取消结算
 *（choose 得 false、chooseOne 得 null、删除确认得「不动」）→ 一切正常收尾。
 *
 * 找「取消类」的判据：**value 是假值**的那个按钮（ghost/取消天生 value
 * 为 false/null）。找不到（纯告知型，比如只有一个「知道啦」）才退回
 * 原来的纯关闭 —— 那种弹窗没有等待者，关掉即是答复。
 *
 * Esc 走同一路径（指导书「崩溃恢复要友好 / 操作可取消」的基本盘）：
 * window 级监听、open 时才生效，卸载时记得拆 —— 别让监听泄漏。
 */
function cancelLikeButton(): DialogButton | undefined {
  return (props.buttons ?? []).find((b) => !b.value)
}

function dismissViaCancel(): void {
  const cancel = cancelLikeButton()
  if (cancel) {
    pick(cancel)
    return
  }
  emit('close')
}

function onKeydown(e: KeyboardEvent): void {
  if (!props.open) return
  if (e.key === 'Escape') {
    /*
     * Esc 不再触发 input 的任何怪行为：先挡默认（输入框焦点下 Esc 也安全），
     * 再走与遮罩点击完全相同的取消路径。
     */
    e.preventDefault()
    dismissViaCancel()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

/**
 * 点某个按钮。
 *
 * ## 这里原来有两个 bug，其中一个会**删掉用户的数据**
 *
 * 用户报告：
 *   1. 「为什么我点取消都弹名字没输对」
 *   2. 「而且输入名字点取消，也成功删除了」
 *
 * 旧代码：
 *
 *     if (props.requireText && text.value.trim() !== props.requireText) {
 *       emit('pick', { __invalid: true }); return
 *     }
 *     emit('pick', props.requireText ? { __confirmed: true, text: ... } : b.value)
 *
 * ① **校验没区分按钮**。`requireText` 是弹窗级属性，旧代码对**任何**按钮
 *    都先校验一遍 —— 点「取消」时输入框空的，于是弹「名字不一致」。
 *    取消键必须无条件生效，它本来就不承担「我确认过了」这个语义。
 *
 * ② **放行时把按钮自己的值丢了**。旧代码一校验通过就 emit
 *    `{__confirmed:true, text}`，完全无视 `b.value`。而「取消」的
 *    value 是 `false`，被这个真值对象顶掉之后，上层 `onPick(v)`
 *    收到真值 → 一路走到删除。所以**输入正确名字 + 点取消 = 删除**。
 *    这是数据毁灭级的：用户明确表达了「不要」，实例却被永久删除。
 *
 * ## 现在的语义
 *
 *   - 只有标了 `needsText` 的按钮才校验输入；不匹配 → 报错并**保持弹窗打开**。
 *   - 其余按钮（取消、关闭…）无条件发自己的 `b.value`，永不改写。
 *   - 需要校验的按钮通过后发 `true` —— 上层只看真假，语义清晰。
 *
 * 另外 `requireText` 存在但**没有任何按钮**标 needsText 时，
 * 退回旧行为（对主按钮校验）。这样万一有调用方没标标记，
 * 删除确认依然是安全的（宁可多要一次输入，也不能误删）。
 */
function pick(b: DialogButton): void {
  const buttons = props.buttons ?? []
  // 有 requireText 时，默认把「非取消类」的按钮视为需要校验的那一个。
  // 显式标了 needsText 的以标记为准。
  const needs = b.needsText === true || (props.requireText != null && b.value === true)
  const needsCheck = Boolean(props.requireText) && needs

  if (needsCheck && text.value.trim() !== props.requireText) {
    emit('pick', { __invalid: true })
    return
  }

  /*
   * 注意这里发的是 `b.value`，不是包装对象。
   *
   * 「永久删除」的 value 是 true，取消是 false —— 原样传出去，
   * 上层 onPick 的 `if (!v) return` 才能正确区分。
   * 旧代码发 {__confirmed:true} 正是「点取消也删」的根因。
   */
  emit('pick', b.value)
}

/**
 * 在输入框里按回车。
 *
 * 这里原来是 `find(b => b.kind === 'main') ?? buttons[0]`，对删除确认框是错的：
 * 它的两个按钮是 `ghost`（取消）和 `danger`（永久删除），**没有 main**，
 * 于是回退到 `buttons[0]` —— 正好是「取消」。用户打对了名字按回车，
 * 得到的是「什么都没发生」而不是删除。
 *
 * 正确做法：优先找标了 needsText 的那个（那才是这个弹窗的「主操作」），
 * 其次找 main，最后才退到第一个。
 * 另外回车**永远不该**触发取消类的按钮，所以跳过 value 为假的。
 */
function submit(): void {
  const buttons = props.buttons ?? []
  const target =
    buttons.find((b) => b.needsText === true && Boolean(b.value)) ??
    buttons.find((b) => b.kind === 'main') ??
    buttons.find((b) => b.kind === 'danger') ??
    buttons.find((b) => Boolean(b.value)) ??
    buttons[0]
  if (target) pick(target)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="maskfade">
      <!-- 点遮罩 = 取消（走 dismissViaCancel 的统一结算，见上面的说明） -->
      <div v-if="open" class="mask" @click.self="dismissViaCancel()">
        <Transition name="dlgpop" appear>
          <div class="dlg">
            <h3>{{ title }}</h3>
            <p v-if="body" class="body">{{ body }}</p>

            <!-- 结构化内容（如凭据列表）：统一走同一个弹窗外壳，别再自己搭一套 -->
            <div v-if="$slots.default" class="content">
              <slot />
            </div>

            <label v-if="requireText" class="f">
              <span>输入 <b>{{ requireText }}</b> 来确认哦</span>
              <input v-model="text" type="text" :placeholder="inputPlaceholder ?? ''" @keyup.enter="submit" />
            </label>

            <p v-if="error" class="err">{{ error }}</p>

            <!--
              ══════════════════════════════════════════════════════════════════
              ★★ 按钮区：**两种形态**（主人 2026-09-27 的界面评审）
              ══════════════════════════════════════════════════════════════════

              评审原话：「这个换版本的界面美观吗」——
              当时的样子是：十几个版本按钮**清一色实心蓝**糊成一片、
              「取消」跟它们混在同一排、每行末尾都挂一个一模一样的「28.1 MB」、
              最后一行还落单右对齐。问题不在配色，在**没有层级**。

              所以现在按"选项是不是一组同类内容"分两种渲染：

              · **折叠形态**（`choiceList`）：候选是一组**同类选项**
                （换版本就是这种）。
                  默认**收起**：只显示当前的那个（一行，带下拉箭头）
                  点一下展开：候选铺成列表，选完自动收起
                操作按钮（取消）单独一行放在底部 —— 它不是选项。

              · **按钮形态**（原来的样子）：1-3 个**不同性质**的动作
                （确定/取消、导出/不用了）。这时一排按钮是对的。

              判据用 `choiceList` 而不是"按钮数量多就算列表" ——
              数量是启发式，会误判（比如 4 个动作按钮）。

              ## 为什么是折叠而不是直接铺开（主人 2026-09-27 追问）
              「为什么不是折叠列表」——
              铺开的问题：12 个版本占掉大半屏、底部挂个滚动条、
              信息密度远超"选一个版本"这件事需要的量。
              折叠的收益：默认只占一行，弹窗回到"说清情况 + 一个选择项 +
              两个按钮"的清爽结构；用户要换版本时点开即可。
              这也是系统里"选一项"的通用形态（下拉框），学习成本为零。
            -->
            <div v-if="choiceList.length" class="picker" :class="{ open: pickerOpen }">
              <!-- 收起态：显示**已选中**的那个；点它展开 -->
              <button class="picked" :aria-expanded="pickerOpen" @click="pickerOpen = !pickerOpen">
                <span class="ctext">{{ pickedLabel }}</span>
                <span class="caret" aria-hidden="true">{{ pickerOpen ? '▲' : '▼' }}</span>
              </button>

              <!-- 展开态：候选列表。点一项只是**选中**，不提交 -->
              <Transition name="droplist">
                <div v-if="pickerOpen" class="choices">
                  <button
                    v-for="b in choiceList"
                    :key="b.text"
                    class="choice"
                    :class="{ on: selectedValue === b.value, current: b.current }"
                    @click="selectOption(b)"
                  >
                    <span class="tick" aria-hidden="true">
                      {{ selectedValue === b.value ? '✓' : '' }}
                    </span>
                    <span class="ctext">{{ b.text }}</span>
                    <!--
                      当前生效的那个额外标一个「当前」：
                      选中态（✓）表示"你正要换成这个"，
                      而「当前」表示"现在用的就是这个"—— 两者是**不同**的信息，
                      只在文字里区分最省事，不必再加一套视觉。
                    -->
                    <span v-if="b.current" class="nowtag">当前</span>
                  </button>
                </div>
              </Transition>
            </div>

            <div class="row">
              <!--
                ★ 折叠选择器的确认按钮（主人 2026-09-27：
                  「为什么没有确认按钮」）

                原来点一个版本**立刻切换**了 —— 而切换会
                「停实例 → 换运行时 → 重启」，是有副作用的动作，
                不该点一下就跑。现在：选中只是高亮，点「切换」才执行。
                （这也和系统的下拉框/表单语言一致：选完要提交。）

                禁用条件：没选任何项、或选的就是当前那个 ——
                后者点了等于白跑一趟（后端也会判 changed:false）。
              -->
              <template v-if="choiceList.length">
                <button
                  class="btn main"
                  :disabled="!canConfirm"
                  :title="confirmHint"
                  @click="confirmChoice"
                >
                  切换
                </button>
              </template>
              <button
                v-for="b in actionButtons"
                :key="b.text"
                :class="['btn', b.kind ?? 'ghost']"
                @click="pick(b)"
              >
                {{ b.text }}
              </button>
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
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 80;
  backdrop-filter: blur(10px) saturate(125%);
  -webkit-backdrop-filter: blur(10px) saturate(125%);
}
.dlg {
  width: 380px;
  max-width: calc(100vw - 48px);
  /*
   * ★ 高度上限 + 滚动（审查抓出的真机阻断）
   *
   * 场景：「换个版本」的选项来自源上（AstrBot 走 PyPI，**实测 168 个版本**），
   * 而按钮区是 `v-for` 全量渲染。原来这里没有 max-height / overflow，
   * 于是 169 个按钮把弹窗顶出视口 —— 用户**点不到也关不掉**。
   *
   * 这里加的是通用防御（任何多选项弹窗都受益）：
   *   · 弹窗最多占 80% 视口高
   *   · 主体区超出就滚动
   * 另外调用方（App.vue 的 pickVersion）也会**只列最近 N 个**，
   * 两层一起保证不会再出现"一屏几百个按钮"。
   */
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.86), rgba(242, 247, 255, 0.72));
  border: 1px solid var(--glass-edge);
  backdrop-filter: blur(28px) saturate(160%);
  -webkit-backdrop-filter: blur(28px) saturate(160%);
  border-radius: 20px;
  padding: 22px 24px 18px;
  box-shadow: 0 24px 64px rgba(19, 37, 70, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.9);
}
h3 {
  margin: 0 0 8px;
  font-size: 15.5px;
}
.body {
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
  color: var(--ink-soft);
  white-space: pre-line;
}
.content {
  margin-top: 12px;
}
.f {
  display: block;
  margin-top: 14px;
}
.f span {
  display: block;
  font-size: 12px;
  color: var(--ink-soft);
  margin-bottom: 6px;
}
.f input {
  width: 100%;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-ctrl);
  padding: 9px 12px;
  font-size: 13.5px;
  font-family: inherit;
  background: rgba(255, 255, 255, 0.58);
  backdrop-filter: blur(8px);
  outline: none;
}
.f input:focus {
  border-color: var(--primary);
}
.err {
  color: var(--danger);
  font-size: 12.5px;
  margin: 8px 0 0;
}
.row {
  display: flex;
  justify-content: flex-end;
  /*
   * 选项多的时候要能换行（否则会横向挤出弹窗）
   * —— 配合上面的 max-height + overflow-y，「换版本」那种多选项也能用。
   */
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  /*
   * 按钮区自己也滚动（选项可能在按钮里，如 chooseOne 的多选项）。
   * 放在这里而不是只给 body：chooseOne 的选项就是按钮本身。
   */
  overflow-y: auto;
  max-height: 52vh;
}

/* ══════════════════════════════════════════════════════════════════════════
 * ★★ 折叠选择器（换版本那种多选项）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 界面评审前的样子：十几个版本按钮清一色实心蓝、糊成一片，
 * 「取消」混在同一排，末尾还落单右对齐 —— 看不出哪个是当前版本。
 * 中间版本：铺成列表（一行一项、当前项打勾），但 12 项仍占大半屏。
 * 现在（主人追问「为什么不是折叠列表」）：**默认收起，点开才展开**。
 *
 * 视觉层次靠**形状**而不是颜色堆叠：
 *   收起态 = 一个输入框样子的触发器（系统下拉框的通用语言）
 *   展开态 = 候选列表，当前项打勾 + 浅底，其余是描边
 */
.picker {
  margin-top: 14px;
  position: relative;
}
/* 收起态的触发器：长得像输入框，一眼知道"这里能选" */
.picked {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid var(--hairline);
  background: rgba(255, 255, 255, 0.64);
  color: var(--ink);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition:
    border-color 0.14s ease,
    background-color 0.14s ease;
}
.picked:hover {
  border-color: var(--primary);
}
/* 展开时触发器保持高亮，让"谁被展开了"一目了然 */
.picker.open .picked {
  border-color: var(--primary);
  background: rgba(221, 233, 255, 0.72);
}
.caret {
  flex: 0 0 auto;
  font-size: 9px;
  color: var(--ink-soft);
  line-height: 1;
}
.choices {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  /*
   * 自己滚动：候选可能有几十个（实测 NapCat 源上 30 个版本）。
   * 用 38vh 而不是更大：它是弹窗里的一个**局部**面板，
   * 不该把弹窗撑到接近满屏（那样又回到"一大片"的观感了）。
   */
  max-height: 38vh;
  overflow-y: auto;
  /* 滚动条不占位，避免内容左右跳一下 */
  scrollbar-gutter: stable;
}
.choice {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  /* 左对齐 + 等宽：列表要的是"扫视对齐"，不是"按钮居中" */
  text-align: left;
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid var(--hairline);
  background: rgba(255, 255, 255, 0.56);
  color: var(--ink);
  font-size: 13px;
  font-variant-numeric: tabular-nums; /* 版本号数字等宽，上下对齐 */
  cursor: pointer;
  transition:
    border-color 0.14s ease,
    background-color 0.14s ease;
}
.choice:hover {
  border-color: var(--primary);
  background: rgba(221, 233, 255, 0.72);
}
/*
 * 当前正在用的那个：实底 + 勾。
 * 用主色调的浅色底而不是纯实心蓝 —— 它是"状态标记"，不是"主操作按钮"，
 * 太抢眼会把用户的注意力从"我要选哪个新的"上拉走。
 */
.choice.on {
  border-color: var(--primary);
  background: rgba(210, 227, 255, 0.8);
  color: var(--primary-deep);
  font-weight: 600;
}
/*
 * 当前正在用的那个：浅底 + 边线，与"已选中"（打勾）区分开。
 *
 * 注意这里**不再用 `.choice.on` 表示"当前"** —— 那个类现在表示"已选中待确认"。
 * 两者是不同信息，混用一个样式会让用户分不清
 *「我要换成它」和「现在就是它」。
 */
.choice.current {
  border-color: #cbd6ea;
  background: rgba(242, 247, 255, 0.62);
}
/* 「当前」小标签：只在文字里区分，不另加一套视觉 */
.nowtag {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 400;
  color: var(--ink-soft);
  border: 1px solid var(--hairline);
  border-radius: 6px;
  padding: 1px 6px;
  background: rgba(255, 255, 255, 0.58);
}
.tick {
  /* 固定宽度：有勾和没勾的项，文字起始位置要一样 */
  width: 14px;
  flex: 0 0 14px;
  text-align: center;
  color: var(--primary);
  font-weight: 700;
}
.ctext {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 展开动画：轻微下滑淡入，呼应"下拉"的心理模型 */
.droplist-enter-active,
.droplist-leave-active {
  transition:
    opacity 0.14s ease,
    transform 0.14s ease;
}
.droplist-enter-from,
.droplist-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
.btn {
  border-radius: var(--radius-ctrl);
  padding: 8px 18px;
  font-size: 13px;
  border: 1px solid var(--hairline);
  background: rgba(255, 255, 255, 0.58);
  backdrop-filter: blur(8px);
  color: var(--ink-soft);
  transition: all 0.14s ease;
}
.btn.main {
  border: none;
  background: var(--primary);
  color: #fff;
}
.btn.main:hover {
  background: var(--primary-deep);
}
.btn.danger {
  border: none;
  background: var(--danger);
  color: #fff;
}
.btn.ghost:hover {
  border-color: var(--primary);
  color: var(--primary-deep);
}
/*
 * 禁用态要**看得出来是禁用的**（灰 + 不许点），
 * 而不是"一个点不动的蓝块"——后者会让用户以为界面坏了。
 * 配合 title 里那句人话（见 confirmHint），用户知道"要先选一个"。
 */
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn.main:disabled:hover {
  /* 禁用时悬停不变色，避免"看起来能点" */
  background: var(--primary);
}
.maskfade-enter-active,
.maskfade-leave-active {
  transition: opacity 0.16s ease;
}
.maskfade-enter-from,
.maskfade-leave-to {
  opacity: 0;
}
.dlgpop-enter-active {
  transition: transform 0.2s cubic-bezier(0.2, 0.9, 0.3, 1.15), opacity 0.18s ease;
}
.dlgpop-enter-from {
  transform: translateY(10px) scale(0.97);
  opacity: 0;
}
</style>
