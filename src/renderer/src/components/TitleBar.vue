<script setup lang="ts">
/**
 * 融合式自定义标题栏
 * 无边框窗口的标题栏，支持拖拽和窗口控制
 */
import { ref, onMounted, onUnmounted } from 'vue'
import astriaxLogo from '../assets/astriax-logo.png'

const isMaximized = ref(false)

// 窗口控制 API
const windowApi = () => (window as any).desktop?.window

// 最小化
function minimize(): void {
  windowApi()?.minimize?.()
}

// 最大化/还原
async function toggleMaximize(): Promise<void> {
  const api = windowApi()
  if (!api?.toggleMaximize) return

  await api.toggleMaximize()
  isMaximized.value = await api.isMaximized?.() ?? false
}

// 关闭窗口
function close(): void {
  windowApi()?.close?.()
}

// 监听窗口状态变化
let unsubscribe: (() => void) | undefined

onMounted(async () => {
  const api = windowApi()
  if (api?.isMaximized) {
    isMaximized.value = await api.isMaximized()
  }

  // 订阅最大化状态变化
  if (api?.onMaximizeChange) {
    unsubscribe = api.onMaximizeChange((maximized: boolean) => {
      isMaximized.value = maximized
    })
  }
})

onUnmounted(() => {
  unsubscribe?.()
})
</script>

<template>
  <div class="titlebar">
    <!-- 可拖拽区域 -->
    <div class="titlebar__drag" data-tauri-drag-region>
      <img :src="astriaxLogo" alt="AstriaX" class="titlebar__logo" data-tauri-drag-region />
      <span class="titlebar__title" data-tauri-drag-region>AstriaX</span>
    </div>

    <!-- 窗口控制按钮（禁用拖拽） -->
    <div class="titlebar__controls">
      <button
        class="titlebar__btn titlebar__btn--minimize"
        @click="minimize"
        title="最小化"
      >
        <svg width="12" height="12" viewBox="0 0 12 12">
          <rect x="0" y="5" width="12" height="2" rx="1" />
        </svg>
      </button>

      <button
        class="titlebar__btn titlebar__btn--maximize"
        @click="toggleMaximize"
        :title="isMaximized ? '还原' : '最大化'"
      >
        <svg v-if="!isMaximized" width="12" height="12" viewBox="0 0 12 12">
          <rect x="1" y="1" width="10" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5" />
        </svg>
        <svg v-else width="12" height="12" viewBox="0 0 12 12">
          <path d="M3 1h7a1 1 0 011 1v7M1 5v6a1 1 0 001 1h6a1 1 0 001-1V5a1 1 0 00-1-1H2a1 1 0 00-1 1z" fill="none" stroke="currentColor" stroke-width="1.5" />
        </svg>
      </button>

      <button
        class="titlebar__btn titlebar__btn--close"
        @click="close"
        title="关闭"
      >
        <svg width="12" height="12" viewBox="0 0 12 12">
          <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.titlebar { flex: 0 0 44px; display: flex; align-items: center; height: 44px; background: var(--bg); user-select: none; position: relative; z-index: 100; }
.titlebar__drag { flex: 1; height: 100%; display: flex; align-items: center; gap: 10px; padding-left: 20px; -webkit-app-region: drag; }
.titlebar__logo { width: 20px; height: 20px; }
.titlebar__title { font-size: 13px; color: var(--ink-soft); }
.titlebar__controls { display: flex; height: 100%; -webkit-app-region: no-drag; }
.titlebar__btn { width: 46px; height: 100%; display: grid; place-items: center; border: 0; border-radius: 0; background: transparent; color: var(--ink); }
.titlebar__btn:hover { background: #e1e1e1; }
.titlebar__btn--close:hover { background: #c42b1c; color: #fff; }
.titlebar__btn svg { display: block; }
</style>
