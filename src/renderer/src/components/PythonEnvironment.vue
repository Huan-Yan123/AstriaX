<script setup lang="ts">
import { ref, watch } from 'vue'
import type { PythonStatus } from '../types/python'
const props = defineProps<{ status: PythonStatus | null; downloading: boolean }>()
const emit = defineEmits<{ changed: [status: PythonStatus]; download: [] }>()
const path = ref('')
const busy = ref(false)
const error = ref('')
const api = () => (window as unknown as { launcher?: { python?: {
  discover(): Promise<PythonStatus>
  select(path: string): Promise<PythonStatus>
  pickFile(): Promise<string | null>
} } }).launcher?.python
watch(() => props.status?.exe, value => { path.value = value ?? '' }, { immediate: true })
async function choose(action: 'discover' | 'browse' | 'select'): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const bridge = api()
    if (!bridge) throw new Error('桌面接口未连接')
    let result: PythonStatus
    if (action === 'discover') result = await bridge.discover()
    else {
      const chosen = action === 'browse' ? await bridge.pickFile() : path.value.trim()
      if (!chosen) return
      result = await bridge.select(chosen)
    }
    emit('changed', result)
    if (!result.ready) error.value = result.reason ?? '未找到可用的 Python 3.12+'
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { busy.value = false }
}
const labels = { system: '系统 Python', manual: '指定路径', bundled: '独立 Python', none: '未配置' }
</script>
<template>
  <div class="python-environment">
    <div class="python-heading">
      <div><h3>Python 解释器</h3><p>需要 64 位 Python 3.12 或更高版本及 pip。优先复用已有环境。</p></div>
      <span class="python-status" :class="{ ready: status?.ready }">{{ status?.ready ? `${labels[status.source ?? 'system']} · ${status.version}` : '需要配置' }}</span>
    </div>
    <label class="python-path"><span>解释器路径</span><div><input v-model="path" placeholder="例如 C:\Python312\python.exe" :disabled="busy || downloading" /><button :disabled="busy || downloading" @click="choose('browse')">浏览</button><button :disabled="!path.trim() || busy || downloading" @click="choose('select')">应用</button></div></label>
    <div class="python-actions"><button :disabled="busy || downloading" @click="choose('discover')">{{ busy ? '检测中…' : '重新检测系统 Python' }}</button><button :disabled="busy || downloading" @click="emit('download')">{{ downloading ? '下载中…' : '下载独立 Python' }}</button></div>
    <p v-if="error || (!status?.ready && status?.reason)" class="python-error" role="alert">{{ error || status?.reason }}</p>
    <p class="python-note">依赖安装在 AstrBot 运行时目录。更换 Python 主次版本后，需要重新安装相应 AstrBot 版本。</p>
  </div>
</template>
<style scoped src="../styles/PythonEnvironment.css"></style>
