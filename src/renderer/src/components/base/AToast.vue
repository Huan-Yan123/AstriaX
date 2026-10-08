<script setup lang="ts">
/**
 * Toast 通知组件 - 替换原生 alert/弹窗
 */
import { ref, computed, watch, onMounted } from 'vue'

export interface ToastProps {
  /** 通知类型 */
  type?: 'info' | 'success' | 'warning' | 'error'
  /** 通知内容 */
  message: string
  /** 持续时间（毫秒），0 = 不自动关闭 */
  duration?: number
  /** 是否显示 */
  visible?: boolean
}

const props = withDefaults(defineProps<ToastProps>(), {
  type: 'info',
  duration: 3000,
  visible: true
})

const emit = defineEmits<{
  close: []
}>()

const show = ref(props.visible)
let timer: ReturnType<typeof setTimeout> | undefined

const iconMap = {
  info: '💬',
  success: '✓',
  warning: '⚠',
  error: '✕'
}

const icon = computed(() => iconMap[props.type])

watch(() => props.visible, (val) => {
  show.value = val
  if (val && props.duration > 0) {
    clearTimeout(timer)
    timer = setTimeout(() => {
      show.value = false
      emit('close')
    }, props.duration)
  }
})

onMounted(() => {
  if (props.visible && props.duration > 0) {
    timer = setTimeout(() => {
      show.value = false
      emit('close')
    }, props.duration)
  }
})

function handleClose(): void {
  clearTimeout(timer)
  show.value = false
  emit('close')
}
</script>

<template>
  <Transition name="toast-fade">
    <div v-if="show" class="toast" :class="`toast--${type}`">
      <span class="toast__icon">{{ icon }}</span>
      <span class="toast__message">{{ message }}</span>
      <button class="toast__close" @click="handleClose">✕</button>
    </div>
  </Transition>
</template>

<style scoped>
.toast {
  position: fixed;
  top: 24px;
  right: 24px;
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 280px;
  max-width: 420px;
  padding: 14px 16px;
  background: var(--glass-panel);
  border: 1px solid var(--glass-edge);
  border-radius: var(--radius-card);
  box-shadow: 0 8px 24px rgba(19, 37, 70, 0.18);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}

.toast__icon {
  flex: none;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}

.toast__message {
  flex: 1;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink);
}

.toast__close {
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--ink-soft);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.14s ease;
}

.toast__close:hover {
  opacity: 1;
}

/* 类型变体 */
.toast--success {
  border-left: 3px solid var(--mint);
}
.toast--success .toast__icon {
  color: var(--mint);
}

.toast--warning {
  border-left: 3px solid #f59e0b;
}
.toast--warning .toast__icon {
  color: #f59e0b;
}

.toast--error {
  border-left: 3px solid var(--danger);
}
.toast--error .toast__icon {
  color: var(--danger);
}

.toast--info {
  border-left: 3px solid var(--primary);
}
.toast--info .toast__icon {
  color: var(--primary);
}

/* 动画 */
.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: all 0.24s ease;
}

.toast-fade-enter-from {
  opacity: 0;
  transform: translateX(100%);
}

.toast-fade-leave-to {
  opacity: 0;
  transform: translateX(100%) scale(0.96);
}
</style>
