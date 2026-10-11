<script setup lang="ts">
import type { Progress } from '../types/runtime-center'
defineProps<{ progress?: Progress; busy?: boolean; error?: string }>()
defineEmits<{ cancel: [] }>()
</script>
<template>
  <div v-if="progress || busy || error" class="python-download-progress" aria-live="polite">
    <p :role="error || progress?.phase === 'error' ? 'alert' : undefined">{{ error || progress?.error || progress?.label || (progress?.phase === 'done' ? 'Python 安装完成' : '正在准备 Python 下载…') }}</p>
    <template v-if="!error && progress?.phase !== 'error' && progress?.phase !== 'done'">
      <progress :value="progress?.phase === 'downloading' || progress?.phase === 'verify' ? progress?.percent ?? undefined : undefined" max="100" aria-label="Python 下载进度" />
      <span>{{ progress?.percent != null && ['downloading', 'verify'].includes(progress.phase) ? Math.round(progress.percent) + '%' : '处理中…' }} <template v-if="progress?.gotText"> · {{ progress.gotText }} · {{ progress.speedText }}</template></span>
    </template>
    <button v-if="busy" @click="$emit('cancel')">取消下载</button>
  </div>
</template>
<style scoped>
.python-download-progress { margin: 14px 0; padding: 14px; border: 1px solid var(--hairline); border-radius: 12px; background: var(--bg); }
p { margin: 0 0 7px; font-size: 13px; overflow-wrap: anywhere; }
progress { display: block; width: 100%; height: 8px; accent-color: var(--mint); margin: 9px 0; }
span { font-size: 12px; color: var(--ink-soft); }
[role=alert] { color: var(--danger); }
button { margin: 9px 0 0; padding: 6px 12px; border: 1px solid var(--hairline); border-radius: 8px; background: var(--glass-panel); color: var(--ink); }
</style>
