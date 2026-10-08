<script setup lang="ts">
import { ref, onMounted } from 'vue'

const emit = defineEmits<{ confirm: [dataRoot: string] }>()

const appDataRoot = ref('')
const err = ref('')
const busy = ref(false)

declare const window: {
  launcher?: { paths?: { defaults: () => Promise<{ homeDataRoot: string; appDataRoot: string }> } }
}

/**
 * 拿默认数据目录。
 *
 * 这里原来**没有 try/catch**，而且失败后 appDataRoot 保持空字符串、
 * 按钮点了什么都不发生（confirm 里 if (appDataRoot) 直接 return，
 * 既不报错也不转圈）。后果不是「难看」而是**彻底锁死**：
 * App.vue 里解除这个向导的唯一开关是 finishFirstRun，
 * 而它只能由本组件的 confirm 触发 —— 首启用户会看到一屏遮罩，
 * 侧栏、设置、下载页全被挡住，什么都做不了。
 * 所以失败必须**看得见**，并且要能重试。
 *
 * ## 这个弹窗现在改成著作声明了，为什么这段逻辑一个字都不能动
 *
 * 展示内容换成了「谁开发的、免不免费」，但它**顺带承担的那个职责没变**：
 * 首启时把数据目录定下来（emit confirm → App.vue 的 finishFirstRun →
 * config.set({dataRoot}) → firstRun 置 false）。
 *
 * 也就是说：这一段是**解除全屏遮罩的唯一通路**。文案怎么改都行，
 * 「失败要可见 + 要能重试 + 没拿到路径不许 emit」这三条必须原样留着，
 * 否则首启用户会卡在一屏点不动的遮罩上，连设置都进不去。
 */
async function loadDefault(): Promise<void> {
  err.value = ''
  busy.value = true
  try {
    const p = await window.launcher?.paths?.defaults()
    appDataRoot.value = p?.appDataRoot ?? ''
    if (!appDataRoot.value) {
      err.value = '没取到默认的数据目录，请点「重试」，或先确认程序目录可写。'
    }
  } catch (e) {
    appDataRoot.value = ''
    err.value = `读取默认数据目录失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = false
  }
}

onMounted(loadDefault)

function confirm(): void {
  // 拿不到路径就明确说清楚，而不是静默无反应（那会让人以为按钮坏了）
  if (!appDataRoot.value) {
    err.value = '还没拿到有效的数据目录，没法继续。请点「重试」。'
    return
  }
  emit('confirm', appDataRoot.value)
}
</script>

<template>
  <div class="mask">
    <div class="dlg">
      <div class="brand">
        <span class="mark">AstriaX</span>
        <span class="sub">NapCat + AstrBot 多开管理器</span>
      </div>

      <h2>著作声明</h2>

      <div class="body">
        <p>这个小家伙，是 B站 UP 主「梦见月下汐」一个人捣鼓出来的。</p>
        <p>
          它是<strong>完全免费的公益软件</strong> —— 不收钱、没有广告、没有内购，
          也没有任何需要额外解锁的功能，装好就是完整的样子。
        </p>
        <p class="warn">
          要是有谁收过你的钱，那一定是被人倒卖了。请去找他退款，
          也顺手提醒一下后来的人，别让他们再踩一次。
        </p>
      </div>

      <p class="sig">—— 梦见月下汐 · B站</p>

      <!--
        数据目录这一行保留：它是用户数据实际落地的位置，属于有用信息。
        但降级成脚注，不再是这个弹窗的主角（主角是上面的声明）。
      -->
      <p class="path">数据目录：{{ appDataRoot || (busy ? '读取中…' : '（未取到）') }}</p>

      <p v-if="err" class="err">{{ err }}</p>

      <div class="btns">
        <button v-if="!appDataRoot" class="retry" type="button" :disabled="busy" @click="loadDefault">
          重试
        </button>
        <button class="main" :disabled="!appDataRoot || busy" @click="confirm">
          我知道了
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(24, 39, 65, 0.25);
  -webkit-backdrop-filter: blur(10px) saturate(125%);
  backdrop-filter: blur(10px) saturate(125%);
  display: flex;
  align-items: center;
  justify-content: center;
}
.dlg {
  position: relative;
  isolation: isolate;
  width: 430px;
  max-width: calc(100vw - 36px);
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.86), rgba(242, 247, 255, 0.72));
  border: 1px solid var(--glass-edge);
  border-radius: 20px;
  padding: 26px 28px 22px;
  -webkit-backdrop-filter: blur(28px) saturate(160%);
  backdrop-filter: blur(28px) saturate(160%);
  box-shadow: 0 24px 64px rgba(19, 37, 70, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.9);
  overflow: hidden;
}
/*
 * 右上角一团很淡的主色调光晕，给声明页一点「封面感」。
 * 用 radial-gradient 而不是贴图：不额外引入资源，也不受打包路径影响。
 * 强度压得很低（0.10 → 透明），避免变成「一眼 AI 味」的渐变卡片。
 */
.dlg::before {
  content: '';
  position: absolute;
  top: -70px;
  right: -50px;
  width: 190px;
  height: 190px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--primary-soft) 0%, rgba(255, 255, 255, 0) 70%);
  opacity: 0.9;
  pointer-events: none;
}
.brand {
  position: relative;
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 18px;
}
.mark {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--primary-deep);
}
.sub {
  font-size: 11.5px;
  color: var(--ink-soft);
}
h2 {
  position: relative;
  margin: 0 0 12px;
  font-size: 19px;
  letter-spacing: 0.01em;
}
.body {
  position: relative;
}
.body p {
  margin: 0 0 10px;
  font-size: 13px;
  line-height: 1.75;
  color: var(--ink-soft);
}
.body strong {
  color: var(--ink);
  font-weight: 600;
}
/*
 * 「被人倒卖」那段要有分量，但不能用报错的红色 ——
 * 红色在这个软件里已经专属给「出错了」，拿来做普通强调会误导。
 * 改成左侧一道主色竖线：既突出，又和错误态区分开。
 */
.warn {
  border-left: 2px solid var(--primary);
  padding-left: 10px;
  color: var(--ink);
}
.sig {
  position: relative;
  margin: 14px 0 0;
  font-size: 12.5px;
  color: var(--ink-soft);
  text-align: right;
}
.path {
  position: relative;
  margin: 16px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--hairline);
  font-size: 12px;
  color: var(--ink-soft);
  word-break: break-all;
}
.err {
  position: relative;
  margin: 10px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ribbon-error);
}
.btns {
  position: relative;
  display: flex;
  gap: 10px;
  margin-top: 16px;
}
.main {
  flex: 1;
  border: none;
  border-radius: var(--radius-ctrl);
  background: var(--primary);
  color: #fff;
  padding: 12px 0;
  font-size: 14px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
}
/* 拿不到路径时按钮是灰的：让人一眼看出「现在点不了」而不是「点了没用」 */
.main:disabled {
  background: var(--hairline);
  color: var(--ink-soft);
  cursor: not-allowed;
  transform: none;
}
.main:active:not(:disabled) {
  transform: scale(0.98);
}
.retry {
  border: 1px solid var(--hairline);
  border-radius: var(--radius-ctrl);
  background: rgba(255, 255, 255, 0.58);
  backdrop-filter: blur(8px);
  color: var(--ink);
  padding: 12px 18px;
  font-size: 13.5px;
  font-family: inherit;
  cursor: pointer;
}
.retry:disabled {
  color: var(--ink-soft);
  cursor: not-allowed;
}
</style>
