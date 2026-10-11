<script setup lang="ts">
import { ref, onMounted } from 'vue'
import AppIcon from './AppIcon.vue'
defineEmits<{ saved: [] }>()
const mode = ref('system')
const address = ref('')
const busy = ref(false)
const error = ref('')
const saved = ref(false)
const config = () => (window as unknown as { launcher?: { config?: { get(): Promise<Record<string, unknown>>; set(value: unknown): Promise<unknown> } } }).launcher?.config
onMounted(async () => {
  try { const value = await config()?.get(); mode.value = String(value?.proxyMode || 'system'); address.value = String(value?.proxyUrl || '') }
  catch (e) { error.value = e instanceof Error ? e.message : String(e) }
})
async function save(): Promise<boolean> {
  busy.value = true; error.value = ''; saved.value = false
  try {
    if (mode.value === 'manual' && !address.value.trim()) throw new Error('请填写代理地址与端口，例如 http://127.0.0.1:7890')
    if (!config()) throw new Error('桌面配置接口不可用')
    await config()!.set({ proxyMode: mode.value, proxyUrl: address.value.trim() })
    saved.value = true
    return true
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); return false }
  finally { busy.value = false }
}
</script>
<template>
  <section class="network-proxy">
    <div class="proxy-heading"><AppIcon name="network" /><h2>网络代理</h2></div>
    <p>源检测、版本查询与资源下载使用同一代理。跟随系统会读取 Windows 系统代理与代理环境变量。</p>
    <div class="proxy-form">
      <label>连接方式<select v-model="mode" :disabled="busy" @change="saved = false"><option value="system">跟随系统代理</option><option value="direct">直接连接</option><option value="manual">手动指定代理</option></select></label>
      <label v-if="mode === 'manual'" class="proxy-address">HTTP / HTTPS 代理地址<input v-model="address" :disabled="busy" placeholder="http://127.0.0.1:7890" @input="saved = false" @keydown.enter="async () => { if (await save()) $emit('saved') }" /></label>
      <button :disabled="busy" @click="async () => { if (await save()) $emit('saved') }">{{ busy ? '保存中…' : '保存并重新检测' }}</button>
    </div>
    <p v-if="mode === 'manual'">填写代理工具的 HTTP 或混合端口；端口以工具中的设置为准。</p>
    <p v-if="error" class="proxy-error" role="alert">{{ error }}</p>
    <p v-else-if="saved" role="status">代理设置已保存，新请求立即生效。</p>
  </section>
</template>
<style scoped>
.network-proxy { margin: 24px 0; padding: 20px; border: 1px solid var(--hairline); border-radius: 14px; }
.proxy-heading, .proxy-form { display: flex; align-items: center; gap: 12px; }
h2 { margin: 0; font-size: 17px; }
p { color: var(--ink-soft); font-size: 13px; line-height: 1.6; }
.proxy-form { align-items: flex-end; flex-wrap: wrap; }
label { display: grid; gap: 7px; font-size: 13px; }
.proxy-address { flex: 1; min-width: 240px; }
select, input { min-height: 38px; }
button { min-height: 38px; border: 1px solid var(--hairline); border-radius: 9px; background: #fff; padding: 8px 12px; }
.proxy-error { color: var(--danger); overflow-wrap: anywhere; }
</style>
