<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import PythonDownloadProgress from './PythonDownloadProgress.vue'
import type { Progress } from '../types/runtime-center'
import type { PythonDownloadApi, PythonDownloadSourceState, PythonDownloadVersion, PythonSourceHealth, PythonDownloadRequest } from '../types/python'
defineProps<{ busy: boolean; progress?: Progress; installError?: string }>()
const emit = defineEmits<{ close: []; install: [request: PythonDownloadRequest]; cancel: [] }>()
const api = () => (window as unknown as { launcher?: { python?: PythonDownloadApi } }).launcher?.python
const state = ref<PythonDownloadSourceState>({ sources: [], pref: '' })
const selected = ref(''), version = ref('')
const versions = ref<PythonDownloadVersion[]>([])
const health = ref<PythonSourceHealth[]>([])
const loading = ref(false), testing = ref(false), saving = ref(false)
const error = ref(''), warning = ref(''), label = ref(''), base = ref(''), adding = ref(false)
let revision = 0
const recommended = computed(() => [...health.value].filter(h => h.successes > 0)
  .sort((a,b) => b.successes - a.successes || (a.ms ?? Infinity) - (b.ms ?? Infinity))[0])
function result(base: string): PythonSourceHealth | undefined { return health.value.find(h => h.base === base) }
async function loadVersions(force = false): Promise<void> {
  const current = ++revision
  loading.value = true; error.value = ''; warning.value = ''; versions.value = []; version.value = ''
  try {
    const bridge = api()
    if (!bridge) throw new Error('桌面接口未连接')
    const data = await bridge.versions({ base: selected.value, noCache: force })
    if (current !== revision) return
    versions.value = data.versions
    warning.value = data.warning ?? ''
    version.value = data.versions.find(v => v.version.startsWith('3.12.'))?.version ?? data.versions[0]?.version ?? ''
  } catch (e) { if (current === revision) error.value = e instanceof Error ? e.message : String(e) }
  finally { if (current === revision) loading.value = false }
}
async function selectSource(value: string): Promise<void> {
  saving.value = true; error.value = ''
  try {
    const bridge = api(); if (!bridge) throw new Error('桌面接口未连接')
    state.value = await bridge.sources.pref(value)
    selected.value = value
    await loadVersions()
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { saving.value = false }
}
async function testSources(): Promise<void> {
  testing.value = true; error.value = ''
  try { health.value = await api()!.sources.test() }
  catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { testing.value = false }
}
async function addSource(): Promise<void> {
  saving.value = true; error.value = ''
  try {
    state.value = await api()!.sources.add({ label: label.value.trim(), base: base.value.trim() })
    const created = state.value.sources.find(s => s.label === label.value.trim())
    label.value = ''; base.value = ''; adding.value = false
    if (created) await selectSource(created.base)
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { saving.value = false }
}
async function removeSource(base: string): Promise<void> {
  saving.value = true; error.value = ''
  try {
    state.value = await api()!.sources.remove(base)
    health.value = health.value.filter(h => h.base !== base)
    if (selected.value === base) { selected.value = state.value.pref; await loadVersions() }
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { saving.value = false }
}
onMounted(async () => {
  try {
    const bridge = api(); if (!bridge?.sources) throw new Error('桌面接口未连接')
    state.value = await bridge.sources.state(); selected.value = state.value.pref
    await loadVersions()
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
})
</script>
<template>
  <div class="python-download-mask" @click.self="emit('close')">
    <section class="python-download-dialog" role="dialog" aria-modal="true" aria-labelledby="python-download-title">
      <header><div><h2 id="python-download-title">下载独立 Python</h2><p>选择下载源与版本，安装独立的 Windows 64 位 Python 环境。</p></div><button class="close" aria-label="关闭 Python 下载窗口" @click="emit('close')">×</button></header>
      <div class="toolbar"><button :disabled="busy || testing || saving" @click="testSources">{{ testing ? '检测中…' : '测试所有下载源' }}</button><button :disabled="busy || saving" @click="adding = !adding">添加下载源</button><button v-if="recommended" :disabled="busy || saving || testing" @click="selectSource(recommended.base)">选择推荐源</button></div>
      <div class="python-sources">
        <div v-for="source in state.sources" :key="source.base" class="python-source" :class="{ selected: selected === source.base }">
          <label><input type="radio" name="python-source" :checked="selected === source.base" :disabled="busy || saving" @change="selectSource(source.base)" /><span><b>{{ source.label }}</b><small>{{ source.base }}</small></span></label>
          <span v-if="result(source.base)" class="health" :class="result(source.base)?.status">{{ result(source.base)?.successes }}/{{ result(source.base)?.attempts }} 成功<span v-if="result(source.base)?.ms != null"> · {{ result(source.base)?.ms }}ms</span></span>
          <button v-if="!source.builtin" :disabled="busy || saving || testing" @click="removeSource(source.base)">删除</button>
          <p v-if="result(source.base)?.reason" class="source-error">{{ result(source.base)?.reason }}</p>
        </div>
      </div>
      <form v-if="adding" class="add-source" @submit.prevent="addSource"><label>源名称<input v-model="label" placeholder="例如：我的 Python 镜像" :disabled="saving" /></label><label>Python 下载目录<input v-model="base" placeholder="https://mirrors.example.com/python/" :disabled="saving" /></label><p>地址应提供版本目录及对应的 Windows 64 位嵌入式 ZIP 包，与 Python 官方下载目录结构一致。</p><button :disabled="!label.trim() || !base.trim() || saving">{{ saving ? '保存中…' : '保存并选择' }}</button></form>
      <div class="version-select"><label>Python 版本<select v-model="version" :disabled="loading || busy || saving"><option value="">{{ loading ? '正在从源读取版本…' : '请选择版本' }}</option><option v-for="v in versions" :key="v.version" :value="v.version">{{ v.version }}{{ v.version.startsWith('3.12.') ? ' · 兼容优先' : '' }}</option></select></label><button :disabled="busy || loading || saving || !selected" @click="loadVersions(true)">刷新版本列表</button></div>
      <p class="hint">默认优先选择 3.12 系列。更换 Python 主次版本后，需要重新安装对应 AstrBot 版本及依赖。</p>
      <p v-if="warning" class="warning">{{ warning }}</p><p v-if="error" class="error" role="alert">{{ error }}</p>
      <PythonDownloadProgress :progress="progress" :busy="busy" :error="installError" @cancel="emit('cancel')" />
      <footer><span>{{ versions.length ? `源提供 ${versions.length} 个可下载版本` : '' }}</span><button class="primary" :disabled="busy || loading || saving || !version" @click="emit('install', { base: selected, version })">{{ busy ? '安装中…' : '下载并安装' }}</button></footer>
    </section>
  </div>
</template>
<style scoped>
.python-download-mask { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 25px; background: rgba(0,0,0,.28); backdrop-filter: blur(3px); }
.python-download-dialog { width: min(720px, 100%); max-height: 88vh; overflow-y: auto; background: var(--glass-panel); color: var(--ink); border: 1px solid var(--hairline); border-radius: 20px; padding: 24px; box-shadow: 0 18px 65px #0002; }
header, .toolbar, footer, .version-select { display: flex; gap: 10px; align-items: center; justify-content: space-between; }
h2 { margin: 0 0 7px; font-size: 20px; } p { font-size: 13px; line-height: 1.6; margin: 6px 0; overflow-wrap: anywhere; }
header p, .hint, footer span, small { color: var(--ink-soft); } .close { font-size: 24px; border: 0; }
button { background: var(--bg); border: 1px solid var(--hairline); color: var(--ink); padding: 8px 12px; border-radius: 9px; cursor: pointer; flex: none; }
button:disabled { opacity: .5; cursor: default; } button:hover:not(:disabled) { background: var(--primary-soft); }
.toolbar { margin: 18px 0 12px; justify-content: flex-start; flex-wrap: wrap; }
.python-source { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; border: 1px solid var(--hairline); border-radius: 11px; padding: 12px; margin: 8px 0; }
.python-source.selected { border-color: var(--mint); background: var(--primary-soft); }
.python-source label { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 220px; cursor: pointer; } b { font-size: 13px; } small { display: block; font-size: 11px; overflow-wrap: anywhere; }
input[type=radio] { accent-color: var(--mint); flex: none; } .health { font-size: 12px; } .health.ok { color: var(--mint); } .health.unstable, .warning { color: #a46e12; } .health.down, .source-error, .error { color: var(--danger); } .source-error { width: 100%; margin: 0; font-size: 12px; }
.add-source { border: 1px solid var(--hairline); padding: 14px; border-radius: 10px; margin: 12px 0; } .add-source input, select { display: block; margin-top: 5px; width: 100%; padding: 9px; border: 1px solid var(--hairline); border-radius: 8px; background: var(--glass-panel); color: var(--ink); box-sizing: border-box; }
.add-source label { display: block; font-size: 13px; margin-bottom: 10px; } .version-select { margin: 18px 0 8px; align-items: flex-end; } .version-select label { flex: 1; font-size: 13px; } footer { margin-top: 18px; font-size: 12px; } .primary { background: var(--mint); color: #fff; border-color: var(--mint); }
</style>
