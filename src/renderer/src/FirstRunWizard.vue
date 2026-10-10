<script setup lang="ts">
import { ref, onMounted } from 'vue'

const emit = defineEmits<{ confirm: [dataRoot: string] }>()

const appDataRoot = ref('')
const err = ref('')
const busy = ref(false)

declare const window: {
  launcher?: { paths?: { defaults: () => Promise<{ homeDataRoot: string; appDataRoot: string }> } }
}


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

<style scoped src="./styles/FirstRunWizard.css"></style>
